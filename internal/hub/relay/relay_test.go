package relay

import (
	"context"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

// fakeAgent answers List requests with one pod and pushes a catalog.
func fakeAgent(ctx context.Context, t *testing.T, conn mux.Conn) {
	sess := mux.New(conn, mux.Responder)
	go sess.Run(ctx)
	// push a catalog snapshot on an agent-initiated stream
	cs, _ := sess.Open()
	_ = cs.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Catalog{Catalog: &kmatev1.CatalogSnapshot{Catalog: &kmatev1.Catalog{Version: 3}}}})
	_ = cs.Close(nil)
	for {
		st, err := sess.Accept(ctx)
		if err != nil {
			return
		}
		go func() {
			f, err := st.Recv(ctx)
			if err != nil {
				return
			}
			req := f.GetRequest()
			if req.GetList() != nil {
				_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Response{Response: &kmatev1.Response{Kind: &kmatev1.Response_List{List: &kmatev1.ListResponse{Items: []*kmatev1.KubeObject{{Name: "pod-a", Namespace: "default"}}}}}}})
			} else if req.GetWatch() != nil {
				_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_WatchEvent{WatchEvent: &kmatev1.WatchEvent{Type: kmatev1.EventType_EVENT_TYPE_ADDED, Object: &kmatev1.KubeObject{Name: "p1"}}}})
				_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_WatchEvent{WatchEvent: &kmatev1.WatchEvent{Type: kmatev1.EventType_EVENT_TYPE_SYNC, Synced: true}}})
			} else {
				_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Response{Response: &kmatev1.Response{Error: &kmatev1.Error{Code: 404, Reason: "NotFound", Message: "nope"}}}})
			}
			_ = st.Close(nil)
		}()
	}
}

func TestRelayUnaryAndCatalog(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	st, err := store.Open(ctx, "sqlite://"+filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	c, _ := st.CreateCluster(ctx, "test")
	reg := registry.New()
	r := New(st, reg, slog.Default())

	hubEnd, agentEnd := mux.Pipe()
	go fakeAgent(ctx, t, agentEnd)

	sess := mux.New(hubEnd, mux.Initiator)
	go sess.Run(ctx)
	conn := &registry.AgentConn{ClusterID: c.ID, Session: sess}
	conn.Touch(nil)
	reg.Register(conn)
	go r.acceptLoop(ctx, conn)

	resp, err := r.Unary(ctx, c.ID, &kmatev1.Request{Kind: &kmatev1.Request_List{List: &kmatev1.ListRequest{}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.GetList().GetItems()) != 1 || resp.GetList().GetItems()[0].Name != "pod-a" {
		t.Fatalf("bad list %v", resp)
	}

	if _, err := r.Unary(ctx, c.ID, &kmatev1.Request{Kind: &kmatev1.Request_Get{Get: &kmatev1.GetRequest{}}}); err == nil {
		t.Fatal("expected not found error")
	}

	// streaming
	ws, err := r.Stream(ctx, c.ID, &kmatev1.Request{Kind: &kmatev1.Request_Watch{Watch: &kmatev1.WatchRequest{}}})
	if err != nil {
		t.Fatal(err)
	}
	var events int
	for {
		f, err := ws.Recv(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if f.GetClose() != nil {
			break
		}
		if f.GetWatchEvent() != nil {
			events++
		}
	}
	if events != 2 {
		t.Fatalf("expected 2 watch events, got %d", events)
	}

	// catalog snapshot was persisted
	deadline := time.Now().Add(3 * time.Second)
	for {
		cat, err := st.GetCatalog(ctx, c.ID)
		if err == nil && cat.Version == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("catalog not persisted: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}

	if _, err := r.Unary(ctx, "missing", &kmatev1.Request{}); err == nil {
		t.Fatal("expected offline error")
	}
}
