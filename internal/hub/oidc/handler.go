package oidc

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Directory is the subset of the user store the login flow needs.
type Directory interface {
	GetUserByEmail(ctx context.Context, email string) (*DirUser, error)
	CreateUser(ctx context.Context, u *DirUser) error
	UpdateUser(ctx context.Context, u *DirUser) error
	Audit(ctx context.Context, user, action, target, result string)
}

// DirUser is a store-agnostic view of an account.
type DirUser struct {
	ID        string
	Email     string
	Name      string
	Role      string
	K8sUser   string
	K8sGroups []string
	Active    bool
	OIDC      bool
}

// SessionIssuer mints the hub session token for a resolved account.
type SessionIssuer func(u *DirUser) (string, error)

// Handler serves /auth/config, /auth/oidc/login and /auth/oidc/callback.
type Handler struct {
	prov       *Provider
	dir        Directory
	issue      SessionIssuer
	localLogin bool
	log        *slog.Logger
}

// NewHandler wires the flow together. prov may be nil when OIDC is unconfigured;
// /auth/config is still served so the UI knows to show only the password form.
func NewHandler(prov *Provider, dir Directory, issue SessionIssuer, localLogin bool, log *slog.Logger) *Handler {
	return &Handler{prov: prov, dir: dir, issue: issue, localLogin: localLogin, log: log}
}

// Register mounts the routes.
func (h *Handler) Register(m *http.ServeMux) {
	m.HandleFunc("GET "+ConfigPath, h.config)
	m.HandleFunc("GET "+LoginPath, h.login)
	m.HandleFunc("GET "+CallbackPath, h.callback)
}

// authConfig is what the login page reads to decide what to render.
type authConfig struct {
	LocalLogin bool       `json:"localLogin"`
	OIDC       oidcConfig `json:"oidc"`
}

type oidcConfig struct {
	Enabled  bool   `json:"enabled"`
	Label    string `json:"label,omitempty"`
	LoginURL string `json:"loginUrl,omitempty"`
}

func (h *Handler) config(w http.ResponseWriter, r *http.Request) {
	cfg := authConfig{LocalLogin: h.localLogin}
	if h.prov != nil && h.prov.cfg.Enabled() {
		cfg.OIDC = oidcConfig{Enabled: true, Label: h.prov.Label(), LoginURL: LoginPath}
		// Warm discovery so the first real login is fast, but never block on it.
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = h.prov.ensure(ctx)
		}()
	}
	if !cfg.LocalLogin && !cfg.OIDC.Enabled {
		// Never lock everyone out because of a misconfiguration.
		cfg.LocalLogin = true
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(cfg)
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if h.prov == nil || !h.prov.cfg.Enabled() {
		http.Error(w, "OIDC is not configured on this hub", http.StatusNotFound)
		return
	}
	target, cookie, err := h.prov.AuthCodeURL(r.Context(), r, r.URL.Query().Get("redirect"))
	if err != nil {
		h.log.Error("oidc: cannot start login", "err", err)
		http.Error(w, "identity provider is unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	http.SetCookie(w, cookie)
	http.Redirect(w, r, target, http.StatusFound)
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	if h.prov == nil || !h.prov.cfg.Enabled() {
		http.Error(w, "OIDC is not configured on this hub", http.StatusNotFound)
		return
	}
	secure := strings.HasPrefix(ExternalBase(r, h.prov.cfg.PublicURL), "https://")
	http.SetCookie(w, ClearStateCookie(secure))

	id, redirect, err := h.prov.Exchange(r.Context(), r)
	if err != nil {
		h.log.Warn("oidc: login failed", "err", err)
		h.dir.Audit(r.Context(), "", "login.oidc", "", "denied: "+err.Error())
		h.fail(w, r, err)
		return
	}

	u, err := h.resolve(r.Context(), id)
	if err != nil {
		h.log.Warn("oidc: cannot resolve account", "user", id.Username, "err", err)
		h.dir.Audit(r.Context(), id.Username, "login.oidc", "", "denied: "+err.Error())
		h.fail(w, r, err)
		return
	}

	tok, err := h.issue(u)
	if err != nil {
		h.log.Error("oidc: cannot issue session", "err", err)
		h.fail(w, r, errors.New("could not start a session"))
		return
	}
	h.dir.Audit(r.Context(), u.Email, "login.oidc", "", "ok")

	// Hand the token to the SPA in the URL fragment: fragments are not sent to
	// servers and do not land in proxy or access logs the way a query string does.
	dest := SanitizeRedirect(redirect)
	sep := "#"
	http.Redirect(w, r, dest+sep+"token="+url.QueryEscape(tok), http.StatusFound)
}

// fail sends the user back to the login page with a readable reason.
func (h *Handler) fail(w http.ResponseWriter, r *http.Request, err error) {
	http.Redirect(w, r, "/login?error="+url.QueryEscape(err.Error()), http.StatusFound)
}

// resolve finds or provisions the account behind a verified identity.
func (h *Handler) resolve(ctx context.Context, id *Identity) (*DirUser, error) {
	cfg := h.prov.cfg
	email := id.Email
	if email == "" {
		email = id.Username
	}
	key := strings.ToLower(strings.TrimSpace(email))

	role := cfg.RoleFor(id.Groups)
	// The provider's groups become the Kubernetes groups the agent impersonates,
	// which is the whole point: the directory you already run decides what people
	// can do in the cluster.
	k8sGroups := append([]string(nil), id.Groups...)

	existing, err := h.dir.GetUserByEmail(ctx, key)
	if err == nil && existing != nil {
		if !existing.Active {
			return nil, errors.New("account is deactivated")
		}
		changed := false
		if id.Name != "" && existing.Name != id.Name {
			existing.Name = id.Name
			changed = true
		}
		if !existing.OIDC {
			existing.OIDC = true
			changed = true
		}
		// Only let the provider drive role and groups when the operator asked for
		// it; otherwise a local admin's carefully set role would be overwritten on
		// every login.
		if cfg.hasGroupMappings() && existing.Role != role {
			existing.Role = role
			changed = true
		}
		if !sameStrings(existing.K8sGroups, k8sGroups) {
			existing.K8sGroups = k8sGroups
			changed = true
		}
		if existing.K8sUser == "" && id.Username != "" {
			existing.K8sUser = id.Username
			changed = true
		}
		if changed {
			if err := h.dir.UpdateUser(ctx, existing); err != nil {
				return nil, err
			}
		}
		return existing, nil
	}

	if !cfg.AutoProvision {
		return nil, errors.New("no KMate account for " + key + " and auto-provisioning is disabled; ask an administrator to create one")
	}
	u := &DirUser{
		Email:     key,
		Name:      id.Name,
		Role:      role,
		K8sUser:   id.Username,
		K8sGroups: k8sGroups,
		Active:    true,
		OIDC:      true,
	}
	if err := h.dir.CreateUser(ctx, u); err != nil {
		return nil, err
	}
	h.dir.Audit(ctx, u.Email, "user.provision.oidc", u.Email, "ok: role "+u.Role)
	h.log.Info("oidc: provisioned user", "email", u.Email, "role", u.Role, "groups", u.K8sGroups)
	return u, nil
}

func (c Config) hasGroupMappings() bool {
	return len(c.AdminGroups) > 0 || len(c.OperatorGroups) > 0 || len(c.ViewerGroups) > 0
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
