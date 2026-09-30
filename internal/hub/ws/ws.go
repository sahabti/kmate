// Package ws exposes WebSocket endpoints for exec, port-forward and multiplexed
// resource watches (see watch.go). Exec/port-forward need bidirectional byte
// streams from browsers, which Connect cannot provide.
//
// Wire format (binary frames):
//
//	client -> hub: [channel byte][bytes]; channel 0 = stdin, 0xFF = resize (JSON {"cols","rows"})
//	hub -> client: [channel byte][bytes]; channel 1 = stdout, 2 = stderr
package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"

	"github.com/coder/websocket"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/api"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

const (
	chanStdin  byte = 0
	chanStdout byte = 1
	chanStderr byte = 2
	chanResize byte = 0xFF
)

// Handler serves the WebSocket routes.
type Handler struct {
	auth    *auth.Authenticator
	relay   *relay.Relay
	store   *store.Store
	log     *slog.Logger
	origins []string

	watchSockets atomic.Int64
	watchSubs    atomic.Int64
}

// New creates a handler.
func New(a *auth.Authenticator, rl *relay.Relay, st *store.Store, origins []string, log *slog.Logger) *Handler {
	return &Handler{auth: a, relay: rl, store: st, origins: origins, log: log}
}

// Register mounts routes on mux.
func (h *Handler) Register(m *http.ServeMux) {
	m.HandleFunc("GET /ws/clusters/{id}/exec", h.exec)
	m.HandleFunc("GET /ws/clusters/{id}/portforward", h.portForward)
	m.HandleFunc("GET /ws/clusters/{id}/watch", h.watch)
}

func (h *Handler) accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, *auth.Principal, bool) {
	p, err := h.auth.FromHTTP(r)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return nil, nil, false
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.originPatterns()})
	if err != nil {
		return nil, nil, false
	}
	c.SetReadLimit(4 << 20)
	return c, p, true
}

func (h *Handler) originPatterns() []string {
	out := []string{}
	for _, o := range h.origins {
		if o == "*" {
			return []string{"*"}
		}
		// strip scheme for websocket origin matching
		for _, pre := range []string{"https://", "http://", "tauri://"} {
			if len(o) > len(pre) && o[:len(pre)] == pre {
				o = o[len(pre):]
			}
		}
		out = append(out, o)
	}
	return out
}

func (h *Handler) exec(w http.ResponseWriter, r *http.Request) {
	c, p, ok := h.accept(w, r)
	if !ok {
		return
	}
	defer c.CloseNow()
	if !p.CanWrite() {
		c.Close(websocket.StatusPolicyViolation, "role cannot exec")
		return
	}
	q := r.URL.Query()
	clusterID := r.PathValue("id")
	cols, _ := strconv.Atoi(q.Get("cols"))
	rows, _ := strconv.Atoi(q.Get("rows"))
	cmd := q["cmd"]
	if len(cmd) == 0 {
		cmd = []string{"/bin/sh"}
	}
	req := api.NewRequest(auth.WithPrincipal(r.Context(), p))
	req.Kind = &kmatev1.Request_Exec{Exec: &kmatev1.ExecRequest{
		Namespace: q.Get("namespace"), Pod: q.Get("pod"), Container: q.Get("container"),
		Command: cmd, Tty: q.Get("tty") != "0", Stdin: true, Cols: int32(cols), Rows: int32(rows),
	}}
	_ = h.store.Audit(r.Context(), store.AuditEvent{User: p.Email, ClusterID: clusterID, Action: "exec", Target: q.Get("namespace") + "/" + q.Get("pod"), Result: "ok"})
	h.pump(r.Context(), c, clusterID, req, true)
}

func (h *Handler) portForward(w http.ResponseWriter, r *http.Request) {
	c, p, ok := h.accept(w, r)
	if !ok {
		return
	}
	defer c.CloseNow()
	q := r.URL.Query()
	clusterID := r.PathValue("id")
	port, _ := strconv.Atoi(q.Get("port"))
	req := api.NewRequest(auth.WithPrincipal(r.Context(), p))
	req.Kind = &kmatev1.Request_PortForward{PortForward: &kmatev1.PortForwardRequest{Namespace: q.Get("namespace"), Pod: q.Get("pod"), Port: int32(port)}}
	_ = h.store.Audit(r.Context(), store.AuditEvent{User: p.Email, ClusterID: clusterID, Action: "port-forward", Target: q.Get("namespace") + "/" + q.Get("pod") + ":" + q.Get("port"), Result: "ok"})
	h.pump(r.Context(), c, clusterID, req, false)
}

// pump relays bytes between the websocket and an agent stream.
func (h *Handler) pump(ctx context.Context, c *websocket.Conn, clusterID string, req *kmatev1.Request, allowResize bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	st, err := h.relay.Stream(ctx, clusterID, req)
	if err != nil {
		c.Close(websocket.StatusInternalError, truncate(err.Error()))
		return
	}
	defer st.Close(nil)

	// agent -> client
	go func() {
		defer cancel()
		for {
			f, err := st.Recv(ctx)
			if err != nil {
				return
			}
			switch p := f.Payload.(type) {
			case *kmatev1.Frame_Data:
				ch := byte(p.Data.GetChannel())
				if ch == 0 {
					ch = chanStdout
				}
				buf := append([]byte{ch}, p.Data.GetBytes()...)
				if err := c.Write(ctx, websocket.MessageBinary, buf); err != nil {
					return
				}
				if p.Data.GetEof() {
					c.Close(websocket.StatusNormalClosure, "eof")
					return
				}
			case *kmatev1.Frame_Response:
				if e := p.Response.GetError(); e != nil {
					c.Close(websocket.StatusInternalError, truncate(e.GetMessage()))
					return
				}
			case *kmatev1.Frame_Close:
				if e := mux.CloseError(f); e != nil {
					c.Close(websocket.StatusInternalError, truncate(e.Error()))
				} else {
					c.Close(websocket.StatusNormalClosure, "closed")
				}
				return
			}
		}
	}()

	// client -> agent
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(data) == 0 {
			continue
		}
		ch, payload := data[0], data[1:]
		if ch == chanResize && allowResize {
			var rs struct {
				Cols int32 `json:"cols"`
				Rows int32 `json:"rows"`
			}
			if json.Unmarshal(payload, &rs) == nil {
				_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Resize{Resize: &kmatev1.Resize{Cols: rs.Cols, Rows: rs.Rows}}})
			}
			continue
		}
		if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Bytes: payload, Channel: int32(chanStdin)}}}); err != nil {
			return
		}
	}
}

func truncate(s string) string {
	if len(s) > 120 {
		return s[:120]
	}
	return s
}
