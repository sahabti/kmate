package store

import (
	"context"
	"testing"
)

func TestUserCRUDAndK8sIdentity(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	u := &User{Email: "dev@example.com", Name: "Dev", PasswordHash: "x", Role: "viewer"}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	if !u.Active {
		t.Fatal("new users should be active")
	}
	// Defaults derive from email and role until an admin overrides them.
	if got := u.EffectiveK8sUser(); got != "dev@example.com" {
		t.Fatalf("k8s user = %q", got)
	}
	if g := u.EffectiveK8sGroups(); len(g) != 1 || g[0] != "kmate:viewer" {
		t.Fatalf("k8s groups = %v", g)
	}

	u.K8sUser = "oidc:dev"
	u.K8sGroups = []string{"team-shop", "readers"}
	u.Role = "operator"
	if err := s.UpdateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetUser(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.EffectiveK8sUser() != "oidc:dev" || len(got.EffectiveK8sGroups()) != 2 || got.Role != "operator" {
		t.Fatalf("round trip lost fields: %+v", got)
	}
	if got.UpdatedAt.IsZero() {
		t.Fatal("updated_at should be set")
	}

	us, err := s.ListUsers(ctx)
	if err != nil || len(us) != 1 {
		t.Fatalf("list: %v %d", err, len(us))
	}
	if err := s.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetUser(ctx, u.ID); err == nil {
		t.Fatal("expected not found after delete")
	}
}

func TestCountActiveAdmins(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	a := &User{Email: "a@x", Role: "admin"}
	b := &User{Email: "b@x", Role: "admin"}
	for _, u := range []*User{a, b, {Email: "c@x", Role: "viewer"}} {
		if err := s.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	if n, _ := s.CountActiveAdmins(ctx); n != 2 {
		t.Fatalf("admins = %d", n)
	}
	b.Active = false
	if err := s.UpdateUser(ctx, b); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountActiveAdmins(ctx); n != 1 {
		t.Fatalf("after deactivate admins = %d", n)
	}
}

func TestGrantsRoundTripAndUpsert(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	u := &User{Email: "v@x", Role: "viewer"}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	c, err := s.CreateCluster(ctx, "prod")
	if err != nil {
		t.Fatal(err)
	}

	g, err := s.SetGrant(ctx, &Grant{UserID: u.ID, ClusterID: c.ID, Role: "viewer", Namespaces: []string{"shop", "web"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Namespaces) != 2 || g.Namespaces[0] != "shop" {
		t.Fatalf("namespaces = %v", g.Namespaces)
	}

	// Setting again replaces rather than duplicating.
	if _, err := s.SetGrant(ctx, &Grant{UserID: u.ID, ClusterID: c.ID, Role: "operator"}); err != nil {
		t.Fatal(err)
	}
	gs, err := s.ListGrantsForUser(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(gs) != 1 || gs[0].Role != "operator" || len(gs[0].Namespaces) != 0 {
		t.Fatalf("after upsert: %+v", gs)
	}

	// Deleting the user cascades to grants.
	if err := s.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	gs, _ = s.ListGrantsForUser(ctx, u.ID)
	if len(gs) != 0 {
		t.Fatalf("grants should cascade, got %d", len(gs))
	}
}

func TestAuthDirectory(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	u := &User{Email: "d@x", Role: "viewer"}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	c, _ := s.CreateCluster(ctx, "dev")
	if _, err := s.SetGrant(ctx, &Grant{UserID: u.ID, ClusterID: c.ID, Role: "operator", Namespaces: []string{"shop"}}); err != nil {
		t.Fatal(err)
	}
	rec, err := s.AuthRecord(ctx, u.ID)
	if err != nil || rec.Email != "d@x" || !rec.Active || rec.K8sUser != "d@x" {
		t.Fatalf("record = %+v err=%v", rec, err)
	}
	gs, err := s.AuthGrants(ctx, u.ID)
	if err != nil || len(gs) != 1 || gs[0].Role != "operator" || gs[0].Namespaces[0] != "shop" {
		t.Fatalf("grants = %+v err=%v", gs, err)
	}
}
