package oidc

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoleForGroups(t *testing.T) {
	c := Config{
		DefaultRole:    "viewer",
		AdminGroups:    []string{"platform-admins"},
		OperatorGroups: []string{"sre", "oncall"},
		ViewerGroups:   []string{"everyone"},
	}
	cases := map[string]struct {
		groups []string
		want   string
	}{
		"admin wins":        {[]string{"everyone", "sre", "platform-admins"}, "admin"},
		"operator":          {[]string{"everyone", "oncall"}, "operator"},
		"viewer":            {[]string{"everyone"}, "viewer"},
		"unmapped defaults": {[]string{"randoms"}, "viewer"},
		"case insensitive":  {[]string{"Platform-Admins"}, "admin"},
		"no groups":         {nil, "viewer"},
	}
	for name, tc := range cases {
		if got := c.RoleFor(tc.groups); got != tc.want {
			t.Errorf("%s: got %q want %q", name, got, tc.want)
		}
	}

	// With no mappings configured everyone lands on the default role, so the
	// simple deployment does not need to model groups at all.
	plain := Config{DefaultRole: "operator"}
	if got := plain.RoleFor([]string{"platform-admins"}); got != "operator" {
		t.Errorf("unmapped config: got %q want operator", got)
	}
}

func TestSanitizeRedirect(t *testing.T) {
	cases := map[string]string{
		"":                    "/",
		"/":                   "/",
		"/c/abc/realm":        "/c/abc/realm",
		"//evil.com":          "/",
		"https://evil.com":    "/",
		"http://evil.com/x":   "/",
		"javascript:alert(1)": "/",
		"/\\evil.com":         "/",
		"relative/path":       "/",
		"/settings?tab=users": "/settings?tab=users",
	}
	for in, want := range cases {
		if got := SanitizeRedirect(in); got != want {
			t.Errorf("SanitizeRedirect(%q) = %q, want %q", in, got, want)
		}
	}
}

// A gateway that terminates TLS forwards plain HTTP to the hub. If the redirect
// is built from the request alone it comes out http:// and the provider rejects
// it for not matching the registered callback. This is the documented Headlamp
// failure, so it is worth a test.
func TestExternalBaseHonoursForwardedHeaders(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "http://kmate-hub.svc:8080/auth/oidc/login", nil)
	r.Header.Set("X-Forwarded-Proto", "https")
	r.Header.Set("X-Forwarded-Host", "kmate.example.com")
	if got, want := ExternalBase(r, "http://fallback"), "https://kmate.example.com"; got != want {
		t.Errorf("got %q want %q", got, want)
	}

	// Multi-hop proxies append, so only the first value counts.
	r2 := httptest.NewRequest(http.MethodGet, "http://internal/auth", nil)
	r2.Header.Set("X-Forwarded-Proto", "https, http")
	r2.Header.Set("X-Forwarded-Host", "kmate.example.com, internal")
	if got, want := ExternalBase(r2, ""), "https://kmate.example.com"; got != want {
		t.Errorf("multi-hop: got %q want %q", got, want)
	}

	// With no forwarded headers the request's own host is used.
	r3 := httptest.NewRequest(http.MethodGet, "http://localhost:8080/auth", nil)
	if got, want := ExternalBase(r3, ""), "http://localhost:8080"; got != want {
		t.Errorf("plain: got %q want %q", got, want)
	}
}

func TestStateCookieRoundTrip(t *testing.T) {
	secret := []byte("test-secret")
	st := state{State: "abc", Nonce: "n1", Verifier: "v1", Redirect: "/c/x", Expires: 1 << 40}
	c, err := st.cookie(secret, true)
	if err != nil {
		t.Fatal(err)
	}
	if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode {
		t.Errorf("cookie flags wrong: %+v", c)
	}
	got, err := parseState(c.Value, secret)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "abc" || got.Nonce != "n1" || got.Verifier != "v1" || got.Redirect != "/c/x" {
		t.Errorf("round trip lost data: %+v", got)
	}

	// A tampered payload must not verify.
	if _, err := parseState("eyJzIjoiZXZpbCJ9."+"badsig", secret); err == nil {
		t.Error("expected signature mismatch")
	}
	// Nor should a valid cookie signed with a different secret.
	if _, err := parseState(c.Value, []byte("other")); err == nil {
		t.Error("expected rejection under a different secret")
	}
	// Expired state is refused.
	old := state{State: "a", Expires: 1}
	oc, _ := old.cookie(secret, false)
	if _, err := parseState(oc.Value, secret); err == nil {
		t.Error("expected expiry rejection")
	}
}

func TestClaimExtraction(t *testing.T) {
	p := &Provider{cfg: Config{UsernameClaim: "preferred_username", EmailClaim: "email", NameClaim: "name", GroupsClaim: "groups"}}

	// Keycloak shape: groups as a JSON array.
	id := p.identityFrom("sub-1", map[string]any{
		"preferred_username": "alice",
		"email":              "alice@example.com",
		"name":               "Alice",
		"groups":             []any{"/platform", "sre"},
	})
	if id.Username != "alice" || id.Email != "alice@example.com" || len(id.Groups) != 2 {
		t.Errorf("array groups: %+v", id)
	}

	// Some providers send a space-separated string instead.
	id2 := p.identityFrom("sub-2", map[string]any{"preferred_username": "bob", "groups": "sre oncall"})
	if len(id2.Groups) != 2 || id2.Groups[0] != "sre" {
		t.Errorf("string groups: %+v", id2.Groups)
	}

	// And some use commas.
	id3 := p.identityFrom("sub-3", map[string]any{"preferred_username": "carol", "groups": "a, b ,c"})
	if len(id3.Groups) != 3 || id3.Groups[2] != "c" {
		t.Errorf("comma groups: %+v", id3.Groups)
	}

	// A missing groups claim is not an error, it just means no groups.
	id4 := p.identityFrom("sub-4", map[string]any{"preferred_username": "dave"})
	if len(id4.Groups) != 0 || id4.Username != "dave" {
		t.Errorf("absent groups: %+v", id4)
	}
}

func TestButtonLabelFromIssuer(t *testing.T) {
	cases := map[string]string{
		"https://keycloak.example.com/realms/kmate": "Sign in with Keycloak",
		"https://example.okta.com":                  "Sign in with Okta",
		"https://authentik.corp.net/application/o/": "Sign in with Authentik",
		"https://accounts.google.com":               "Sign in with Google",
		"https://sso.acme.io":                       "Sign in with Sso",
	}
	for issuer, want := range cases {
		if got := labelForIssuer(issuer); got != want {
			t.Errorf("labelForIssuer(%q) = %q, want %q", issuer, got, want)
		}
	}
}

func TestConfigDefaults(t *testing.T) {
	c := Config{Issuer: "https://keycloak.example.com/realms/x", ClientID: "kmate", PublicURL: "https://kmate.example.com/"}.withDefaults()
	if c.RedirectURL != "https://kmate.example.com/auth/oidc/callback" {
		t.Errorf("redirect: %q", c.RedirectURL)
	}
	if c.UsernameClaim != "email" || c.GroupsClaim != "groups" || c.DefaultRole != "viewer" {
		t.Errorf("claim defaults wrong: %+v", c)
	}
	// Standard scopes only: "groups" is provider-specific and breaks Keycloak.
	if len(c.Scopes) != 3 || c.Scopes[0] != "openid" {
		t.Errorf("scopes: %v", c.Scopes)
	}
	if !c.Enabled() {
		t.Error("should be enabled")
	}
	if (Config{Issuer: "x"}).Enabled() {
		t.Error("issuer without client id must not enable OIDC")
	}
}
