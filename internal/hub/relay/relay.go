// Package relay implements the agent-facing gRPC AgentService and the helpers
// that route client requests over an agent's mux session.
package relay

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
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

// Relay is the AgentService server plus routing helpers.
type Relay struct {
	kmatev1.UnimplementedAgentServiceServer

	store *store.Store
	reg   *registry.Registry
	log   *slog.Logger

	openStreams atomic.Int64
}

// New creates a relay.
func New(st *store.Store, reg *registry.Registry, log *slog.Logger) *Relay {
	return &Relay{store: st, reg: reg, log: log}
}

// OpenStreams returns the number of live relayed streams (metrics).
func (r *Relay) OpenStreams() int64 { return r.openStreams.Load() }

// Registry exposes the agent registry (live cluster state, broadcasters).
func (r *Relay) Registry() *registry.Registry { return r.reg }

// Enroll exchanges an enrollment token for an agent identity.
func (r *Relay) Enroll(ctx context.Context, req *kmatev1.EnrollRequest) (*kmatev1.EnrollResponse, error) {
	clusterID, err := r.store.ConsumeEnrollmentToken(ctx, req.GetEnrollmentToken())
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
	// TODO(phase 5): sign req.CsrPem with internal CA (internal/hub/ca) and
	// return cert/ca PEM; require mTLS on the agent listener.
	return &kmatev1.EnrollResponse{
		AgentId:    agentID,
		ClusterId:  clusterID,
		AgentToken: agentToken,
	}, nil
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

	cluster, err := r.authenticateAgent(ctx, hello)
	if err != nil {
		r.log.Warn("agent hello rejected", "err", err)
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
		r.log.Info("replacing existing agent session", "cluster_id", cluster.ID)
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

func (r *Relay) authenticateAgent(ctx context.Context, hello *kmatev1.Hello) (*store.Cluster, error) {
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
		case *kmatev1.Frame_Close:
			return
		default:
			r.log.Warn("unexpected agent-initiated frame", "cluster_id", conn.ClusterID, "type", fmt.Sprintf("%T", p))
		}
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
