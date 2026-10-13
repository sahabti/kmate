// Package auth implements hub authentication: bcrypt passwords and HS256 JWT sessions.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// Roles.
const (
	RoleAdmin    = "admin"
	RoleOperator = "operator"
	RoleViewer   = "viewer"
)

// SessionTTL is how long a login token is valid.
const SessionTTL = 12 * time.Hour

// Principal is the authenticated user placed in the context. Role, the Kubernetes
// identity and Grants are refreshed from the directory on every request, so a
// revoked grant or a deactivated account takes effect immediately rather than when
// the token expires.
type Principal struct {
	ID        string
	Email     string
	Role      string
	Active    bool
	ExpiresAt time.Time

	// Kubernetes identity the agent impersonates. Empty K8sUser means "use Email".
	K8sUser   string
	K8sGroups []string

	// Grants is the per-cluster access this user holds.
	Grants []Grant
}

// CanWrite reports whether the principal's global role may mutate state.
// Cluster traffic must use AuthorizeCluster, which also honours grants.
func (p *Principal) CanWrite() bool {
	return p != nil && (p.Role == RoleAdmin || p.Role == RoleOperator)
}

// KubeUser is the username the agent impersonates for this principal.
func (p *Principal) KubeUser() string {
	if p == nil {
		return ""
	}
	if p.K8sUser != "" {
		return p.K8sUser
	}
	return p.Email
}

// Groups returns the Kubernetes groups used for impersonation.
func (p *Principal) Groups() []string {
	if p != nil && len(p.K8sGroups) > 0 {
		return p.K8sGroups
	}
	if p == nil {
		return nil
	}
	return []string{"kmate:" + p.Role}
}

type ctxKey struct{}

// WithPrincipal stores the principal in ctx.
func WithPrincipal(ctx context.Context, p *Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext returns the principal, or nil.
func FromContext(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}

// Authenticator issues and verifies tokens, and resolves authorization state.
type Authenticator struct {
	secret []byte
	res    *resolver
}

// New creates an authenticator with an HS256 secret.
func New(secret []byte) *Authenticator { return &Authenticator{secret: secret} }

// WithDirectory attaches the account/grant source. Without it the authenticator
// trusts the token alone, which is only useful in tests.
func (a *Authenticator) WithDirectory(d Directory) *Authenticator {
	a.res = &resolver{dir: d, m: map[string]resolved{}}
	return a
}

// HashPassword bcrypts a password.
func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

// CheckPassword verifies a bcrypt hash.
func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

type claims struct {
	Email string `json:"email"`
	Role  string `json:"role"`
	jwt.RegisteredClaims
}

// Issue creates a session token.
func (a *Authenticator) Issue(p *Principal) (string, error) { return a.IssueFor(p, SessionTTL) }

// IssueFor creates a token with a custom lifetime.
func (a *Authenticator) IssueFor(p *Principal, ttl time.Duration) (string, error) {
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims{
		Email: p.Email,
		Role:  p.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   p.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			Issuer:    "kmate-hub",
		},
	})
	return tok.SignedString(a.secret)
}

// ErrUnauthenticated is returned when no valid token is present.
var ErrUnauthenticated = errors.New("unauthenticated")

// Verify parses a token.
func (a *Authenticator) Verify(token string) (*Principal, error) {
	var c claims
	t, err := jwt.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return a.secret, nil
	}, jwt.WithIssuer("kmate-hub"), jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
	if err != nil || !t.Valid {
		return nil, ErrUnauthenticated
	}
	return &Principal{ID: c.Subject, Email: c.Email, Role: c.Role, ExpiresAt: c.ExpiresAt.Time}, nil
}

// FromHTTP extracts a principal from Authorization: Bearer or ?token=, refreshed
// from the directory so grants and deactivation apply to WebSocket and proxy routes.
func (a *Authenticator) FromHTTP(r *http.Request) (*Principal, error) {
	tok := TokenFromHeader(r.Header)
	if tok == "" {
		tok = r.URL.Query().Get("token")
	}
	if tok == "" {
		return nil, ErrUnauthenticated
	}
	p, err := a.Verify(tok)
	if err != nil {
		return nil, err
	}
	return a.hydrate(r.Context(), p)
}

// VerifyHydrated verifies a raw token and refreshes it from the directory.
func (a *Authenticator) VerifyHydrated(ctx context.Context, token string) (*Principal, error) {
	p, err := a.Verify(token)
	if err != nil {
		return nil, err
	}
	return a.hydrate(ctx, p)
}

// TokenFromHeader reads a bearer token.
func TokenFromHeader(h http.Header) string {
	v := h.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(v), "bearer ") {
		return strings.TrimSpace(v[7:])
	}
	return ""
}

// Interceptor returns a Connect interceptor that authenticates requests.
// Procedures listed in public are allowed without a token.
func (a *Authenticator) Interceptor(public ...string) connect.Interceptor {
	pub := map[string]bool{}
	for _, p := range public {
		pub[p] = true
	}
	authenticate := func(ctx context.Context, procedure string, h http.Header) (context.Context, error) {
		tok := TokenFromHeader(h)
		if tok == "" {
			if pub[procedure] {
				return ctx, nil
			}
			return nil, connect.NewError(connect.CodeUnauthenticated, ErrUnauthenticated)
		}
		p, err := a.Verify(tok)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}
		p, err = a.hydrate(ctx, p)
		if err != nil {
			return nil, err
		}
		return WithPrincipal(ctx, p), nil
	}
	return &interceptor{authenticate: authenticate, authenticateStream: func(ctx context.Context) (context.Context, context.CancelFunc) {
		return a.StreamContext(ctx, FromContext(ctx))
	}}
}

type interceptor struct {
	authenticate       func(ctx context.Context, procedure string, h http.Header) (context.Context, error)
	authenticateStream func(context.Context) (context.Context, context.CancelFunc)
}

func (i *interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if req.Spec().IsClient {
			return next(ctx, req)
		}
		ctx, err := i.authenticate(ctx, req.Spec().Procedure, req.Header())
		if err != nil {
			return nil, err
		}
		return next(ctx, req)
	}
}

func (i *interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (i *interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		ctx, err := i.authenticate(ctx, conn.Spec().Procedure, conn.RequestHeader())
		if err != nil {
			return err
		}
		ctx, cancel := i.authenticateStream(ctx)
		defer cancel()
		return next(ctx, conn)
	}
}

// RequireWrite returns a permission error unless the principal may write.
func RequireWrite(ctx context.Context) error {
	p := FromContext(ctx)
	if p == nil {
		return connect.NewError(connect.CodeUnauthenticated, ErrUnauthenticated)
	}
	if !p.CanWrite() {
		return connect.NewError(connect.CodePermissionDenied, errors.New("role "+p.Role+" cannot modify cluster resources"))
	}
	return nil
}
