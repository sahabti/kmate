// Package oidc implements provider-agnostic OpenID Connect login for the hub.
//
// The operator supplies an issuer URL and a client; everything else comes from
// the provider's own discovery document, so Keycloak, Okta, Authentik, Entra,
// Google, Dex or anything else standards-compliant works from the same code.
//
// Two things make this fit KMate specifically:
//
//   - The groups claim is written to the user's k8s_groups, so the groups your
//     identity provider already manages flow straight through the agent's
//     impersonation into Kubernetes RBAC.
//   - Discovery is lazy and retried in the background. A provider outage must
//     never stop the hub from booting, because local login is the way back in.
package oidc

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Config is the operator-supplied OIDC configuration. Issuer and ClientID are
// the only required fields; everything else has a sensible default.
type Config struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	Scopes       []string
	RedirectURL  string // absolute; defaults to <PublicURL>/auth/oidc/callback
	ButtonLabel  string

	// Claim names. Providers disagree about these, so they are configurable.
	UsernameClaim string
	EmailClaim    string
	NameClaim     string
	GroupsClaim   string

	// Account provisioning.
	AutoProvision  bool
	DefaultRole    string
	AdminGroups    []string
	OperatorGroups []string
	ViewerGroups   []string

	InsecureSkipVerify bool

	// PublicURL is used to derive RedirectURL and to validate post-login redirects.
	PublicURL string
}

// Enabled reports whether OIDC is configured at all.
func (c Config) Enabled() bool { return c.Issuer != "" && c.ClientID != "" }

// withDefaults fills in everything the operator left blank.
func (c Config) withDefaults() Config {
	if len(c.Scopes) == 0 {
		// Only standard scopes by default. "groups" is a convention, not part of
		// OIDC: Okta and Authentik expose groups through a scope of that name,
		// while Keycloak rejects it outright unless a client scope called
		// "groups" exists and instead emits groups via a protocol mapper. Asking
		// for it unconditionally makes a stock Keycloak fail with invalid_scope,
		// so operators who need it add it with KMATE_OIDC_SCOPES.
		c.Scopes = []string{gooidc.ScopeOpenID, "profile", "email"}
	}
	if c.RedirectURL == "" && c.PublicURL != "" {
		c.RedirectURL = strings.TrimRight(c.PublicURL, "/") + CallbackPath
	}
	if c.UsernameClaim == "" {
		c.UsernameClaim = "email"
	}
	if c.EmailClaim == "" {
		c.EmailClaim = "email"
	}
	if c.NameClaim == "" {
		c.NameClaim = "name"
	}
	if c.GroupsClaim == "" {
		c.GroupsClaim = "groups"
	}
	if c.DefaultRole == "" {
		c.DefaultRole = "viewer"
	}
	if c.ButtonLabel == "" {
		c.ButtonLabel = labelForIssuer(c.Issuer)
	}
	return c
}

// labelForIssuer produces "Sign in with Keycloak" from an issuer URL. Best
// effort only; the operator can always set KMATE_OIDC_BUTTON_LABEL.
func labelForIssuer(issuer string) string {
	host := issuer
	if u, err := url.Parse(issuer); err == nil && u.Host != "" {
		host = u.Host
	}
	host = strings.TrimPrefix(host, "www.")
	if i := strings.IndexByte(host, ':'); i > 0 {
		host = host[:i]
	}
	name := host
	for _, known := range []string{"keycloak", "okta", "authentik", "auth0", "entra", "google", "dex", "gitlab", "github"} {
		if strings.Contains(strings.ToLower(host), known) {
			name = strings.ToUpper(known[:1]) + known[1:]
			break
		}
	}
	if name == host {
		// fall back to the first label of the domain, title-cased
		if parts := strings.Split(host, "."); len(parts) > 0 && parts[0] != "" {
			name = strings.ToUpper(parts[0][:1]) + parts[0][1:]
		}
	}
	return "Sign in with " + name
}

// Paths served by Provider.Register.
const (
	ConfigPath   = "/auth/config"
	LoginPath    = "/auth/oidc/login"
	CallbackPath = "/auth/oidc/callback"
)

const (
	stateCookie = "kmate_oidc_state"
	stateTTL    = 10 * time.Minute
)

// Identity is a verified end user, as described by the provider.
type Identity struct {
	Subject  string
	Username string
	Email    string
	Name     string
	Groups   []string
}

// Provider performs the authorization-code flow against one OIDC issuer.
type Provider struct {
	cfg Config
	log *slog.Logger
	// secret signs the state cookie; reusing the hub's JWT secret is fine, it
	// never leaves the server.
	secret []byte

	mu       sync.RWMutex
	verifier *gooidc.IDTokenVerifier
	oauth    *oauth2.Config
	lastErr  error
	lastTry  time.Time

	httpClient *http.Client
}

// New builds a provider. Discovery is not performed here: a provider that is
// down at boot must not prevent the hub from starting with local login.
func New(cfg Config, secret []byte, log *slog.Logger) *Provider {
	cfg = cfg.withDefaults()
	hc := &http.Client{Timeout: 15 * time.Second}
	if cfg.InsecureSkipVerify {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = insecureTLS()
		hc.Transport = tr
		log.Warn("oidc: TLS verification disabled (KMATE_OIDC_INSECURE_SKIP_VERIFY), do not use in production")
	}
	return &Provider{cfg: cfg, log: log, secret: secret, httpClient: hc}
}

// Config returns the effective configuration.
func (p *Provider) Config() Config { return p.cfg }

// Label is the button text the UI should render.
func (p *Provider) Label() string { return p.cfg.ButtonLabel }

// Ready reports whether discovery has succeeded, attempting it if needed.
func (p *Provider) Ready(ctx context.Context) bool { return p.ensure(ctx) == nil }

// ensure lazily runs discovery, retrying at most every 30s on failure so a
// flapping provider cannot turn into a request storm.
func (p *Provider) ensure(ctx context.Context) error {
	p.mu.RLock()
	v, lastErr, lastTry := p.verifier, p.lastErr, p.lastTry
	p.mu.RUnlock()
	if v != nil {
		return nil
	}
	if lastErr != nil && time.Since(lastTry) < 30*time.Second {
		return lastErr
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	if p.verifier != nil {
		return nil
	}
	p.lastTry = time.Now()

	dctx := gooidc.ClientContext(ctx, p.httpClient)
	prov, err := gooidc.NewProvider(dctx, p.cfg.Issuer)
	if err != nil {
		p.lastErr = fmt.Errorf("oidc discovery for %s: %w", p.cfg.Issuer, err)
		p.log.Warn("oidc: discovery failed, local login still available", "issuer", p.cfg.Issuer, "err", err)
		return p.lastErr
	}
	p.verifier = prov.Verifier(&gooidc.Config{ClientID: p.cfg.ClientID})
	p.oauth = &oauth2.Config{
		ClientID:     p.cfg.ClientID,
		ClientSecret: p.cfg.ClientSecret,
		Endpoint:     prov.Endpoint(),
		RedirectURL:  p.cfg.RedirectURL,
		Scopes:       p.cfg.Scopes,
	}
	p.lastErr = nil
	p.log.Info("oidc: provider ready", "issuer", p.cfg.Issuer, "scopes", p.cfg.Scopes)
	return nil
}

// AuthCodeURL starts a login. It returns the provider URL to redirect to and
// the state cookie that must be set alongside it.
func (p *Provider) AuthCodeURL(ctx context.Context, r *http.Request, redirectAfter string) (string, *http.Cookie, error) {
	if err := p.ensure(ctx); err != nil {
		return "", nil, err
	}
	nonce, err := randomString(24)
	if err != nil {
		return "", nil, err
	}
	stateVal, err := randomString(24)
	if err != nil {
		return "", nil, err
	}
	verifier := oauth2.GenerateVerifier()

	st := state{
		State:    stateVal,
		Nonce:    nonce,
		Verifier: verifier,
		Redirect: SanitizeRedirect(redirectAfter),
		Expires:  time.Now().Add(stateTTL).Unix(),
	}
	cookie, err := st.cookie(p.secret, p.secureCookies(r))
	if err != nil {
		return "", nil, err
	}

	p.mu.RLock()
	oc := *p.oauth
	p.mu.RUnlock()
	// A gateway that terminates TLS leaves the hub speaking plain HTTP. Deriving
	// the redirect from the forwarded headers keeps it https, which the provider
	// requires because it must match the registered callback exactly.
	if oc.RedirectURL == "" {
		oc.RedirectURL = ExternalBase(r, p.cfg.PublicURL) + CallbackPath
	}
	url := oc.AuthCodeURL(stateVal,
		gooidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
	)
	return url, cookie, nil
}

// Exchange completes the flow: it validates the state cookie, swaps the code
// for tokens, verifies the ID token and returns the identity plus the
// post-login redirect path.
func (p *Provider) Exchange(ctx context.Context, r *http.Request) (*Identity, string, error) {
	if err := p.ensure(ctx); err != nil {
		return nil, "", err
	}
	if e := r.URL.Query().Get("error"); e != "" {
		desc := r.URL.Query().Get("error_description")
		return nil, "", fmt.Errorf("provider returned %s: %s", e, desc)
	}
	c, err := r.Cookie(stateCookie)
	if err != nil {
		return nil, "", errors.New("missing login state cookie; the login may have taken too long, try again")
	}
	st, err := parseState(c.Value, p.secret)
	if err != nil {
		return nil, "", err
	}
	if st.State == "" || st.State != r.URL.Query().Get("state") {
		return nil, "", errors.New("login state mismatch")
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		return nil, "", errors.New("no authorization code in callback")
	}

	p.mu.RLock()
	oc := *p.oauth
	verifier := p.verifier
	p.mu.RUnlock()
	if oc.RedirectURL == "" {
		oc.RedirectURL = ExternalBase(r, p.cfg.PublicURL) + CallbackPath
	}

	ectx := gooidc.ClientContext(ctx, p.httpClient)
	tok, err := oc.Exchange(ectx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return nil, "", fmt.Errorf("code exchange: %w", err)
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		return nil, "", errors.New("provider did not return an id_token; check that the openid scope is granted")
	}
	idt, err := verifier.Verify(ectx, rawID)
	if err != nil {
		return nil, "", fmt.Errorf("verify id_token: %w", err)
	}
	if idt.Nonce != st.Nonce {
		return nil, "", errors.New("id_token nonce mismatch")
	}

	var claims map[string]any
	if err := idt.Claims(&claims); err != nil {
		return nil, "", fmt.Errorf("decode claims: %w", err)
	}
	id := p.identityFrom(idt.Subject, claims)

	// Some providers (notably Okta with a small id_token, or Entra) leave groups
	// out of the ID token. Fall back to the userinfo endpoint before giving up.
	if len(id.Groups) == 0 || id.Username == "" {
		if ui := p.userinfo(ectx, tok); ui != nil {
			merged := p.identityFrom(idt.Subject, ui)
			if id.Username == "" {
				id.Username = merged.Username
			}
			if id.Email == "" {
				id.Email = merged.Email
			}
			if id.Name == "" {
				id.Name = merged.Name
			}
			if len(id.Groups) == 0 {
				id.Groups = merged.Groups
			}
		}
	}
	if id.Username == "" {
		return nil, "", fmt.Errorf("the %q claim was empty; set KMATE_OIDC_USERNAME_CLAIM to a claim your provider sends", p.cfg.UsernameClaim)
	}
	return id, st.Redirect, nil
}

func (p *Provider) userinfo(ctx context.Context, tok *oauth2.Token) map[string]any {
	p.mu.RLock()
	oc := p.oauth
	p.mu.RUnlock()
	if oc == nil {
		return nil
	}
	dctx := gooidc.ClientContext(ctx, p.httpClient)
	prov, err := gooidc.NewProvider(dctx, p.cfg.Issuer)
	if err != nil {
		return nil
	}
	ui, err := prov.UserInfo(dctx, oauth2.StaticTokenSource(tok))
	if err != nil {
		return nil
	}
	var m map[string]any
	if err := ui.Claims(&m); err != nil {
		return nil
	}
	return m
}

func (p *Provider) identityFrom(subject string, claims map[string]any) *Identity {
	return &Identity{
		Subject:  subject,
		Username: strings.TrimSpace(claimString(claims, p.cfg.UsernameClaim)),
		Email:    strings.TrimSpace(claimString(claims, p.cfg.EmailClaim)),
		Name:     strings.TrimSpace(claimString(claims, p.cfg.NameClaim)),
		Groups:   claimStrings(claims, p.cfg.GroupsClaim),
	}
}

// RoleFor maps provider groups onto a KMate role. When no group mappings are
// configured every user gets the default role, which keeps the simple case
// simple: grant access per cluster afterwards.
func (c Config) RoleFor(groups []string) string {
	if len(c.AdminGroups) == 0 && len(c.OperatorGroups) == 0 && len(c.ViewerGroups) == 0 {
		return c.DefaultRole
	}
	has := func(want []string) bool {
		for _, w := range want {
			for _, g := range groups {
				if strings.EqualFold(strings.TrimSpace(w), strings.TrimSpace(g)) {
					return true
				}
			}
		}
		return false
	}
	switch {
	case has(c.AdminGroups):
		return "admin"
	case has(c.OperatorGroups):
		return "operator"
	case has(c.ViewerGroups):
		return "viewer"
	default:
		return c.DefaultRole
	}
}

func (p *Provider) secureCookies(r *http.Request) bool {
	return strings.HasPrefix(ExternalBase(r, p.cfg.PublicURL), "https://")
}

// ClearStateCookie expires the login state cookie.
func ClearStateCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name: stateCookie, Value: "", Path: "/auth/", MaxAge: -1,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode,
	}
}

// ExternalBase reconstructs the scheme://host the user's browser actually used.
//
// A gateway terminating TLS forwards plain HTTP to the hub, so building a
// redirect from the request alone yields http:// and the provider rejects it
// for not matching the registered callback. Honouring the forwarded headers is
// what makes KMate work behind an Istio or nginx ingress.
func ExternalBase(r *http.Request, fallback string) string {
	if r == nil {
		return strings.TrimRight(fallback, "/")
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if v := firstHeaderValue(r.Header.Get("X-Forwarded-Proto")); v != "" {
		scheme = v
	}
	host := r.Host
	if v := firstHeaderValue(r.Header.Get("X-Forwarded-Host")); v != "" {
		host = v
	}
	if host == "" {
		return strings.TrimRight(fallback, "/")
	}
	return scheme + "://" + host
}

func firstHeaderValue(v string) string {
	if v == "" {
		return ""
	}
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

// SanitizeRedirect keeps post-login redirects on this origin. Anything
// absolute, protocol-relative or empty collapses to "/".
func SanitizeRedirect(p string) string {
	if p == "" {
		return "/"
	}
	if strings.HasPrefix(p, "//") || strings.Contains(p, "://") {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		return "/"
	}
	// Block "/\evil.com" style tricks that some browsers normalise.
	if strings.HasPrefix(p, "/\\") {
		return "/"
	}
	return p
}

func claimString(m map[string]any, key string) string {
	if m == nil || key == "" {
		return ""
	}
	switch v := m[key].(type) {
	case string:
		return v
	case fmt.Stringer:
		return v.String()
	}
	return ""
}

func claimStrings(m map[string]any, key string) []string {
	if m == nil || key == "" {
		return nil
	}
	switch v := m[key].(type) {
	case []string:
		return v
	case string:
		if v == "" {
			return nil
		}
		// Some providers send a space- or comma-separated string.
		sep := " "
		if strings.Contains(v, ",") {
			sep = ","
		}
		var out []string
		for _, s := range strings.Split(v, sep) {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		return out
	case []any:
		var out []string
		for _, e := range v {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
