package auth

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
)

func viewerOn(cluster string, ns ...string) *Principal {
	return &Principal{ID: "u", Email: "v@x", Role: RoleViewer, Active: true,
		Grants: []Grant{{ClusterID: cluster, Role: RoleViewer, Namespaces: ns}}}
}

func TestEffectiveRole(t *testing.T) {
	admin := &Principal{ID: "a", Role: RoleAdmin}
	// A global admin needs no grant.
	if admin.EffectiveRole("anything") != RoleAdmin || !admin.CanWriteCluster("anything") {
		t.Fatal("admin should be admin everywhere")
	}
	v := viewerOn("c1")
	if v.EffectiveRole("c1") != RoleViewer {
		t.Fatal("grant role should apply")
	}
	if v.EffectiveRole("c2") != "" || v.CanAccessCluster("c2") {
		t.Fatal("no grant means no access")
	}
	if v.CanWriteCluster("c1") {
		t.Fatal("viewer must not write")
	}
	op := &Principal{ID: "o", Role: RoleViewer, Grants: []Grant{{ClusterID: "c1", Role: RoleOperator}}}
	if !op.CanWriteCluster("c1") {
		t.Fatal("operator grant should allow writes")
	}
	// A global operator role does not grant access without a grant.
	ghost := &Principal{ID: "g", Role: RoleOperator}
	if ghost.CanAccessCluster("c1") {
		t.Fatal("global operator still needs a grant")
	}
}

func TestNamespaceScoping(t *testing.T) {
	v := viewerOn("c1", "shop", "web")
	if !v.NamespaceAllowed("c1", "shop") || !v.NamespaceAllowed("c1", "web") {
		t.Fatal("listed namespaces should be allowed")
	}
	if v.NamespaceAllowed("c1", "kube-system") {
		t.Fatal("unlisted namespace must be denied")
	}
	// Empty namespace means cluster-scoped or all namespaces, which a limited grant cannot do.
	if v.NamespaceAllowed("c1", "") {
		t.Fatal("limited grant must not span all namespaces")
	}
	// An unrestricted grant allows everything, including cluster-scoped reads.
	all := viewerOn("c1")
	if !all.NamespaceAllowed("c1", "") || !all.NamespaceAllowed("c1", "kube-system") {
		t.Fatal("unrestricted grant should allow all")
	}
	admin := &Principal{Role: RoleAdmin}
	if !admin.NamespaceAllowed("c1", "") {
		t.Fatal("admin is never namespace-limited")
	}
}

func code(err error) connect.Code { return connect.CodeOf(err) }

func TestAuthorizeCluster(t *testing.T) {
	ctx := func(p *Principal) context.Context { return WithPrincipal(context.Background(), p) }

	if err := AuthorizeCluster(context.Background(), "c1", false); code(err) != connect.CodeUnauthenticated {
		t.Fatalf("anonymous: %v", err)
	}
	// No grant at all.
	err := AuthorizeCluster(ctx(viewerOn("other")), "c1", false)
	if code(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "no access to cluster") {
		t.Fatalf("ungranted cluster: %v", err)
	}
	// Read allowed, write denied for a viewer.
	if err := AuthorizeCluster(ctx(viewerOn("c1")), "c1", false); err != nil {
		t.Fatalf("viewer read: %v", err)
	}
	err = AuthorizeCluster(ctx(viewerOn("c1")), "c1", true)
	if code(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "cannot modify") {
		t.Fatalf("viewer write: %v", err)
	}
	// Namespace outside the grant.
	err = AuthorizeCluster(ctx(viewerOn("c1", "shop")), "c1", false, "kube-system")
	if code(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "not in your grant") {
		t.Fatalf("wrong namespace: %v", err)
	}
	// All-namespace request from a limited grant.
	err = AuthorizeCluster(ctx(viewerOn("c1", "shop")), "c1", false, "")
	if code(err) != connect.CodePermissionDenied || !strings.Contains(err.Error(), "cluster-scoped") {
		t.Fatalf("all namespaces: %v", err)
	}
	// Admin passes everything.
	if err := AuthorizeCluster(ctx(&Principal{Role: RoleAdmin}), "c1", true, "kube-system"); err != nil {
		t.Fatalf("admin: %v", err)
	}
}

func TestRequireAdminAndValidRole(t *testing.T) {
	if err := RequireAdmin(WithPrincipal(context.Background(), &Principal{Role: RoleViewer})); code(err) != connect.CodePermissionDenied {
		t.Fatal("viewer must not pass RequireAdmin")
	}
	if err := RequireAdmin(WithPrincipal(context.Background(), &Principal{Role: RoleAdmin})); err != nil {
		t.Fatal(err)
	}
	if !ValidRole("admin") || !ValidRole("operator") || !ValidRole("viewer") || ValidRole("root") {
		t.Fatal("role validation")
	}
}

// fakeDir lets the interceptor path be tested without a database.
type fakeDir struct {
	rec    *Record
	grants []Grant
	err    error
}

func (f *fakeDir) AuthRecord(context.Context, string) (*Record, error) { return f.rec, f.err }
func (f *fakeDir) AuthGrants(context.Context, string) ([]Grant, error) { return f.grants, f.err }

func TestHydrateRejectsDeactivated(t *testing.T) {
	a := New([]byte("s")).WithDirectory(&fakeDir{rec: &Record{ID: "u", Email: "x@y", Role: RoleViewer, Active: false}})
	_, err := a.hydrate(context.Background(), &Principal{ID: "u"})
	if code(err) != connect.CodePermissionDenied {
		t.Fatalf("deactivated account should be refused, got %v", err)
	}
}

func TestHydrateRefreshesRoleAndGrants(t *testing.T) {
	dir := &fakeDir{
		rec:    &Record{ID: "u", Email: "x@y", Role: RoleAdmin, Active: true, K8sUser: "oidc:x", K8sGroups: []string{"team"}},
		grants: []Grant{{ClusterID: "c1", Role: RoleOperator}},
	}
	a := New([]byte("s")).WithDirectory(dir)
	// The token says viewer; the directory says admin and wins.
	p, err := a.hydrate(context.Background(), &Principal{ID: "u", Role: RoleViewer})
	if err != nil {
		t.Fatal(err)
	}
	if p.Role != RoleAdmin || p.KubeUser() != "oidc:x" || p.Groups()[0] != "team" || len(p.Grants) != 1 {
		t.Fatalf("hydrated = %+v", p)
	}
}
