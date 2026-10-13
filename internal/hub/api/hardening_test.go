package api

import (
	"context"
	"encoding/json"
	"testing"

	"connectrpc.com/connect"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/auth"
)

func TestApplyAuthorizesPayloadIdentity(t *testing.T) {
	f := newFixture(t)
	mustGrant(t, f.st, f.ids["operator@x"], f.cID, auth.RoleOperator, []string{"shop"})
	for _, tc := range []struct {
		name, envelopeNS, bodyNS string
		want                     connect.Code
	}{
		{"spoofed namespace", "shop", "kube-system", connect.CodeInvalidArgument},
		{"outside grant", "kube-system", "kube-system", connect.CodePermissionDenied},
		{"inside grant", "shop", "shop", connect.CodeUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": "s", "namespace": tc.bodyNS}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.cluster.Apply(f.as(t, "operator@x"), connect.NewRequest(&kmatev1.ClusterApplyRequest{ClusterId: f.cID, Apply: &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{Json: body, ApiVersion: "v1", Kind: "Secret", Name: "s", Namespace: tc.envelopeNS}}}))
			if connect.CodeOf(err) != tc.want {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestPasswordEndpointRespectsDisabledLogin(t *testing.T) {
	f := newFixture(t)
	f.hub.cfg.DisableLocalLogin = true
	_, err := f.hub.Login(context.Background(), connect.NewRequest(&kmatev1.LoginRequest{Email: "admin@x", Password: "anything"}))
	if connect.CodeOf(err) != connect.CodePermissionDenied {
		t.Fatalf("password login not disabled: %v", err)
	}
}

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
