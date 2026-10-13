package auth

import (
	"context"
	"testing"
	"time"
)

func TestAuthorizationComparison(t *testing.T) {
	base := Principal{ID: "u", Email: "u@x", Role: RoleViewer, Active: true, K8sUser: "alice", Grants: []Grant{{ClusterID: "c", Role: RoleViewer}}}
	for _, tc := range []struct {
		name   string
		change func(*Principal)
		same   bool
	}{
		{"unchanged", func(*Principal) {}, true},
		{"empty groups", func(p *Principal) { p.K8sGroups = []string{} }, true},
		{"token metadata", func(p *Principal) { p.ExpiresAt = time.Now() }, true},
		{"role", func(p *Principal) { p.Role = RoleAdmin }, false},
		{"deactivated", func(p *Principal) { p.Active = false }, false},
		{"identity", func(p *Principal) { p.K8sUser = "bob" }, false},
		{"groups", func(p *Principal) { p.K8sGroups = []string{"admins"} }, false},
		{"grant", func(p *Principal) { p.Grants = nil }, false},
		{"namespace", func(p *Principal) {
			p.Grants = []Grant{{ClusterID: "c", Role: RoleViewer, Namespaces: []string{"shop"}}}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			other := base
			tc.change(&other)
			if got := sameAuthorization(&base, &other); got != tc.same {
				t.Fatalf("sameAuthorization=%v, want %v", got, tc.same)
			}
		})
	}
}

func TestStreamCancellation(t *testing.T) {
	for _, mode := range []string{"invalidate", "expired", "stale at establishment"} {
		t.Run(mode, func(t *testing.T) {
			d := &fakeDir{rec: &Record{ID: "u", Email: "v@x", Active: true, Role: RoleViewer}, grants: []Grant{{ClusterID: "c", Role: RoleViewer}}}
			a := New([]byte("secret")).WithDirectory(d)
			p, err := a.hydrate(context.Background(), &Principal{ID: "u"})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "expired" {
				p.ExpiresAt = time.Now().Add(-time.Second)
			}
			if mode == "stale at establishment" {
				old := *p
				old.Role = RoleAdmin
				p = &old
			}
			ctx, cancel := a.StreamContext(context.Background(), p)
			defer cancel()
			if mode == "invalidate" {
				a.Invalidate("u")
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("stream kept revoked or expired access")
			}
		})
	}
}

func TestStreamUnaffectedByAnotherUser(t *testing.T) {
	a := New([]byte("secret")).WithDirectory(&fakeDir{rec: &Record{ID: "u", Email: "v@x", Active: true, Role: RoleViewer}})
	p, err := a.hydrate(context.Background(), &Principal{ID: "u"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := a.StreamContext(context.Background(), p)
	defer cancel()
	a.Invalidate("other")
	select {
	case <-ctx.Done():
		t.Fatal("another account closed this stream")
	case <-time.After(20 * time.Millisecond):
	}
}
