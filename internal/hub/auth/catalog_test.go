package auth

import (
	"context"
	"testing"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

func TestFilterCatalogPreservesSharedSnapshot(t *testing.T) {
	cat := &kmatev1.Catalog{Version: 4, Entries: []*kmatev1.CatalogEntry{{Namespace: "shop", Name: "allowed"}, {Namespace: "private", Name: "hidden"}}}
	for _, tc := range []struct {
		name      string
		principal *Principal
		want      int
	}{
		{"anonymous", nil, 0}, {"ungranted", viewerOn("other"), 0},
		{"limited", viewerOn("c", "shop"), 1}, {"admin", &Principal{Role: RoleAdmin}, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := FilterCatalog(WithPrincipal(context.Background(), tc.principal), "c", cat)
			if len(out.Entries) != tc.want || out.Version != 4 {
				t.Fatalf("filtered catalog: %v", out)
			}
			if len(out.Entries) > 0 {
				out.Entries[0].Name = "changed"
			}
			if len(cat.Entries) != 2 || cat.Entries[0].Name != "allowed" {
				t.Fatal("shared catalog was mutated")
			}
		})
	}
	if out := FilterCatalog(context.Background(), "c", nil); out == nil || len(out.Entries) != 0 {
		t.Fatal("nil catalog was not empty")
	}
}
