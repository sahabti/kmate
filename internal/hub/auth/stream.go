package auth

import (
	"context"
	"slices"
	"time"
)

// StreamContext bounds a stream to its token lifetime and authorization snapshot.
// Administrative changes close streams immediately; directory changes made by
// OIDC or outside this process are detected within the resolution interval.
func (a *Authenticator) StreamContext(ctx context.Context, p *Principal) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(ctx)
	if p == nil {
		cancel()
		return ctx, cancel
	}
	if !p.ExpiresAt.IsZero() {
		var deadlineCancel context.CancelFunc
		ctx, deadlineCancel = context.WithDeadline(ctx, p.ExpiresAt)
		parentCancel := cancel
		cancel = func() { deadlineCancel(); parentCancel() }
	}
	if a.res == nil {
		return ctx, cancel
	}
	changed := make(chan struct{})
	r := a.res
	r.mu.Lock()
	if r.streams == nil {
		r.streams = map[string]map[chan struct{}]struct{}{}
	}
	if r.streams[p.ID] == nil {
		r.streams[p.ID] = map[chan struct{}]struct{}{}
	}
	r.streams[p.ID][changed] = struct{}{}
	r.mu.Unlock()
	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.streams[p.ID], changed)
			if len(r.streams[p.ID]) == 0 {
				delete(r.streams, p.ID)
			}
			r.mu.Unlock()
		}()
		defer cancel()
		t := time.NewTicker(resolveTTL)
		defer t.Stop()
		// Check once after registration so an invalidation racing with stream
		// establishment cannot leave a stale snapshot running.
		for {
			next, err := a.hydrate(ctx, p)
			if err != nil || !sameAuthorization(next, p) {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-changed:
				return
			case <-t.C:
			}
		}
	}()
	return ctx, cancel
}

// Compare only fields that affect access or the impersonated identity. Token
// expiry has its own deadline; adding unrelated principal metadata must not
// disconnect a stream. Empty and nil permission lists have the same meaning.
func sameAuthorization(a, b *Principal) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.ID != b.ID || a.Email != b.Email || a.Role != b.Role || a.Active != b.Active || a.K8sUser != b.K8sUser || !slices.Equal(a.K8sGroups, b.K8sGroups) || len(a.Grants) != len(b.Grants) {
		return false
	}
	for i, grant := range a.Grants {
		other := b.Grants[i]
		if grant.ClusterID != other.ClusterID || grant.Role != other.Role || !slices.Equal(grant.Namespaces, other.Namespaces) {
			return false
		}
	}
	return true
}
