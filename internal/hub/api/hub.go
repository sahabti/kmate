// Package api implements the client-facing Connect services.
package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

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
	u, err := h.store.GetUserByEmail(ctx, strings.TrimSpace(strings.ToLower(req.Msg.GetEmail())))
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid email or password"))
	}
	// Checked before the password: a provider-managed account has no usable hash,
	// so the generic failure would otherwise leave the person guessing when the
	// real answer is "use the SSO button".
	if u.OIDC {
		_ = h.store.Audit(ctx, store.AuditEvent{User: u.Email, Action: "login", Result: "denied: use single sign-on"})
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("this account signs in through your identity provider"))
	}
	if !auth.CheckPassword(u.PasswordHash, req.Msg.GetPassword()) {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("invalid email or password"))
	}
	if !u.Active {
		_ = h.store.Audit(ctx, store.AuditEvent{User: u.Email, Action: "login", Result: "denied: account deactivated"})
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("account is deactivated"))
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
	p := auth.FromContext(ctx)
	out := make([]*kmatev1.Cluster, 0, len(cs))
	for _, c := range cs {
		if !p.CanAccessCluster(c.ID) {
			continue // a cluster you hold no grant on is invisible, not forbidden
		}
		out = append(out, h.clusterProto(c))
	}
	return connect.NewResponse(&kmatev1.ListClustersResponse{Clusters: out}), nil
}

// GetCluster returns one cluster.
func (h *HubService) GetCluster(ctx context.Context, req *connect.Request[kmatev1.GetClusterRequest]) (*connect.Response[kmatev1.GetClusterResponse], error) {
	if err := auth.AuthorizeCluster(ctx, req.Msg.GetId(), false); err != nil {
		return nil, err
	}
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
// helmCommand renders the ready-to-paste install line shown after a cluster is
// created or a replacement token is issued. Both paths use it so they cannot drift.
func (h *HubService) helmCommand(token, clusterName string) string {
	return fmt.Sprintf("helm upgrade --install kmate-agent %s -n kmate-system --create-namespace --set hub.addr=%s --set enrollment.token=%s --set hub.insecure=%t --set clusterName=%q",
		h.cfg.ChartRef, h.cfg.AgentPublicAddr, token, h.cfg.Insecure, clusterName)
}

// IssueEnrollmentToken mints a replacement enrolment token for a cluster that
// already exists, for when an agent has lost its stored identity. Enrolment
// tokens are single use, so this is the only way back without deleting the
// cluster. Issuing one invalidates any outstanding unused token for it.
func (h *HubService) IssueEnrollmentToken(ctx context.Context, req *connect.Request[kmatev1.IssueEnrollmentTokenRequest]) (*connect.Response[kmatev1.IssueEnrollmentTokenResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	id := req.Msg.GetClusterId()
	if id == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("cluster_id is required"))
	}
	c, err := h.store.GetCluster(ctx, id)
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no such cluster"))
	}
	tok, err := h.store.CreateEnrollmentToken(ctx, c.ID, 24*time.Hour)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: c.ID, Action: "cluster.token.issue", Target: c.Name, Result: "ok"})
	return connect.NewResponse(&kmatev1.IssueEnrollmentTokenResponse{
		EnrollmentToken: tok,
		HelmCommand:     h.helmCommand(tok, c.Name),
		AgentAddr:       h.cfg.AgentPublicAddr,
	}), nil
}

func (h *HubService) CreateCluster(ctx context.Context, req *connect.Request[kmatev1.CreateClusterRequest]) (*connect.Response[kmatev1.CreateClusterResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
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
	helm := h.helmCommand(tok, name)
	return connect.NewResponse(&kmatev1.CreateClusterResponse{
		Cluster:         c.Proto(),
		EnrollmentToken: tok,
		HelmCommand:     helm,
		AgentAddr:       h.cfg.AgentPublicAddr,
	}), nil
}

// DeleteCluster removes a cluster.
func (h *HubService) DeleteCluster(ctx context.Context, req *connect.Request[kmatev1.DeleteClusterRequest]) (*connect.Response[kmatev1.DeleteClusterResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
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
	p := auth.FromContext(ctx)
	for _, c := range cs {
		if !p.CanAccessCluster(c.ID) {
			continue
		}
		if err := stream.Send(&kmatev1.ClusterEvent{Type: "ADDED", Cluster: h.clusterProto(c)}); err != nil {
			return err
		}
	}
	for {
		select {
		case ev := <-sub:
			if !p.CanAccessCluster(ev.GetCluster().GetId()) {
				continue
			}
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
	if cid := req.Msg.GetClusterId(); cid != "" {
		if err := auth.AuthorizeCluster(ctx, cid, false); err != nil {
			return nil, err
		}
	} else if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
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
	out := &kmatev1.User{
		Id: u.ID, Email: u.Email, Name: u.Name, Role: u.Role,
		K8SUser: u.K8sUser, K8SGroups: u.K8sGroups, Active: u.Active, Oidc: u.OIDC,
		CreatedAt: timestamppb.New(u.CreatedAt),
	}
	if !u.UpdatedAt.IsZero() {
		out.UpdatedAt = timestamppb.New(u.UpdatedAt)
	}
	return out
}
