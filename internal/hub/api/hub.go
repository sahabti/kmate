// Package api implements the client-facing Connect services.
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"connectrpc.com/connect"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/gen/go/kmate/v1/kmatev1connect"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
)

// Config holds values needed to build user-facing strings.
type Config struct {
	PublicURL       string
	AgentPublicAddr string
	Insecure        bool
	ChartRef        string
}

// HubService implements kmatev1connect.HubServiceHandler.
type HubService struct {
	kmatev1connect.UnimplementedHubServiceHandler
	store *store.Store
	auth  *auth.Authenticator
	reg   *registry.Registry
	relay *relay.Relay
	cfg   Config
	log   *slog.Logger
}

// NewHubService creates the handler.
func NewHubService(st *store.Store, a *auth.Authenticator, reg *registry.Registry, rl *relay.Relay, cfg Config, log *slog.Logger) *HubService {
	if cfg.ChartRef == "" {
		cfg.ChartRef = "oci://ghcr.io/kmate-dev/charts/kmate-agent"
	}
	return &HubService{store: st, auth: a, reg: reg, relay: rl, cfg: cfg, log: log}
}

// Login authenticates with email/password.
func (h *HubService) Login(ctx context.Context, req *connect.Request[kmatev1.LoginRequest]) (*connect.Response[kmatev1.LoginResponse], error) {
	u, err := h.store.GetUserByEmail(ctx, req.Msg.GetEmail())
	if err != nil || !auth.CheckPassword(u.PasswordHash, req.Msg.GetPassword()) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid email or password"))
	}
	p := &auth.Principal{ID: u.ID, Email: u.Email, Role: u.Role}
	tok, err := h.auth.Issue(p)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	_ = h.store.Audit(ctx, store.AuditEvent{User: u.Email, Action: "login", Result: "ok"})
	return connect.NewResponse(&kmatev1.LoginResponse{Token: tok, User: userProto(u)}), nil
}

// Logout is a no-op for stateless JWTs (clients drop the token).
func (h *HubService) Logout(ctx context.Context, _ *connect.Request[kmatev1.LogoutRequest]) (*connect.Response[kmatev1.LogoutResponse], error) {
	if p := auth.FromContext(ctx); p != nil {
		_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, Action: "logout", Result: "ok"})
	}
	return connect.NewResponse(&kmatev1.LogoutResponse{}), nil
}

// Me returns the current user.
func (h *HubService) Me(ctx context.Context, _ *connect.Request[kmatev1.MeRequest]) (*connect.Response[kmatev1.MeResponse], error) {
	p := auth.FromContext(ctx)
	u, err := h.store.GetUser(ctx, p.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	return connect.NewResponse(&kmatev1.MeResponse{User: userProto(u)}), nil
}

// ListClusters lists all clusters.
func (h *HubService) ListClusters(ctx context.Context, _ *connect.Request[kmatev1.ListClustersRequest]) (*connect.Response[kmatev1.ListClustersResponse], error) {
	cs, err := h.store.ListClusters(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*kmatev1.Cluster, 0, len(cs))
	for _, c := range cs {
		out = append(out, h.clusterProto(c))
	}
	return connect.NewResponse(&kmatev1.ListClustersResponse{Clusters: out}), nil
}

// GetCluster returns one cluster.
func (h *HubService) GetCluster(ctx context.Context, req *connect.Request[kmatev1.GetClusterRequest]) (*connect.Response[kmatev1.GetClusterResponse], error) {
	c, err := h.store.GetCluster(ctx, req.Msg.GetId())
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&kmatev1.GetClusterResponse{Cluster: h.clusterProto(c)}), nil
}

// CreateCluster registers a cluster and issues an enrollment token.
func (h *HubService) CreateCluster(ctx context.Context, req *connect.Request[kmatev1.CreateClusterRequest]) (*connect.Response[kmatev1.CreateClusterResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	name := req.Msg.GetName()
	if name == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("name is required"))
	}
	c, err := h.store.CreateCluster(ctx, name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	tok, err := h.store.CreateEnrollmentToken(ctx, c.ID, 24*time.Hour)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: c.ID, Action: "cluster.create", Target: name, Result: "ok"})
	h.relay.Publish(&kmatev1.ClusterEvent{Type: "ADDED", Cluster: c.Proto()})
	helm := fmt.Sprintf("helm upgrade --install kmate-agent %s -n kmate-system --create-namespace --set hub.addr=%s --set enrollment.token=%s --set hub.insecure=%t --set clusterName=%q",
		h.cfg.ChartRef, h.cfg.AgentPublicAddr, tok, h.cfg.Insecure, name)
	return connect.NewResponse(&kmatev1.CreateClusterResponse{
		Cluster:         c.Proto(),
		EnrollmentToken: tok,
		HelmCommand:     helm,
		AgentAddr:       h.cfg.AgentPublicAddr,
	}), nil
}

// DeleteCluster removes a cluster.
func (h *HubService) DeleteCluster(ctx context.Context, req *connect.Request[kmatev1.DeleteClusterRequest]) (*connect.Response[kmatev1.DeleteClusterResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	c, err := h.store.GetCluster(ctx, req.Msg.GetId())
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if conn, ok := h.reg.Get(c.ID); ok {
		conn.Session.Close()
	}
	if err := h.store.DeleteCluster(ctx, c.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: c.ID, Action: "cluster.delete", Target: c.Name, Result: "ok"})
	h.relay.Publish(&kmatev1.ClusterEvent{Type: "DELETED", Cluster: c.Proto()})
	return connect.NewResponse(&kmatev1.DeleteClusterResponse{}), nil
}

// WatchClusters streams the current clusters then changes.
func (h *HubService) WatchClusters(ctx context.Context, _ *connect.Request[kmatev1.WatchClustersRequest], stream *connect.ServerStream[kmatev1.ClusterEvent]) error {
	sub := h.reg.ClusterEvents().Subscribe(ctx)
	cs, err := h.store.ListClusters(ctx)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	for _, c := range cs {
		if err := stream.Send(&kmatev1.ClusterEvent{Type: "ADDED", Cluster: h.clusterProto(c)}); err != nil {
			return err
		}
	}
	for {
		select {
		case ev := <-sub:
			if err := stream.Send(ev); err != nil {
				return err
			}
		case <-ctx.Done():
			return nil
		}
	}
}

// ListAuditEvents returns audit history.
func (h *HubService) ListAuditEvents(ctx context.Context, req *connect.Request[kmatev1.ListAuditEventsRequest]) (*connect.Response[kmatev1.ListAuditEventsResponse], error) {
	evs, err := h.store.ListAudit(ctx, req.Msg.GetClusterId(), int(req.Msg.GetLimit()))
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&kmatev1.ListAuditEventsResponse{Events: evs}), nil
}

func (h *HubService) clusterProto(c *store.Cluster) *kmatev1.Cluster {
	p := c.Proto()
	// Live state wins over the persisted row.
	if conn, ok := h.reg.Get(c.ID); ok {
		p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_ONLINE
		if info := conn.Info(); info != nil {
			p.Info = info
		}
	} else if p.Status == kmatev1.ClusterStatus_CLUSTER_STATUS_ONLINE {
		p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_OFFLINE
	}
	return p
}

func userProto(u *store.User) *kmatev1.User {
	return &kmatev1.User{Id: u.ID, Email: u.Email, Name: u.Name, Role: u.Role}
}
