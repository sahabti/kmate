package auth

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
)

// Grant is a user's access to one cluster. Namespaces empty means every namespace.
type Grant struct {
	ClusterID  string
	Role       string
	Namespaces []string
}

// Record is the stored account, as the Directory returns it.
type Record struct {
	ID        string
	Email     string
	Role      string
	Active    bool
	K8sUser   string
	K8sGroups []string
}

// Directory resolves accounts and grants. Implemented by the hub store; kept as
// an interface so authorization stays testable without a database.
type Directory interface {
	AuthRecord(ctx context.Context, userID string) (*Record, error)
	AuthGrants(ctx context.Context, userID string) ([]Grant, error)
}

// rank orders roles so they can be compared.
func rank(role string) int {
	switch role {
	case RoleAdmin:
		return 3
	case RoleOperator:
		return 2
	case RoleViewer:
		return 1
	}
	return 0
}

// ValidRole reports whether role is one of the three known roles.
func ValidRole(role string) bool { return rank(role) > 0 }

// IsAdmin reports whether the principal is a global administrator.
func (p *Principal) IsAdmin() bool { return p != nil && p.Role == RoleAdmin }

// EffectiveRole is the role the principal holds on one cluster, or "" for none.
// A global admin is admin everywhere; otherwise the grant decides.
func (p *Principal) EffectiveRole(clusterID string) string {
	if p == nil {
		return ""
	}
	if p.IsAdmin() {
		return RoleAdmin
	}
	for _, g := range p.Grants {
		if g.ClusterID == clusterID {
			return g.Role
		}
	}
	return ""
}

// CanAccessCluster reports whether the principal may see the cluster at all.
func (p *Principal) CanAccessCluster(clusterID string) bool {
	return p.EffectiveRole(clusterID) != ""
}

// CanWriteCluster reports whether the principal may mutate objects on a cluster.
func (p *Principal) CanWriteCluster(clusterID string) bool {
	return rank(p.EffectiveRole(clusterID)) >= rank(RoleOperator)
}

// grantFor returns the principal's grant on a cluster, if any.
func (p *Principal) grantFor(clusterID string) *Grant {
	if p == nil {
		return nil
	}
	for i := range p.Grants {
		if p.Grants[i].ClusterID == clusterID {
			return &p.Grants[i]
		}
	}
	return nil
}

// AllowedNamespaces returns the namespaces the principal is limited to on a
// cluster, or nil when unrestricted.
func (p *Principal) AllowedNamespaces(clusterID string) []string {
	if p.IsAdmin() {
		return nil
	}
	if g := p.grantFor(clusterID); g != nil {
		return g.Namespaces
	}
	return nil
}

// NamespaceAllowed reports whether a request touching ns is permitted.
// An empty ns means cluster-scoped or all-namespaces, which a namespace-limited
// grant may not do.
func (p *Principal) NamespaceAllowed(clusterID, ns string) bool {
	limit := p.AllowedNamespaces(clusterID)
	if len(limit) == 0 {
		return true
	}
	if ns == "" {
		return false
	}
	for _, n := range limit {
		if n == ns {
			return true
		}
	}
	return false
}

// AuthorizeCluster is the single enforcement point for cluster traffic: it checks
// that the principal holds a grant, that the grant allows the verb, and that every
// namespace the request touches is in scope.
//
// write=false is a read. An empty namespace means cluster-scoped or all-namespaces.
func AuthorizeCluster(ctx context.Context, clusterID string, write bool, namespaces ...string) error {
	p := FromContext(ctx)
	if p == nil {
		return connect.NewError(connect.CodeUnauthenticated, ErrUnauthenticated)
	}
	if clusterID == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("cluster_id is required"))
	}
	role := p.EffectiveRole(clusterID)
	if role == "" {
		return connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("no access to cluster %s: ask an administrator for a grant", clusterID))
	}
	if write && rank(role) < rank(RoleOperator) {
		return connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("role %s on cluster %s cannot modify resources (operator or admin required)", role, clusterID))
	}
	for _, ns := range namespaces {
		if p.NamespaceAllowed(clusterID, ns) {
			continue
		}
		allowed := strings.Join(p.AllowedNamespaces(clusterID), ", ")
		if ns == "" {
			return connect.NewError(connect.CodePermissionDenied,
				fmt.Errorf("access on cluster %s is limited to namespaces [%s]; this request is cluster-scoped or spans all namespaces", clusterID, allowed))
		}
		return connect.NewError(connect.CodePermissionDenied,
			fmt.Errorf("namespace %q is not in your grant on cluster %s (allowed: %s)", ns, clusterID, allowed))
	}
	return nil
}

// ---- directory-backed resolution with a very short cache ----

const resolveTTL = 2 * time.Second

type resolved struct {
	rec    *Record
	grants []Grant
	at     time.Time
}

type resolver struct {
	dir      Directory
	mu       sync.Mutex
	m        map[string]resolved
	streams  map[string]map[chan struct{}]struct{}
	revision uint64
}

func (r *resolver) get(ctx context.Context, userID string) (*Record, []Grant, error) {
	r.mu.Lock()
	revision := r.revision
	if e, ok := r.m[userID]; ok && time.Since(e.at) < resolveTTL {
		r.mu.Unlock()
		return e.rec, e.grants, nil
	}
	r.mu.Unlock()

	rec, err := r.dir.AuthRecord(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	grants, err := r.dir.AuthGrants(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(grants, func(i, j int) bool { return grants[i].ClusterID < grants[j].ClusterID })

	r.mu.Lock()
	if revision != r.revision {
		r.mu.Unlock()
		return r.get(ctx, userID)
	}
	if len(r.m) > 4096 {
		r.m = map[string]resolved{}
	}
	r.m[userID] = resolved{rec: rec, grants: grants, at: time.Now()}
	r.mu.Unlock()
	return rec, grants, nil
}

// Invalidate drops a user's cached record and grants so a change takes effect at once.
func (a *Authenticator) Invalidate(userID string) {
	if a.res == nil {
		return
	}
	a.res.mu.Lock()
	a.res.revision++
	delete(a.res.m, userID)
	for changed := range a.res.streams[userID] {
		close(changed)
	}
	delete(a.res.streams, userID)
	a.res.mu.Unlock()
}

// hydrate refreshes a principal from the directory: it rejects deactivated or
// deleted accounts and attaches the current role, Kubernetes identity and grants.
// Without a directory the principal is used as the token described it.
func (a *Authenticator) hydrate(ctx context.Context, p *Principal) (*Principal, error) {
	if a.res == nil {
		return p, nil
	}
	rec, grants, err := a.res.get(ctx, p.ID)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, errors.New("account no longer exists"))
	}
	if !rec.Active {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("account is deactivated"))
	}
	out := *p
	out.Email = rec.Email
	out.Role = rec.Role
	out.Active = true
	out.K8sUser = rec.K8sUser
	out.K8sGroups = rec.K8sGroups
	out.Grants = grants
	return &out, nil
}

// RequireAdmin returns a permission error unless the principal is a global admin.
func RequireAdmin(ctx context.Context) error {
	p := FromContext(ctx)
	if p == nil {
		return connect.NewError(connect.CodeUnauthenticated, ErrUnauthenticated)
	}
	if !p.IsAdmin() {
		return connect.NewError(connect.CodePermissionDenied, errors.New("administrator role required"))
	}
	return nil
}
