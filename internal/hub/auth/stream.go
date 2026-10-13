package auth

import (
	"context"
	"reflect"
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
			if err != nil || !reflect.DeepEqual(next, p) {
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
