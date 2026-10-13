package store

import (
	"slices"
	"testing"
)

func TestEffectiveK8sGroups(t *testing.T) {
	tests := []struct {
		name   string
		role   string
		groups []string
		want   []string
	}{
		{
			name: "local account falls back to the role group",
			role: "viewer",
			want: []string{"kmate:viewer"},
		},
		{
			// The case that mattered in production: an OIDC login writes the
			// provider's groups, which used to displace the role group entirely
			// and leave every kmate:<role> binding matching nobody.
			name:   "provider groups keep the role group",
			role:   "admin",
			groups: []string{"kmate-admins", "platform"},
			want:   []string{"kmate-admins", "platform", "kmate:admin"},
		},
		{
			name:   "role group is not duplicated when supplied explicitly",
			role:   "operator",
			groups: []string{"kmate:operator", "sre"},
			want:   []string{"kmate:operator", "sre"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u := &User{Role: tt.role, K8sGroups: tt.groups}
			if got := u.EffectiveK8sGroups(); !slices.Equal(got, tt.want) {
				t.Errorf("EffectiveK8sGroups() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEffectiveK8sGroupsDoesNotMutateUser(t *testing.T) {
	// The slice is read per request and handed to the agent; aliasing it would
	// let one request's impersonation grow another's group list.
	u := &User{Role: "admin", K8sGroups: []string{"kmate-admins"}}
	_ = u.EffectiveK8sGroups()
	if len(u.K8sGroups) != 1 || u.K8sGroups[0] != "kmate-admins" {
		t.Fatalf("stored groups were mutated: %v", u.K8sGroups)
	}
}
