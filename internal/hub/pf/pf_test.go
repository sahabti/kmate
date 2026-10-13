package pf

import (
	"bufio"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

func TestProxyIsolatesPodCodeAndCredentials(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := store.Open(ctx, "sqlite://"+filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := auth.New([]byte("secret"))
	token, err := a.Issue(&auth.Principal{ID: "u", Email: "a@x", Role: auth.RoleAdmin})
	if err != nil {
		t.Fatal(err)
	}
	one, two := mux.Pipe()
	defer mux.ClosePipe(one)
	hub, agent := mux.New(one, mux.Initiator), mux.New(two, mux.Responder)
	go hub.Run(ctx)
	go agent.Run(ctx)
	reg := registry.New()
	reg.Register(&registry.AgentConn{ClusterID: "c", Session: hub})
	requests := make(chan *http.Request, 1)
	go func() {
		stream, err := agent.Accept(ctx)
		if err != nil {
			t.Error(err)
			return
		}
		defer stream.Close(nil)
		if _, err := stream.Recv(ctx); err != nil {
			t.Error(err)
			return
		}
		r, err := http.ReadRequest(bufio.NewReader(&streamConn{ctx: ctx, st: stream}))
		if err != nil {
			t.Error(err)
			return
		}
		requests <- r
		response := "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 7\r\nSet-Cookie: stolen=x; Path=/\r\nService-Worker-Allowed: /\r\nContent-Security-Policy: sandbox allow-same-origin\r\n\r\n<p>x</p>"
		if err := stream.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Data{Data: &kmatev1.Data{Bytes: []byte(response)}}}); err != nil {
			t.Error(err)
		}
	}()
	h := New(a, relay.New(st, reg, slog.Default()), st, true, slog.Default())
	m := http.NewServeMux()
	h.Register(m)
	r := httptest.NewRequest("GET", "/pf/c/shop/pod/8080/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Cookie", "kmate_pf="+token)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("proxy failed: %d %s", w.Code, w.Body.String())
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "sandbox") || strings.Contains(csp, "allow-same-origin") {
		t.Fatalf("unsafe sandbox: %s", csp)
	}
	if w.Header().Get("Set-Cookie") != "" || w.Header().Get("Service-Worker-Allowed") != "" {
		t.Fatal("pod can change hub cookies or service worker scope")
	}
	select {
	case out := <-requests:
		if out.Header.Get("Authorization") != "" || out.Header.Get("Cookie") != "" {
			t.Fatal("credentials forwarded to pod")
		}
	case <-ctx.Done():
		t.Fatal("no request reached pod")
	}
}
