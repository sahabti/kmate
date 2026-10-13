package api

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
)

type fixture struct {
	st      *store.Store
	hub     *HubService
	cluster *ClusterService
	ids     map[string]string // email -> user id
	cID     string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st, err := store.Open(ctx, "sqlite://"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	reg := registry.New()
	rl := relay.New(st, reg, slog.Default())
	a := auth.New([]byte("secret")).WithDirectory(st)

	c, err := st.CreateCluster(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{st: st, cID: c.ID, ids: map[string]string{}}
	f.hub = NewHubService(st, a, reg, rl, Config{}, slog.Default())
	f.cluster = NewClusterService(st, reg, rl, slog.Default())

	for _, u := range []*store.User{
		{Email: "admin@x", Role: auth.RoleAdmin},
		{Email: "viewer@x", Role: auth.RoleViewer},
		{Email: "operator@x", Role: auth.RoleViewer},
		{Email: "nobody@x", Role: auth.RoleViewer},
	} {
		if err := st.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
		f.ids[u.Email] = u.ID
	}
	// viewer: read-only, limited to namespace shop. operator: writes, all namespaces.
	mustGrant(t, st, f.ids["viewer@x"], c.ID, auth.RoleViewer, []string{"shop"})
	mustGrant(t, st, f.ids["operator@x"], c.ID, auth.RoleOperator, nil)
	return f
}

func mustGrant(t *testing.T, st *store.Store, uid, cid, role string, ns []string) {
	t.Helper()
	if _, err := st.SetGrant(context.Background(), &store.Grant{UserID: uid, ClusterID: cid, Role: role, Namespaces: ns}); err != nil {
		t.Fatal(err)
	}
}

// as builds a context carrying the principal exactly as the interceptor would.
func (f *fixture) as(t *testing.T, email string) context.Context {
	t.Helper()
	ctx := context.Background()
	rec, err := f.st.AuthRecord(ctx, f.ids[email])
	if err != nil {
		t.Fatal(err)
	}
	grants, err := f.st.AuthGrants(ctx, f.ids[email])
	if err != nil {
		t.Fatal(err)
	}
	return auth.WithPrincipal(ctx, &auth.Principal{
		ID: rec.ID, Email: rec.Email, Role: rec.Role, Active: rec.Active,
		K8sUser: rec.K8sUser, K8sGroups: rec.K8sGroups, Grants: grants,
	})
}

func TestListClustersHidesUngranted(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		user string
		want int
	}{
		{"admin@x", 1},  // admins see the whole fleet
		{"viewer@x", 1}, // granted
		{"nobody@x", 0}, // no grant: the cluster is invisible, not forbidden
	} {
		resp, err := f.hub.ListClusters(f.as(t, tc.user), connect.NewRequest(&kmatev1.ListClustersRequest{}))
		if err != nil {
			t.Fatalf("%s: %v", tc.user, err)
		}
		if got := len(resp.Msg.GetClusters()); got != tc.want {
			t.Fatalf("%s saw %d clusters, want %d", tc.user, got, tc.want)
		}
	}
}

func TestUngrantedUserCannotReachCluster(t *testing.T) {
	f := newFixture(t)
	ctx := f.as(t, "nobody@x")
	_, err := f.cluster.List(ctx, connect.NewRequest(&kmatev1.ClusterListRequest{
		ClusterId: f.cID, Gvr: &kmatev1.GVR{Version: "v1", Resource: "pods"},
		Options: &kmatev1.ListOptions{Namespace: "shop"},
	}))
	if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "no access to cluster") {
		t.Fatalf("expected permission denied, got %v", err)
	}
	if _, err := f.cluster.Get(ctx, connect.NewRequest(&kmatev1.ClusterGetRequest{ClusterId: f.cID})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("Get should be denied too: %v", err)
	}
}

func TestViewerIsDeniedWrites(t *testing.T) {
	f := newFixture(t)
	ctx := f.as(t, "viewer@x")
	ref := &kmatev1.ObjectRef{Gvr: &kmatev1.GVR{Group: "apps", Version: "v1", Resource: "deployments"}, Namespace: "shop", Name: "web"}

	_, err := f.cluster.Scale(ctx, connect.NewRequest(&kmatev1.ClusterScaleRequest{
		ClusterId: f.cID, Scale: &kmatev1.ScaleRequest{Ref: ref, Replicas: 3},
	}))
	if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "cannot modify") {
		t.Fatalf("viewer scale: %v", err)
	}
	_, err = f.cluster.Delete(ctx, connect.NewRequest(&kmatev1.ClusterDeleteRequest{
		ClusterId: f.cID, Delete: &kmatev1.DeleteRequest{Ref: ref},
	}))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("viewer delete: %v", err)
	}
	// The denial is recorded, not silently dropped.
	evs, err := f.st.ListAudit(context.Background(), f.cID, 50)
	if err != nil {
		t.Fatal(err)
	}
	var denials int
	for _, e := range evs {
		if strings.HasPrefix(e.GetResult(), "denied:") {
			denials++
		}
	}
	if denials < 2 {
		t.Fatalf("expected denials in the audit log, got %d", denials)
	}
}

func TestNamespaceScopeEnforcedOnReads(t *testing.T) {
	f := newFixture(t)
	ctx := f.as(t, "viewer@x")
	pods := &kmatev1.GVR{Version: "v1", Resource: "pods"}

	// Outside the grant.
	_, err := f.cluster.List(ctx, connect.NewRequest(&kmatev1.ClusterListRequest{
		ClusterId: f.cID, Gvr: pods, Options: &kmatev1.ListOptions{Namespace: "kube-system"},
	}))
	if connect.CodeOf(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "not in your grant") {
		t.Fatalf("kube-system: %v", err)
	}
	// All namespaces is refused for a limited grant.
	_, err = f.cluster.List(ctx, connect.NewRequest(&kmatev1.ClusterListRequest{
		ClusterId: f.cID, Gvr: pods, Options: &kmatev1.ListOptions{Namespace: ""},
	}))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("all namespaces: %v", err)
	}
	// Inside the grant the request reaches the relay, which reports the agent is offline.
	_, err = f.cluster.List(ctx, connect.NewRequest(&kmatev1.ClusterListRequest{
		ClusterId: f.cID, Gvr: pods, Options: &kmatev1.ListOptions{Namespace: "shop"},
	}))
	if connect.CodeOf(err) == connect.CodePermissionDenied {
		t.Fatalf("shop should pass authorization, got %v", err)
	}
}

func TestOperatorGrantAllowsWrites(t *testing.T) {
	f := newFixture(t)
	ctx := f.as(t, "operator@x")
	_, err := f.cluster.Scale(ctx, connect.NewRequest(&kmatev1.ClusterScaleRequest{
		ClusterId: f.cID,
		Scale:     &kmatev1.ScaleRequest{Ref: &kmatev1.ObjectRef{Namespace: "kube-system", Name: "x"}, Replicas: 1},
	}))
	// Authorization passes; the relay then fails because no agent is connected.
	if connect.CodeOf(err) == connect.CodePermissionDenied {
		t.Fatalf("operator should be allowed to write: %v", err)
	}
}

func TestAdminOnlyUserAdministration(t *testing.T) {
	f := newFixture(t)
	// A viewer cannot enumerate or create accounts.
	if _, err := f.hub.ListUsers(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.ListUsersRequest{})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("viewer ListUsers: %v", err)
	}
	if _, err := f.hub.CreateUser(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.CreateUserRequest{
		Email: "x@y", Password: "password123",
	})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("viewer CreateUser: %v", err)
	}
	// An admin can.
	adm := f.as(t, "admin@x")
	resp, err := f.hub.CreateUser(adm, connect.NewRequest(&kmatev1.CreateUserRequest{
		Email: "New@Example.COM", Password: "password123", Role: auth.RoleOperator, K8SGroups: []string{"team"},
	}))
	if err != nil {
		t.Fatal(err)
	}
	if resp.Msg.GetUser().GetEmail() != "new@example.com" {
		t.Fatalf("email should be normalised, got %q", resp.Msg.GetUser().GetEmail())
	}
	// Weak passwords and duplicates are refused.
	if _, err := f.hub.CreateUser(adm, connect.NewRequest(&kmatev1.CreateUserRequest{Email: "a@b", Password: "short"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("short password: %v", err)
	}
	if _, err := f.hub.CreateUser(adm, connect.NewRequest(&kmatev1.CreateUserRequest{Email: "new@example.com", Password: "password123"})); connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("duplicate: %v", err)
	}
}

func TestLastAdminIsProtected(t *testing.T) {
	f := newFixture(t)
	adm := f.as(t, "admin@x")
	id := f.ids["admin@x"]
	// Cannot demote yourself, cannot delete yourself.
	if _, err := f.hub.UpdateUser(adm, connect.NewRequest(&kmatev1.UpdateUserRequest{
		Id: id, Role: auth.RoleViewer, RoleSet: true,
	})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("self demote: %v", err)
	}
	if _, err := f.hub.DeleteUser(adm, connect.NewRequest(&kmatev1.DeleteUserRequest{Id: id})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("self delete: %v", err)
	}
	// Promote a second admin, then the first may be demoted.
	second := f.ids["viewer@x"]
	if _, err := f.hub.UpdateUser(adm, connect.NewRequest(&kmatev1.UpdateUserRequest{Id: second, Role: auth.RoleAdmin, RoleSet: true})); err != nil {
		t.Fatal(err)
	}
	if _, err := f.hub.UpdateUser(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.UpdateUserRequest{Id: id, Role: auth.RoleViewer, RoleSet: true})); err != nil {
		t.Fatalf("demoting with another admin present should work: %v", err)
	}
}

func TestGrantLifecycleTakesEffectImmediately(t *testing.T) {
	f := newFixture(t)
	adm := f.as(t, "admin@x")
	uid := f.ids["nobody@x"]

	if _, err := f.hub.SetGrant(adm, connect.NewRequest(&kmatev1.SetGrantRequest{
		UserId: uid, ClusterId: f.cID, Role: auth.RoleViewer, Namespaces: []string{"shop"},
	})); err != nil {
		t.Fatal(err)
	}
	// Grants are read per request, so the new access applies at once.
	resp, err := f.hub.ListClusters(f.as(t, "nobody@x"), connect.NewRequest(&kmatev1.ListClustersRequest{}))
	if err != nil || len(resp.Msg.GetClusters()) != 1 {
		t.Fatalf("after grant: %v %d", err, len(resp.Msg.GetClusters()))
	}
	if _, err := f.hub.DeleteGrant(adm, connect.NewRequest(&kmatev1.DeleteGrantRequest{UserId: uid, ClusterId: f.cID})); err != nil {
		t.Fatal(err)
	}
	resp, err = f.hub.ListClusters(f.as(t, "nobody@x"), connect.NewRequest(&kmatev1.ListClustersRequest{}))
	if err != nil || len(resp.Msg.GetClusters()) != 0 {
		t.Fatalf("after revoke: %v %d", err, len(resp.Msg.GetClusters()))
	}
}

func TestSetPasswordRules(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	hash, _ := auth.HashPassword("originalpw")
	u, _ := f.st.GetUser(ctx, f.ids["viewer@x"])
	if err := f.st.SetPasswordHash(ctx, u.ID, hash); err != nil {
		t.Fatal(err)
	}
	// Your own password needs the current one.
	if _, err := f.hub.SetPassword(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.SetPasswordRequest{
		CurrentPassword: "wrong", NewPassword: "newpassword",
	})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("wrong current password: %v", err)
	}
	if _, err := f.hub.SetPassword(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.SetPasswordRequest{
		CurrentPassword: "originalpw", NewPassword: "newpassword",
	})); err != nil {
		t.Fatal(err)
	}
	// A viewer cannot change someone else's.
	if _, err := f.hub.SetPassword(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.SetPasswordRequest{
		UserId: f.ids["admin@x"], NewPassword: "newpassword",
	})); connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("viewer resetting an admin: %v", err)
	}
	// An admin can, without the current one.
	if _, err := f.hub.SetPassword(f.as(t, "admin@x"), connect.NewRequest(&kmatev1.SetPasswordRequest{
		UserId: f.ids["viewer@x"], NewPassword: "adminsetpw",
	})); err != nil {
		t.Fatal(err)
	}
}

func TestIdentitySentToAgentIsKubernetesIdentity(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	u, _ := f.st.GetUser(ctx, f.ids["viewer@x"])
	u.K8sUser = "oidc:dev@example.com"
	u.K8sGroups = []string{"team-shop", "readers"}
	if err := f.st.UpdateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	r := NewRequest(f.as(t, "viewer@x"))
	if r.GetIdentity().GetUser() != "oidc:dev@example.com" {
		t.Fatalf("impersonated user = %q", r.GetIdentity().GetUser())
	}
	// Provider groups reach the agent, and so does the KMate role group, so a
	// cluster can bind kmate:viewer instead of every provider group name.
	if g := r.GetIdentity().GetGroups(); len(g) != 3 || g[0] != "team-shop" || g[2] != "kmate:viewer" {
		t.Fatalf("impersonated groups = %v", g)
	}
}
