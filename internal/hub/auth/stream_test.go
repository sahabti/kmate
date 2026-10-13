package auth

import (
	"context"
	"testing"
	"time"
)

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
