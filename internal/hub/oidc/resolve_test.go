package oidc

import (
	"context"
	"testing"
)

type resolveDirectory struct {
	user    *DirUser
	updates int
}

func (d *resolveDirectory) GetUserByEmail(context.Context, string) (*DirUser, error) {
	return d.user, nil
}
func (d *resolveDirectory) CreateUser(context.Context, *DirUser) error { return nil }
func (d *resolveDirectory) UpdateUser(_ context.Context, u *DirUser) error {
	d.user = u
	d.updates++
	return nil
}
func (d *resolveDirectory) Audit(context.Context, string, string, string, string) {}

func TestResolveClearsRemovedProviderGroups(t *testing.T) {
	for _, groups := range [][]string{nil, {}, {"readers"}} {
		t.Run("groups", func(t *testing.T) {
			d := &resolveDirectory{user: &DirUser{ID: "u", Email: "a@x", Active: true, OIDC: true, Role: "viewer", K8sGroups: []string{"privileged"}}}
			h := &Handler{prov: &Provider{cfg: Config{DefaultRole: "viewer"}}, dir: d}
			u, err := h.resolve(context.Background(), &Identity{Username: "a@x", Email: "a@x", Groups: groups})
			if err != nil {
				t.Fatal(err)
			}
			if !sameStrings(u.K8sGroups, groups) || d.updates != 1 {
				t.Fatalf("old groups survived: %v", u.K8sGroups)
			}
		})
	}
}
