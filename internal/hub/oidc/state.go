package oidc

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// state is the short-lived login context. It rides in a signed, HttpOnly
// cookie rather than server memory so a multi-replica hub needs no shared
// session store for the few seconds a login takes.
type state struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"` // PKCE code verifier
	Redirect string `json:"r"`
	Expires  int64  `json:"e"`
}

func (s state) cookie(secret []byte, secure bool) (*http.Cookie, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	payload := base64.RawURLEncoding.EncodeToString(b)
	value := payload + "." + sign(payload, secret)
	return &http.Cookie{
		Name:     stateCookie,
		Value:    value,
		Path:     "/auth/",
		MaxAge:   int(stateTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode, // Lax: the provider redirects back cross-site
	}, nil
}

func parseState(raw string, secret []byte) (*state, error) {
	payload, sig, ok := strings.Cut(raw, ".")
	if !ok {
		return nil, errors.New("malformed login state")
	}
	if !hmac.Equal([]byte(sig), []byte(sign(payload, secret))) {
		return nil, errors.New("login state signature mismatch")
	}
	b, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, errors.New("malformed login state")
	}
	var s state
	if err := json.Unmarshal(b, &s); err != nil {
		return nil, errors.New("malformed login state")
	}
	if s.Expires != 0 && time.Now().Unix() > s.Expires {
		return nil, errors.New("login state expired; please try again")
	}
	return &s, nil
}

func sign(payload string, secret []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func insecureTLS() *tls.Config {
	return &tls.Config{InsecureSkipVerify: true} //nolint:gosec // opt-in, dev only
}
