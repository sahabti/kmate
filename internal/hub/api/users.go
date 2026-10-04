package api

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/store"
)

// ListUsers returns every account. Admin only.
func (h *HubService) ListUsers(ctx context.Context, _ *connect.Request[kmatev1.ListUsersRequest]) (*connect.Response[kmatev1.ListUsersResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	us, err := h.store.ListUsers(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := make([]*kmatev1.User, 0, len(us))
	for _, u := range us {
		out = append(out, userProto(u))
	}
	return connect.NewResponse(&kmatev1.ListUsersResponse{Users: out}), nil
}

// CreateUser adds an account. Admin only.
func (h *HubService) CreateUser(ctx context.Context, req *connect.Request[kmatev1.CreateUserRequest]) (*connect.Response[kmatev1.CreateUserResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	m := req.Msg
	email := strings.TrimSpace(strings.ToLower(m.GetEmail()))
	if email == "" || !strings.Contains(email, "@") {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("a valid email is required"))
	}
	if len(m.GetPassword()) < 8 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("password must be at least 8 characters"))
	}
	role := m.GetRole()
	if role == "" {
		role = auth.RoleViewer
	}
	if !auth.ValidRole(role) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown role %q (admin, operator or viewer)", role))
	}
	if _, err := h.store.GetUserByEmail(ctx, email); err == nil {
		return nil, connect.NewError(connect.CodeAlreadyExists, errors.New("a user with that email already exists"))
	}
	hash, err := auth.HashPassword(m.GetPassword())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	u := &store.User{
		Email: email, Name: m.GetName(), PasswordHash: hash, Role: role,
		K8sUser: m.GetK8SUser(), K8sGroups: m.GetK8SGroups(), Active: true,
	}
	if err := h.store.CreateUser(ctx, u); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, Action: "user.create", Target: email + " role=" + role, Result: "ok"})
	return connect.NewResponse(&kmatev1.CreateUserResponse{User: userProto(u)}), nil
}

// UpdateUser changes profile, role, Kubernetes identity or active state. Admin only.
func (h *HubService) UpdateUser(ctx context.Context, req *connect.Request[kmatev1.UpdateUserRequest]) (*connect.Response[kmatev1.UpdateUserResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	m := req.Msg
	u, err := h.store.GetUser(ctx, m.GetId())
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	self := p.ID == u.ID

	if m.GetNameSet() {
		u.Name = m.GetName()
	}
	if m.GetRoleSet() && m.GetRole() != u.Role {
		if self {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you cannot change your own role"))
		}
		if !auth.ValidRole(m.GetRole()) {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown role %q", m.GetRole()))
		}
		if u.Role == auth.RoleAdmin {
			if err := h.guardLastAdmin(ctx); err != nil {
				return nil, err
			}
		}
		u.Role = m.GetRole()
	}
	if m.GetK8SUserSet() {
		u.K8sUser = m.GetK8SUser()
	}
	if m.GetK8SGroupsSet() {
		u.K8sGroups = m.GetK8SGroups()
	}
	if m.GetActiveSet() && m.GetActive() != u.Active {
		if self && !m.GetActive() {
			return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you cannot deactivate yourself"))
		}
		if !m.GetActive() && u.Role == auth.RoleAdmin {
			if err := h.guardLastAdmin(ctx); err != nil {
				return nil, err
			}
		}
		u.Active = m.GetActive()
	}
	if err := h.store.UpdateUser(ctx, u); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	h.auth.Invalidate(u.ID)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, Action: "user.update", Target: u.Email, Result: "ok"})
	return connect.NewResponse(&kmatev1.UpdateUserResponse{User: userProto(u)}), nil
}

// DeleteUser removes an account and its grants. Admin only.
func (h *HubService) DeleteUser(ctx context.Context, req *connect.Request[kmatev1.DeleteUserRequest]) (*connect.Response[kmatev1.DeleteUserResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	u, err := h.store.GetUser(ctx, req.Msg.GetId())
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	p := auth.FromContext(ctx)
	if p.ID == u.ID {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("you cannot delete your own account"))
	}
	if u.Role == auth.RoleAdmin && u.Active {
		if err := h.guardLastAdmin(ctx); err != nil {
			return nil, err
		}
	}
	if err := h.store.DeleteUser(ctx, u.ID); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	h.auth.Invalidate(u.ID)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, Action: "user.delete", Target: u.Email, Result: "ok"})
	return connect.NewResponse(&kmatev1.DeleteUserResponse{}), nil
}

// SetPassword sets any password as an admin, or your own with the current one.
func (h *HubService) SetPassword(ctx context.Context, req *connect.Request[kmatev1.SetPasswordRequest]) (*connect.Response[kmatev1.SetPasswordResponse], error) {
	p := auth.FromContext(ctx)
	if p == nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}
	target := req.Msg.GetUserId()
	if target == "" {
		target = p.ID
	}
	if target != p.ID {
		if err := auth.RequireAdmin(ctx); err != nil {
			return nil, err
		}
	}
	if len(req.Msg.GetNewPassword()) < 8 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("password must be at least 8 characters"))
	}
	u, err := h.store.GetUser(ctx, target)
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if target == p.ID && !auth.CheckPassword(u.PasswordHash, req.Msg.GetCurrentPassword()) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("current password is incorrect"))
	}
	hash, err := auth.HashPassword(req.Msg.GetNewPassword())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if err := h.store.SetPasswordHash(ctx, u.ID, hash); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, Action: "user.set-password", Target: u.Email, Result: "ok"})
	return connect.NewResponse(&kmatev1.SetPasswordResponse{}), nil
}

// ListGrants returns a user's cluster grants. Admins may ask about anyone.
func (h *HubService) ListGrants(ctx context.Context, req *connect.Request[kmatev1.ListGrantsRequest]) (*connect.Response[kmatev1.ListGrantsResponse], error) {
	p := auth.FromContext(ctx)
	if p == nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, auth.ErrUnauthenticated)
	}
	target := req.Msg.GetUserId()
	if target == "" {
		target = p.ID
	}
	if target != p.ID {
		if err := auth.RequireAdmin(ctx); err != nil {
			return nil, err
		}
	}
	gs, err := h.store.ListGrantsForUser(ctx, target)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	names := h.clusterNames(ctx)
	out := make([]*kmatev1.ClusterGrant, 0, len(gs))
	for _, g := range gs {
		out = append(out, grantProto(g, names[g.ClusterID]))
	}
	return connect.NewResponse(&kmatev1.ListGrantsResponse{Grants: out}), nil
}

// SetGrant creates or replaces a grant. Admin only.
func (h *HubService) SetGrant(ctx context.Context, req *connect.Request[kmatev1.SetGrantRequest]) (*connect.Response[kmatev1.SetGrantResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	m := req.Msg
	role := m.GetRole()
	if role == "" {
		role = auth.RoleViewer
	}
	if !auth.ValidRole(role) {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("unknown role %q", role))
	}
	if _, err := h.store.GetUser(ctx, m.GetUserId()); errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("user not found"))
	}
	c, err := h.store.GetCluster(ctx, m.GetClusterId())
	if errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("cluster not found"))
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	g, err := h.store.SetGrant(ctx, &store.Grant{
		UserID: m.GetUserId(), ClusterID: m.GetClusterId(), Role: role, Namespaces: m.GetNamespaces(),
	})
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	h.auth.Invalidate(m.GetUserId())
	p := auth.FromContext(ctx)
	ns := "all namespaces"
	if len(g.Namespaces) > 0 {
		ns = strings.Join(g.Namespaces, ",")
	}
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: c.ID, Action: "grant.set",
		Target: fmt.Sprintf("user=%s role=%s ns=%s", m.GetUserId(), role, ns), Result: "ok"})
	return connect.NewResponse(&kmatev1.SetGrantResponse{Grant: grantProto(g, c.Name)}), nil
}

// DeleteGrant revokes access to a cluster. Admin only.
func (h *HubService) DeleteGrant(ctx context.Context, req *connect.Request[kmatev1.DeleteGrantRequest]) (*connect.Response[kmatev1.DeleteGrantResponse], error) {
	if err := auth.RequireAdmin(ctx); err != nil {
		return nil, err
	}
	if err := h.store.DeleteGrant(ctx, req.Msg.GetUserId(), req.Msg.GetClusterId()); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	h.auth.Invalidate(req.Msg.GetUserId())
	p := auth.FromContext(ctx)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: req.Msg.GetClusterId(),
		Action: "grant.delete", Target: "user=" + req.Msg.GetUserId(), Result: "ok"})
	return connect.NewResponse(&kmatev1.DeleteGrantResponse{}), nil
}

// guardLastAdmin refuses an action that would leave no active administrator.
func (h *HubService) guardLastAdmin(ctx context.Context) error {
	n, err := h.store.CountActiveAdmins(ctx)
	if err != nil {
		return connect.NewError(connect.CodeInternal, err)
	}
	if n <= 1 {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("this is the last active administrator; promote another account first"))
	}
	return nil
}

func (h *HubService) clusterNames(ctx context.Context) map[string]string {
	out := map[string]string{}
	cs, err := h.store.ListClusters(ctx)
	if err != nil {
		return out
	}
	for _, c := range cs {
		out[c.ID] = c.Name
	}
	return out
}

func grantProto(g *store.Grant, clusterName string) *kmatev1.ClusterGrant {
	return &kmatev1.ClusterGrant{
		Id: g.ID, UserId: g.UserID, ClusterId: g.ClusterID, ClusterName: clusterName,
		Role: g.Role, Namespaces: g.Namespaces, CreatedAt: timestamppb.New(g.CreatedAt),
	}
}
