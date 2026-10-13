package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
)

func TestWatchFiltersCatalogAndClosesOnRevocation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	st, err := store.Open(ctx, "sqlite://"+filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	u := &store.User{Email: "a@x", Role: auth.RoleViewer, Active: true}
	if err := st.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	cluster, err := st.CreateCluster(ctx, "c")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetGrant(ctx, &store.Grant{UserID: u.ID, ClusterID: cluster.ID, Role: auth.RoleViewer, Namespaces: []string{"shop"}}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveCatalog(ctx, cluster.ID, &kmatev1.Catalog{Entries: []*kmatev1.CatalogEntry{{Namespace: "shop"}, {Namespace: "private"}}}); err != nil {
		t.Fatal(err)
	}
	a := auth.New([]byte("secret")).WithDirectory(st)
	token, err := a.Issue(&auth.Principal{ID: u.ID, Email: u.Email, Role: u.Role})
	if err != nil {
		t.Fatal(err)
	}
	h := New(a, relay.New(st, registry.New(), slog.Default()), st, nil, slog.Default())
	m := http.NewServeMux()
	h.Register(m)
	server := httptest.NewServer(m)
	defer server.Close()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/clusters/"+cluster.ID+"/watch", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageText, []byte(`{"op":"sub","id":"catalog","kind":"catalog"}`)); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var msg struct {
		Catalog struct{ Entries []struct{ Namespace string } }
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatal(err)
	}
	if len(msg.Catalog.Entries) != 1 || msg.Catalog.Entries[0].Namespace != "shop" {
		t.Fatalf("catalog leaked: %s", data)
	}
	if err := st.DeleteGrant(ctx, u.ID, cluster.ID); err != nil {
		t.Fatal(err)
	}
	a.Invalidate(u.ID)
	readCtx, readCancel := context.WithTimeout(ctx, time.Second)
	defer readCancel()
	if _, _, err := c.Read(readCtx); err == nil {
		t.Fatal("revoked websocket stayed open")
	}
	if readCtx.Err() != nil {
		t.Fatal("socket only stopped because test timed out")
	}
}
