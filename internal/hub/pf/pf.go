// Package pf exposes an authenticated HTTP proxy to pod ports for web and
// mobile clients that cannot open a local listener. Each incoming HTTP
// request becomes one port-forward stream to the agent; the raw request is
// written to the pod and the raw response is streamed back.
//
//	POST /pf/session                                  bearer → HttpOnly cookie for /pf/
//	ANY  /pf/{clusterId}/{namespace}/{pod}/{port}/{rest...}
//
// Limits: plaintext HTTP to the pod only, one request per tunnel stream
// (Connection: close), no WebSocket upgrade passthrough, and pages that use
// absolute paths or absolute-path redirects will not resolve under the /pf/
// prefix. Good for admin UIs and APIs; not a general reverse proxy.
package pf

import (
	"bufio"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/api"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

const (
	cookieName = "kmate_pf"
	cookieTTL  = time.Hour
)

// Handler serves the proxy.
type Handler struct {
	auth   *auth.Authenticator
	relay  *relay.Relay
	store  *store.Store
	log    *slog.Logger
	secure bool
}

// New creates a handler. secure controls the cookie's Secure flag.
func New(a *auth.Authenticator, rl *relay.Relay, st *store.Store, secure bool, log *slog.Logger) *Handler {
	return &Handler{auth: a, relay: rl, store: st, secure: secure, log: log}
}

// Register mounts routes.
func (h *Handler) Register(m *http.ServeMux) {
	m.HandleFunc("POST /pf/session", h.session)
	m.HandleFunc("DELETE /pf/session", h.clearSession)
	m.HandleFunc("/pf/{clusterId}/{namespace}/{pod}/{port}/{rest...}", h.proxy)
	m.HandleFunc("/pf/{clusterId}/{namespace}/{pod}/{port}", h.redirectSlash)
}

// session exchanges a bearer token for a cookie scoped to /pf/, so plain
// browser navigations (iframes, links, images) can authenticate.
func (h *Handler) session(w http.ResponseWriter, r *http.Request) {
	p, err := h.auth.FromHTTP(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	tok, err := h.auth.IssueFor(p, cookieTTL)
	if err != nil {
		http.Error(w, "cannot issue session", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: tok, Path: "/pf/", HttpOnly: true, Secure: h.secure,
		SameSite: http.SameSiteLaxMode, MaxAge: int(cookieTTL.Seconds()),
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) clearSession(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/pf/", HttpOnly: true, MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) principal(r *http.Request) (*auth.Principal, error) {
	if p, err := h.auth.FromHTTP(r); err == nil {
		return p, nil
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, auth.ErrUnauthenticated
	}
	return h.auth.Verify(c.Value)
}

func (h *Handler) redirectSlash(w http.ResponseWriter, r *http.Request) {
	u := *r.URL
	u.Path += "/"
	http.Redirect(w, r, u.String(), http.StatusTemporaryRedirect)
}

func (h *Handler) proxy(w http.ResponseWriter, r *http.Request) {
	p, err := h.principal(r)
	if err != nil {
		http.Error(w, "unauthorized: call POST /pf/session with your bearer token first", http.StatusUnauthorized)
		return
	}
	clusterID := r.PathValue("clusterId")
	ns, pod := r.PathValue("namespace"), r.PathValue("pod")
	port, err := strconv.Atoi(r.PathValue("port"))
	if err != nil || port <= 0 || port > 65535 {
		http.Error(w, "bad port", http.StatusBadRequest)
		return
	}
	rest := "/" + r.PathValue("rest")
	if r.URL.RawQuery != "" {
		rest += "?" + r.URL.RawQuery
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	req := api.NewRequest(auth.WithPrincipal(ctx, p))
	req.Kind = &kmatev1.Request_PortForward{PortForward: &kmatev1.PortForwardRequest{Namespace: ns, Pod: pod, Port: int32(port)}}
	st, err := h.relay.Stream(ctx, clusterID, req)
	if err != nil {
		_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: clusterID, Action: "port-forward", Target: ns + "/" + pod + ":" + strconv.Itoa(port), Result: "error: " + err.Error()})
		http.Error(w, "cluster unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer st.Close(nil)
	_ = h.store.Audit(ctx, store.AuditEvent{User: p.Email, ClusterID: clusterID, Action: "port-forward", Target: ns + "/" + pod + ":" + strconv.Itoa(port) + " " + r.Method + " " + rest, Result: "ok"})

	conn := &streamConn{ctx: ctx, st: st}

	// Write the request to the pod.
	out, err := http.NewRequestWithContext(ctx, r.Method, "http://"+pod+":"+strconv.Itoa(port)+rest, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out.Host = pod + ":" + strconv.Itoa(port)
	out.Header = r.Header.Clone()
	for _, hh := range hopByHop {
		out.Header.Del(hh)
	}
	out.Header.Del("Cookie") // never leak the hub session to the pod
	out.Header.Set("Connection", "close")
	out.Header.Set("X-Forwarded-Prefix", strings.TrimSuffix(r.URL.Path, strings.TrimPrefix(rest, "/")))
	out.ContentLength = r.ContentLength
	if err := out.Write(conn); err != nil {
		http.Error(w, "write to pod: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Read the response.
	br := bufio.NewReaderSize(conn, 64<<10)
	resp, err := http.ReadResponse(br, out)
	if err != nil {
		http.Error(w, "read from pod: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	hdr := w.Header()
	for k, vs := range resp.Header {
		if isHopByHop(k) {
			continue
		}
		for _, v := range vs {
			hdr.Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr != nil {
			return
		}
	}
}

var hopByHop = []string{"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailers", "Transfer-Encoding", "Upgrade"}

func isHopByHop(k string) bool {
	for _, h := range hopByHop {
		if strings.EqualFold(h, k) {
			return true
		}
	}
	return false
}

// streamConn adapts a relayed port-forward stream to io.ReadWriter.
type streamConn struct {
	ctx  context.Context
	st   *mux.Stream
	rbuf []byte
	eof  bool
}

func (c *streamConn) Write(p []byte) (int, error) {
	const chunk = 256 << 10
	for off := 0; off < len(p); off += chunk {
		end := off + chunk
		if end > len(p) {
			end = len(p)
		}
		b := make([]byte, end-off)
		copy(b, p[off:end])
		if err := c.st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Bytes: b}}}); err != nil {
			return off, err
		}
	}
	return len(p), nil
}

func (c *streamConn) Read(p []byte) (int, error) {
	for len(c.rbuf) == 0 {
		if c.eof {
			return 0, io.EOF
		}
		f, err := c.st.Recv(c.ctx)
		if err != nil {
			return 0, io.EOF
		}
		switch x := f.Payload.(type) {
		case *kmatev1.Frame_Data:
			c.rbuf = x.Data.GetBytes()
			if x.Data.GetEof() {
				c.eof = true
			}
		case *kmatev1.Frame_Response:
			if e := x.Response.GetError(); e != nil {
				return 0, errors.New(e.GetMessage())
			}
		case *kmatev1.Frame_Close:
			if e := mux.CloseError(f); e != nil && len(c.rbuf) == 0 {
				return 0, e
			}
			c.eof = true
		}
	}
	n := copy(p, c.rbuf)
	c.rbuf = c.rbuf[n:]
	return n, nil
}
