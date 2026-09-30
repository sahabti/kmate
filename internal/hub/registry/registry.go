// Package registry tracks connected agents and their mux sessions.
package registry

import (
	"context"
	"sync"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/mux"
)

// AgentConn is one live agent tunnel.
type AgentConn struct {
	ClusterID    string
	AgentID      string
	Session      *mux.Session
	Capabilities []string
	ConnectedAt  time.Time

	mu            sync.RWMutex
	lastHeartbeat time.Time
	info          *kmatev1.ClusterInfo
}

// Touch records a heartbeat.
func (a *AgentConn) Touch(info *kmatev1.ClusterInfo) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.lastHeartbeat = time.Now()
	if info != nil {
		a.info = info
	}
}

// LastHeartbeat returns the last heartbeat time.
func (a *AgentConn) LastHeartbeat() time.Time {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.lastHeartbeat
}

// Info returns the latest cluster info.
func (a *AgentConn) Info() *kmatev1.ClusterInfo {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.info
}

// Registry is the in-memory table of connected agents plus broadcasters.
type Registry struct {
	mu     sync.RWMutex
	agents map[string]*AgentConn

	clusterEvents *Broadcaster[*kmatev1.ClusterEvent]
	catalogs      map[string]*Broadcaster[*kmatev1.Catalog]
}

// New creates a registry.
func New() *Registry {
	return &Registry{
		agents:        map[string]*AgentConn{},
		clusterEvents: NewBroadcaster[*kmatev1.ClusterEvent](),
		catalogs:      map[string]*Broadcaster[*kmatev1.Catalog]{},
	}
}

// Register adds (or replaces) the agent for a cluster; returns the previous one if any.
func (r *Registry) Register(a *AgentConn) *AgentConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.agents[a.ClusterID]
	r.agents[a.ClusterID] = a
	return prev
}

// Unregister removes the agent only if it is still the current one.
func (r *Registry) Unregister(a *AgentConn) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if cur, ok := r.agents[a.ClusterID]; ok && cur == a {
		delete(r.agents, a.ClusterID)
		return true
	}
	return false
}

// Get returns the live agent for a cluster.
func (r *Registry) Get(clusterID string) (*AgentConn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.agents[clusterID]
	return a, ok
}

// Count returns the number of connected agents.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.agents)
}

// ClusterEvents returns the cluster change broadcaster.
func (r *Registry) ClusterEvents() *Broadcaster[*kmatev1.ClusterEvent] { return r.clusterEvents }

// Catalog returns the catalog broadcaster for a cluster.
func (r *Registry) Catalog(clusterID string) *Broadcaster[*kmatev1.Catalog] {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.catalogs[clusterID]
	if !ok {
		b = NewBroadcaster[*kmatev1.Catalog]()
		r.catalogs[clusterID] = b
	}
	return b
}

// Broadcaster fans values out to subscribers.
type Broadcaster[T any] struct {
	mu   sync.Mutex
	subs map[chan T]struct{}
}

// NewBroadcaster creates one.
func NewBroadcaster[T any]() *Broadcaster[T] {
	return &Broadcaster[T]{subs: map[chan T]struct{}{}}
}

// Subscribe returns a channel that receives values until ctx is done.
func (b *Broadcaster[T]) Subscribe(ctx context.Context) <-chan T {
	ch := make(chan T, 16)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	go func() {
		<-ctx.Done()
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}()
	return ch
}

// Publish sends to all subscribers (non-blocking; slow subscribers miss values).
func (b *Broadcaster[T]) Publish(v T) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- v:
		default:
		}
	}
}
