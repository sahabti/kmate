// Package tunnel maintains the agent's outbound connection to the hub.
package tunnel

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"strings"
	"sync/atomic"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/discovery"
	"github.com/kmate-dev/kmate/internal/agent/handlers"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"github.com/kmate-dev/kmate/internal/mux"
	"github.com/kmate-dev/kmate/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

const heartbeatEvery = 15 * time.Second

// Config for the tunnel client.
type Config struct {
	HubAddr         string
	EnrollmentToken string
	Insecure        bool
	CAFile          string
	Capabilities    []string
}

// Client is the tunnel client.
type Client struct {
	cfg      Config
	log      *slog.Logger
	clients  *kube.Clients
	handler  *handlers.Handler
	catalog  *discovery.Builder
	store    IdentityStore
	identity *Identity

	connected atomic.Bool
}

// New creates a tunnel client.
func New(cfg Config, clients *kube.Clients, h *handlers.Handler, catalog *discovery.Builder, store IdentityStore, log *slog.Logger) *Client {
	return &Client{cfg: cfg, clients: clients, handler: h, catalog: catalog, store: store, log: log}
}

// Connected reports whether the tunnel is currently established.
func (c *Client) Connected() bool { return c.connected.Load() }

// Run keeps the tunnel alive until ctx is done.
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		err := c.runOnce(ctx)
		c.connected.Store(false)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		jitter := time.Duration(rand.Int64N(int64(backoff / 2)))
		wait := backoff + jitter
		c.log.Warn("tunnel disconnected; reconnecting", "err", err, "in", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
		backoff *= 2
		if backoff > 60*time.Second {
			backoff = 60 * time.Second
		}
		if _, ok := err.(resetBackoff); ok {
			backoff = time.Second
		}
	}
}

type resetBackoff struct{ error }

func (c *Client) dial(ctx context.Context) (*grpc.ClientConn, error) {
	var creds credentials.TransportCredentials
	if c.cfg.Insecure {
		creds = insecure.NewCredentials()
	} else {
		tc := &tls.Config{MinVersion: tls.VersionTLS12}
		if c.cfg.CAFile != "" {
			pem, err := os.ReadFile(c.cfg.CAFile)
			if err != nil {
				return nil, fmt.Errorf("read CA: %w", err)
			}
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(pem)
			tc.RootCAs = pool
		} else if c.identity != nil && len(c.identity.CAPEM) > 0 {
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(c.identity.CAPEM)
			tc.RootCAs = pool
		}
		if c.identity != nil && len(c.identity.CertPEM) > 0 && len(c.identity.KeyPEM) > 0 {
			cert, err := tls.X509KeyPair(c.identity.CertPEM, c.identity.KeyPEM)
			if err == nil {
				tc.Certificates = []tls.Certificate{cert}
			} else {
				c.log.Warn("stored agent certificate invalid; continuing without mTLS", "err", err)
			}
		}
		creds = credentials.NewTLS(tc)
	}
	return grpc.NewClient(c.cfg.HubAddr,
		grpc.WithTransportCredentials(creds),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 30 * time.Second, Timeout: 10 * time.Second, PermitWithoutStream: true}),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64<<20), grpc.MaxCallSendMsgSize(64<<20)),
	)
}

func (c *Client) runOnce(ctx context.Context) error {
	if c.identity == nil {
		id, err := c.store.Load(ctx)
		if err != nil {
			return err
		}
		c.identity = id
	}
	conn, err := c.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	svc := kmatev1.NewAgentServiceClient(conn)

	if c.identity == nil {
		if c.cfg.EnrollmentToken == "" {
			return errors.New("no stored identity and KMATE_ENROLLMENT_TOKEN is empty")
		}
		c.log.Info("enrolling with hub", "hub", c.cfg.HubAddr)
		ectx, cancel := context.WithTimeout(ctx, 30*time.Second)
		resp, err := svc.Enroll(ectx, &kmatev1.EnrollRequest{
			EnrollmentToken: c.cfg.EnrollmentToken,
			ClusterInfo:     c.clients.ClusterInfo(ectx, c.catalogVersion()),
		})
		cancel()
		if err != nil {
			return fmt.Errorf("enroll: %w", err)
		}
		c.identity = &Identity{AgentID: resp.AgentId, ClusterID: resp.ClusterId, AgentToken: resp.AgentToken, CertPEM: resp.CertPem, KeyPEM: resp.KeyPem, CAPEM: resp.CaPem}
		if err := c.store.Save(ctx, c.identity); err != nil {
			c.log.Warn("saving identity failed", "err", err)
		}
		c.log.Info("enrolled", "agent_id", resp.AgentId, "cluster_id", resp.ClusterId)
		if len(resp.CertPem) > 0 && !c.cfg.Insecure {
			// redial with the client certificate
			conn.Close()
			conn, err = c.dial(ctx)
			if err != nil {
				return err
			}
			defer conn.Close()
			svc = kmatev1.NewAgentServiceClient(conn)
		}
	}

	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := svc.Tunnel(sctx)
	if err != nil {
		return fmt.Errorf("open tunnel: %w", err)
	}
	sess := mux.New(stream, mux.Responder)
	hello := &kmatev1.Hello{
		AgentId:      c.identity.AgentID,
		AgentToken:   c.identity.AgentToken,
		Version:      version.Version,
		Capabilities: c.cfg.Capabilities,
		ClusterInfo:  c.clients.ClusterInfo(sctx, c.catalogVersion()),
	}
	if err := sess.SendControl(&kmatev1.Frame{Payload: &kmatev1.Frame_Hello{Hello: hello}}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}
	c.connected.Store(true)
	c.log.Info("tunnel established", "hub", c.cfg.HubAddr, "agent_id", c.identity.AgentID)
	connectedAt := time.Now()

	go c.heartbeat(sctx, sess)
	go c.pushCatalog(sctx, sess)
	go c.controlLoop(sctx, sess)
	go c.acceptLoop(sctx, sess)

	err = sess.Run(sctx)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if time.Since(connectedAt) > time.Minute {
		return resetBackoff{err}
	}
	if isUnauthenticated(err) {
		// identity rejected: forget it so we re-enroll if a token is available
		c.log.Warn("hub rejected agent identity; will re-enroll if a token is configured")
		c.identity = nil
		if d, ok := c.store.(Deleter); ok {
			if derr := d.Delete(context.Background()); derr != nil {
				c.log.Warn("could not delete stored identity", "err", derr)
			}
		}
	}
	return err
}

func isUnauthenticated(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	return strings.Contains(s, "Unauthenticated") || strings.Contains(s, "PermissionDenied")
}

func (c *Client) catalogVersion() int64 {
	if c.catalog == nil {
		return 0
	}
	return c.catalog.Version()
}

func (c *Client) heartbeat(ctx context.Context, sess *mux.Session) {
	t := time.NewTicker(heartbeatEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case <-t.C:
			info := c.clients.ClusterInfo(ctx, c.catalogVersion())
			if err := sess.SendControl(&kmatev1.Frame{Payload: &kmatev1.Frame_Heartbeat{Heartbeat: &kmatev1.Heartbeat{ClusterInfo: info}}}); err != nil {
				return
			}
		}
	}
}

func (c *Client) controlLoop(ctx context.Context, sess *mux.Session) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case f := <-sess.Control():
			switch p := f.Payload.(type) {
			case *kmatev1.Frame_Close:
				c.log.Warn("hub closed tunnel", "err", mux.CloseError(f))
				sess.Close()
				return
			case *kmatev1.Frame_Heartbeat:
				_ = p
			}
		}
	}
}

func (c *Client) pushCatalog(ctx context.Context, sess *mux.Session) {
	if c.catalog == nil {
		return
	}
	send := func(cat *kmatev1.Catalog) {
		st, err := sess.Open()
		if err != nil {
			return
		}
		if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Catalog{Catalog: &kmatev1.CatalogSnapshot{Catalog: cat}}}); err != nil {
			return
		}
		_ = st.Close(nil)
	}
	if err := c.catalog.WaitSynced(ctx); err != nil {
		return
	}
	send(c.catalog.Current())
	ch, unsub := c.catalog.Subscribe()
	defer unsub()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sess.Done():
			return
		case cat := <-ch:
			send(cat)
		}
	}
}

func (c *Client) acceptLoop(ctx context.Context, sess *mux.Session) {
	for {
		st, err := sess.Accept(ctx)
		if err != nil {
			return
		}
		go func(st *mux.Stream) {
			rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			f, err := st.Recv(rctx)
			cancel()
			if err != nil {
				_ = st.Close(&kmatev1.Error{Code: 400, Message: "no request frame"})
				return
			}
			req := f.GetRequest()
			if req == nil {
				_ = st.Close(&kmatev1.Error{Code: 400, Message: "first frame must be a Request"})
				return
			}
			c.handler.Dispatch(ctx, st, req)
		}(st)
	}
}
