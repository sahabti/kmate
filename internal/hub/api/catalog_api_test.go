package api

import (
	"connectrpc.com/connect"
	"context"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"testing"
)

func TestCatalogFiltersNamespaceGrant(t *testing.T) {
	f := newFixture(t)
	cat := &kmatev1.Catalog{Version: 3, Entries: []*kmatev1.CatalogEntry{{Namespace: "shop", Name: "allowed"}, {Namespace: "kube-system", Name: "hidden"}}}
	if err := f.st.SaveCatalog(context.Background(), f.cID, cat); err != nil {
		t.Fatal(err)
	}
	resp, err := f.cluster.GetCatalog(f.as(t, "viewer@x"), connect.NewRequest(&kmatev1.ClusterCatalogRequest{ClusterId: f.cID}))
	if err != nil {
		t.Fatal(err)
	}
	if entries := resp.Msg.GetCatalog().GetEntries(); len(entries) != 1 || entries[0].Namespace != "shop" {
		t.Fatalf("catalog leaks namespaces: %v", entries)
	}
	admin, err := f.cluster.GetCatalog(f.as(t, "admin@x"), connect.NewRequest(&kmatev1.ClusterCatalogRequest{ClusterId: f.cID}))
	if err != nil || len(admin.Msg.GetCatalog().GetEntries()) != 2 {
		t.Fatalf("filter altered shared snapshot: %v", err)
	}
}
