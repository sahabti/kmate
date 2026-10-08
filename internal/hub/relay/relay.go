// Package relay implements the agent-facing gRPC AgentService and the helpers
// that route client requests over an agent's mux session.
package relay

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	grpcpeer "google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/ca"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

const (
	heartbeatTimeout = 45 * time.Second
	enrollmentTTL    = 24 * time.Hour
)

// ErrClusterOffline is returned when no agent is connected for a cluster.
var ErrClusterOffline = errors.New("cluster is offline (no agent connected)")

// MTLSMode controls how strictly the agent listener treats client certificates.
type MTLSMode string

const (
	// MTLSOff ignores client certificates entirely; agents authenticate with
	// their bearer token only.
	MTLSOff MTLSMode = "off"
	// MTLSOptional verifies a certificate when one is presented and falls back
	// to the bearer token otherwise. This is the default so that agents
	// deployed before mTLS existed keep connecting while they rotate.
	MTLSOptional MTLSMode = "optional"
	// MTLSRequired refuses any agent that does not present a valid certificate.
	MTLSRequired MTLSMode = "required"
)

// ParseMTLSMode maps configuration text onto a mode, defaulting to optional.
func ParseMTLSMode(s string) MTLSMode {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "off", "none", "false":
		return MTLSOff
	case "required", "require", "strict":
		return MTLSRequired
	default:
		return MTLSOptional
	}
}

// Relay is the AgentService server plus routing helpers.
type Relay struct {
	kmatev1.UnimplementedAgentServiceServer

	store *store.Store
	reg   *registry.Registry
	log   *slog.Logger
	ca    *ca.CA
	mtls  MTLSMode

	openStreams atomic.Int64
}

// New creates a relay. A nil CA disables certificate issuance, which keeps the
// bearer-token path working for deployments that have not enabled mTLS.
func New(st *store.Store, reg *registry.Registry, log *slog.Logger) *Relay {
	return &Relay{store: st, reg: reg, log: log, mtls: MTLSOptional}
}

// WithCA attaches the hub's certificate authority and the enforcement mode.
func (r *Relay) WithCA(authority *ca.CA, mode MTLSMode) *Relay {
	r.ca = authority
	r.mtls = mode
	return r
}

// MTLSMode reports the configured enforcement mode.
func (r *Relay) MTLSMode() MTLSMode { return r.mtls }

// OpenStreams returns the number of live relayed streams (metrics).
func (r *Relay) OpenStreams() int64 { return r.openStreams.Load() }

// Registry exposes the agent registry (live cluster state, broadcasters).
func (r *Relay) Registry() *registry.Registry { return r.reg }

// Enroll exchanges an enrollment token for an agent identity.
func (r *Relay) Enroll(ctx context.Context, req *kmatev1.EnrollRequest) (*kmatev1.EnrollResponse, error) {
	clusterID, err := r.store.ConsumeEnrollmentToken(ctx, req.GetEnrollmentToken())
	if errors.Is(err, store.ErrTokenUsed) {
		r.log.Warn("enrollment refused: token already used", "cluster", req.GetClusterInfo().GetName())
		return nil, status.Error(codes.PermissionDenied,
			"enrollment token has already been used; tokens are single use, ask an administrator to issue a new one for this cluster")
	}
	if errors.Is(err, store.ErrTokenInvalid) {
		return nil, status.Error(codes.PermissionDenied, "enrollment token invalid or expired")
	}
	if err != nil {
		return nil, status.Errorf(codes.Internal, "enroll: %v", err)
	}
	agentToken := store.RandomToken("kmt_agt_")
	if err := r.store.SetAgentToken(ctx, clusterID, agentToken); err != nil {
		return nil, status.Errorf(codes.Internal, "enroll: %v", err)
	}
	if info := req.GetClusterInfo(); info != nil {
		_ = r.store.UpdateClusterStatus(ctx, clusterID, store.StatusOffline, info, nil, nil)
	}
	agentID := uuid.NewString()
	r.log.Info("agent enrolled", "cluster_id", clusterID, "agent_id", agentID, "cluster", req.GetClusterInfo().GetName())

	resp := &kmatev1.EnrollResponse{
		AgentId:    agentID,
		ClusterId:  clusterID,
		AgentToken: agentToken,
	}
	// The bearer token above stays in the response so an agent can still reach a
	// hub running with mTLS off, and so a certificate can be reissued later over
	// the tunnel without a fresh enrolment token.
	if err := r.issueCert(ctx, resp, req.GetCsrPem(), clusterID, agentID); err != nil {
		// Certificate issuance is best effort during enrolment: an agent that
		// cannot get one still connects on its token while mode is optional.
		r.log.Warn("issuing agent certificate failed", "cluster_id", clusterID, "err", err)
	}
	return resp, nil
}

// issueCert fills cert/ca PEM on an enrolment response. When the agent supplied
// a CSR its private key never leaves it; otherwise the hub generates the key and
// returns it, which is the weaker path kept for simple deployments.
func (r *Relay) issueCert(ctx context.Context, resp *kmatev1.EnrollResponse, csrPEM []byte, clusterID, agentID string) error {
	if r.ca == nil || r.mtls == MTLSOff {
		return nil
	}
	var certPEM, keyPEM []byte
	var err error
	if len(csrPEM) > 0 {
		certPEM, err = r.ca.SignCSR(csrPEM, clusterID, agentID)
	} else {
		certPEM, keyPEM, err = r.ca.IssueWithGeneratedKey(clusterID, agentID)
	}
	if err != nil {
		return err
	}
	resp.CertPem = certPEM
	resp.KeyPem = keyPEM
	resp.CaPem = r.ca.CertPEM()
	r.recordCert(ctx, clusterID, certPEM)
	return nil
}

// recordCert notes the serial and expiry so the hub can report on certificates
// that are close to running out.
func (r *Relay) recordCert(ctx context.Context, clusterID string, certPEM []byte) {
	b, _ := pem.Decode(certPEM)
	if b == nil {
		return
	}
	crt, err := x509.ParseCertificate(b.Bytes)
	if err != nil {
		return
	}
	if err := r.store.SetAgentCert(ctx, clusterID, crt.SerialNumber.String(), crt.NotAfter); err != nil {
		r.log.Warn("recording agent certificate failed", "cluster_id", clusterID, "err", err)
	}
}

// Tunnel handles one agent connection for its lifetime.
func (r *Relay) Tunnel(stream grpc.BidiStreamingServer[kmatev1.Frame, kmatev1.Frame]) error {
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	sess := mux.New(stream, mux.Initiator)
	runErr := make(chan error, 1)
	go func() { runErr <- sess.Run(ctx) }()

	// First frame must be Hello.
	var hello *kmatev1.Hello
	select {
	case f := <-sess.Control():
		hello = f.GetHello()
	case err := <-runErr:
		return err
	case <-time.After(10 * time.Second):
		return status.Error(codes.DeadlineExceeded, "no Hello received")
	}
	if hello == nil {
		return status.Error(codes.InvalidArgument, "first frame must be Hello")
	}

	peer, hasCert := peerIdentity(stream.Context())
	cluster, err := r.authenticateAgent(ctx, hello, peer, hasCert)
	if err != nil {
		r.log.Warn("agent hello rejected", "err", err, "mtls", hasCert)
		return err
	}

	conn := &registry.AgentConn{
		ClusterID:    cluster.ID,
		AgentID:      hello.GetAgentId(),
		Session:      sess,
		Capabilities: hello.GetCapabilities(),
		ConnectedAt:  time.Now(),
	}
	conn.Touch(hello.GetClusterInfo())
	if prev := r.reg.Register(conn); prev != nil {
		// A rolling restart and a hijack look identical from here, so make the
		// displacement visible rather than silent: an operator comparing this
		// against their own deploys can tell the difference.
		r.log.Warn("agent replaced an existing session for this cluster",
			"cluster_id", cluster.ID, "cluster", cluster.Name,
			"new_agent_id", conn.AgentID, "previous_agent_id", prev.AgentID,
			"previous_connected_at", prev.ConnectedAt.UTC().Format(time.RFC3339))
		_ = r.store.Audit(ctx, store.AuditEvent{
			User:      "agent:" + conn.AgentID,
			ClusterID: cluster.ID,
			Action:    "agent.replaced",
			Target:    cluster.Name,
			Result:    "previous agent " + prev.AgentID + " disconnected",
		})
		prev.Session.Close()
	}
	now := time.Now().UTC()
	_ = r.store.UpdateClusterStatus(ctx, cluster.ID, store.StatusOnline, hello.GetClusterInfo(), hello.GetCapabilities(), &now)
	r.publishCluster(ctx, cluster.ID, "MODIFIED")
	r.log.Info("agent online", "cluster_id", cluster.ID, "cluster", cluster.Name, "agent_id", hello.GetAgentId(), "version", hello.GetVersion())

	defer func() {
		if r.reg.Unregister(conn) {
			bg := context.Background()
			_ = r.store.UpdateClusterStatus(bg, cluster.ID, store.StatusOffline, nil, nil, nil)
			r.publishCluster(bg, cluster.ID, "MODIFIED")
			r.log.Info("agent offline", "cluster_id", cluster.ID)
		}
	}()

	go r.acceptLoop(ctx, conn)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case f := <-sess.Control():
			if hb := f.GetHeartbeat(); hb != nil {
				conn.Touch(hb.GetClusterInfo())
				now := time.Now().UTC()
				_ = r.store.UpdateClusterStatus(ctx, cluster.ID, store.StatusOnline, hb.GetClusterInfo(), nil, &now)
				r.publishCluster(ctx, cluster.ID, "MODIFIED")
			}
		case <-ticker.C:
			if time.Since(conn.LastHeartbeat()) > heartbeatTimeout {
				r.log.Warn("agent heartbeat timeout", "cluster_id", cluster.ID)
				sess.Close()
				return status.Error(codes.DeadlineExceeded, "heartbeat timeout")
			}
		case err := <-runErr:
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		case <-ctx.Done():
			return nil
		}
	}
}

// authenticateAgent decides which cluster is on the other end of a tunnel.
//
// A verified client certificate is the stronger claim and wins: it was issued by
// this hub to one cluster, so the agent cannot assert a different one in its
// Hello. Without a certificate the agent falls back to its bearer token, which
// is refused outright when mTLS is required.
func (r *Relay) authenticateAgent(ctx context.Context, hello *kmatev1.Hello, peer ca.Identity, hasCert bool) (*store.Cluster, error) {
	if hasCert {
		cluster, err := r.store.GetCluster(ctx, peer.ClusterID)
		if errors.Is(err, store.ErrNotFound) {
			return nil, status.Error(codes.Unauthenticated, "certificate names an unknown cluster; re-enroll")
		}
		if err != nil {
			return nil, status.Errorf(codes.Internal, "%v", err)
		}
		// A certificate for cluster A must not be used to serve cluster B.
		if cid := hello.GetClusterId(); cid != "" && cid != peer.ClusterID {
			return nil, status.Error(codes.PermissionDenied, "certificate does not match the cluster in Hello")
		}
		return cluster, nil
	}
	if r.mtls == MTLSRequired {
		return nil, status.Error(codes.Unauthenticated, "this hub requires agent mTLS; re-enroll to obtain a certificate")
	}
	if hello.GetAgentToken() == "" {
		return nil, status.Error(codes.Unauthenticated, "missing agent token")
	}
	clusters, err := r.store.ListClusters(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "%v", err)
	}
	h := store.HashToken(hello.GetAgentToken())
	for _, c := range clusters {
		if c.AgentTokenHash != "" && c.AgentTokenHash == h {
			return c, nil
		}
	}
	return nil, status.Error(codes.Unauthenticated, "unknown agent token; re-enroll")
}

// peerIdentity reads the agent identity out of a verified client certificate.
// Returns false when the connection carried none, which is the normal case for
// an agent that predates mTLS or a hub running in insecure mode.
func peerIdentity(ctx context.Context) (ca.Identity, bool) {
	p, ok := grpcpeer.FromContext(ctx)
	if !ok || p.AuthInfo == nil {
		return ca.Identity{}, false
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok {
		return ca.Identity{}, false
	}
	// VerifiedChains is only populated when the listener verified the chain
	// against the hub CA, so anything here has already been checked.
	for _, chain := range tlsInfo.State.VerifiedChains {
		if len(chain) == 0 {
			continue
		}
		if id, ok := ca.IdentityFromCert(chain[0]); ok {
			return id, true
		}
	}
	return ca.Identity{}, false
}

// acceptLoop handles agent-initiated streams (catalog snapshots).
func (r *Relay) acceptLoop(ctx context.Context, conn *registry.AgentConn) {
	for {
		st, err := conn.Session.Accept(ctx)
		if err != nil {
			return
		}
		go r.handleAgentStream(ctx, conn, st)
	}
}

func (r *Relay) handleAgentStream(ctx context.Context, conn *registry.AgentConn, st *mux.Stream) {
	defer st.Close(nil)
	for {
		f, err := st.Recv(ctx)
		if err != nil {
			return
		}
		switch p := f.Payload.(type) {
		case *kmatev1.Frame_Catalog:
			cat := p.Catalog.GetCatalog()
			if cat == nil {
				continue
			}
			if err := r.store.SaveCatalog(ctx, conn.ClusterID, cat); err != nil {
				r.log.Error("save catalog", "cluster_id", conn.ClusterID, "err", err)
			}
			r.reg.Catalog(conn.ClusterID).Publish(cat)
			r.log.Debug("catalog snapshot", "cluster_id", conn.ClusterID, "version", cat.GetVersion(), "entries", len(cat.GetEntries()))
		case *kmatev1.Frame_CertRenewal:
			r.handleRenewal(ctx, conn, st, p.CertRenewal)
			return
		case *kmatev1.Frame_Close:
			return
		default:
			r.log.Warn("unexpected agent-initiated frame", "cluster_id", conn.ClusterID, "type", fmt.Sprintf("%T", p))
		}
	}
}

// handleRenewal signs a fresh certificate for an agent already authenticated on
// this tunnel. Because the connection is established and attributed to a
// cluster, no enrolment token is needed: an agent can rotate indefinitely
// without anyone re-running an install.
func (r *Relay) handleRenewal(ctx context.Context, conn *registry.AgentConn, st *mux.Stream, req *kmatev1.CertRenewalRequest) {
	reply := &kmatev1.CertRenewalResponse{}
	switch {
	case r.ca == nil || r.mtls == MTLSOff:
		reply.Error = &kmatev1.Error{Code: 501, Message: "hub is not issuing certificates"}
	case len(req.GetCsrPem()) == 0:
		reply.Error = &kmatev1.Error{Code: 400, Message: "renewal requires a CSR"}
	default:
		certPEM, err := r.ca.SignCSR(req.GetCsrPem(), conn.ClusterID, conn.AgentID)
		if err != nil {
			reply.Error = &kmatev1.Error{Code: 400, Message: err.Error()}
		} else {
			reply.CertPem = certPEM
			reply.CaPem = r.ca.CertPEM()
			r.recordCert(ctx, conn.ClusterID, certPEM)
			r.log.Info("renewed agent certificate", "cluster_id", conn.ClusterID, "agent_id", conn.AgentID)
		}
	}
	if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_CertRenewed{CertRenewed: reply}}); err != nil {
		r.log.Warn("sending renewed certificate failed", "cluster_id", conn.ClusterID, "err", err)
	}
}

func (r *Relay) publishCluster(ctx context.Context, clusterID, typ string) {
	c, err := r.store.GetCluster(ctx, clusterID)
	if err != nil {
		return
	}
	r.reg.ClusterEvents().Publish(&kmatev1.ClusterEvent{Type: typ, Cluster: c.Proto()})
}

// Publish emits a cluster event (used by the API for ADDED/DELETED).
func (r *Relay) Publish(ev *kmatev1.ClusterEvent) { r.reg.ClusterEvents().Publish(ev) }

// Stream opens a relayed stream to the cluster's agent and sends the request.
// The caller reads frames until a Close frame and must call Close on the
// stream when done (safe to call twice).
func (r *Relay) Stream(ctx context.Context, clusterID string, req *kmatev1.Request) (*mux.Stream, error) {
	conn, ok := r.reg.Get(clusterID)
	if !ok {
		return nil, connect.NewError(connect.CodeUnavailable, ErrClusterOffline)
	}
	if req.RequestId == "" {
		req.RequestId = uuid.NewString()
	}
	st, err := conn.Session.Open()
	if err != nil {
		return nil, connect.NewError(connect.CodeUnavailable, ErrClusterOffline)
	}
	r.openStreams.Add(1)
	go func() {
		<-st.Context().Done()
		r.openStreams.Add(-1)
	}()
	if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Request{Request: req}}); err != nil {
		st.Close(nil)
		return nil, connect.NewError(connect.CodeUnavailable, err)
	}
	// Close the stream if the caller's context ends.
	go func() {
		select {
		case <-ctx.Done():
			st.Close(nil)
		case <-st.Context().Done():
		}
	}()
	return st, nil
}

// Unary sends a request and waits for a single Response.
func (r *Relay) Unary(ctx context.Context, clusterID string, req *kmatev1.Request) (*kmatev1.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	st, err := r.Stream(ctx, clusterID, req)
	if err != nil {
		return nil, err
	}
	defer st.Close(nil)
	for {
		f, err := st.Recv(ctx)
		if err != nil {
			return nil, TranslateErr(err)
		}
		switch p := f.Payload.(type) {
		case *kmatev1.Frame_Response:
			if e := p.Response.GetError(); e != nil {
				return nil, ErrorFromProto(e)
			}
			return p.Response, nil
		case *kmatev1.Frame_Close:
			if e := mux.CloseError(f); e != nil {
				return nil, TranslateErr(e)
			}
			return nil, connect.NewError(connect.CodeInternal, errors.New("agent closed stream without a response"))
		}
	}
}

// ErrorFromProto converts an agent Error to a Connect error.
func ErrorFromProto(e *kmatev1.Error) error {
	msg := e.GetMessage()
	if e.GetReason() != "" {
		msg = e.GetReason() + ": " + msg
	}
	return connect.NewError(codeFromHTTP(e.GetCode()), errors.New(msg))
}

// TranslateErr maps mux / remote errors to Connect errors.
func TranslateErr(err error) error {
	var re *mux.RemoteError
	if errors.As(err, &re) {
		return connect.NewError(codeFromHTTP(re.Code), errors.New(re.Message))
	}
	if errors.Is(err, mux.ErrSessionClosed) || errors.Is(err, mux.ErrStreamClosed) {
		return connect.NewError(connect.CodeUnavailable, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	if errors.Is(err, context.Canceled) {
		return connect.NewError(connect.CodeCanceled, err)
	}
	if _, ok := err.(*connect.Error); ok {
		return err
	}
	return connect.NewError(connect.CodeInternal, err)
}

func codeFromHTTP(code int32) connect.Code {
	switch code {
	case 400, 422:
		return connect.CodeInvalidArgument
	case 401:
		return connect.CodeUnauthenticated
	case 403:
		return connect.CodePermissionDenied
	case 404:
		return connect.CodeNotFound
	case 409:
		return connect.CodeAlreadyExists
	case 429:
		return connect.CodeResourceExhausted
	case 501:
		return connect.CodeUnimplemented
	case 503:
		return connect.CodeUnavailable
	case 504:
		return connect.CodeDeadlineExceeded
	default:
		return connect.CodeInternal
	}
}
