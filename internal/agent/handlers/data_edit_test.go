package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/rest"
)

func TestDataEditExplicitlyDeletesForeignOwnedKeys(t *testing.T) {
	for _, kind := range []string{"Secret", "ConfigMap"} {
		for _, dryRun := range []bool{false, true} {
			t.Run(kind+map[bool]string{true: "/dry-run", false: "/save"}[dryRun], func(t *testing.T) {
				var patched atomic.Bool
				current := map[string]interface{}{"apiVersion": "v1", "kind": kind, "metadata": map[string]interface{}{"name": "s", "namespace": "shop", "resourceVersion": "12", "managedFields": []interface{}{map[string]interface{}{"manager": "helm"}}}, "data": map[string]interface{}{"keep": "a2VlcA==", "remove": "cmVtb3Zl"}}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Method == "PATCH" {
						patched.Store(true)
						if r.Header.Get("Content-Type") != "application/merge-patch+json" {
							t.Error("expected explicit merge patch")
						}
						var patch map[string]interface{}
						if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
							t.Error(err)
						}
						data := patch["data"].(map[string]interface{})
						if value, exists := data["remove"]; !exists || value != nil {
							t.Error("missing explicit deletion")
						}
						if data["added"] != "YWRk" {
							t.Error("addition missing")
						}
						if _, exists := data["keep"]; exists {
							t.Error("unchanged data was overwritten")
						}
						if patch["metadata"].(map[string]interface{})["resourceVersion"] != "12" {
							t.Error("missing version precondition")
						}
						if (r.URL.Query().Get("dryRun") == "All") != dryRun {
							t.Error("dry-run was not propagated")
						}
					}
					w.Header().Set("Content-Type", "application/json")
					if err := json.NewEncoder(w).Encode(current); err != nil {
						t.Error(err)
					}
				}))
				defer server.Close()
				clients, err := kube.FromConfig(&rest.Config{Host: server.URL}, kube.Options{})
				if err != nil {
					t.Fatal(err)
				}
				desired := &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": "v1", "kind": kind, "metadata": map[string]interface{}{"name": "s", "namespace": "shop"}, "data": map[string]interface{}{"keep": "a2VlcA==", "added": "YWRk"}}}
				resource := "secrets"
				if kind == "ConfigMap" {
					resource = "configmaps"
				}
				h := &Handler{Clients: clients}
				_, err = h.applyDataEdit(context.Background(), &kmatev1.Request{}, &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{ResourceVersion: "12"}, DryRun: dryRun}, desired, schema.GroupVersionResource{Version: "v1", Resource: resource})
				if err != nil || !patched.Load() {
					t.Fatalf("edit failed: %v, patched=%t", err, patched.Load())
				}
				patched.Store(false)
				_, err = h.applyDataEdit(context.Background(), &kmatev1.Request{}, &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{ResourceVersion: "11"}}, desired, schema.GroupVersionResource{Version: "v1", Resource: resource})
				if !apierrors.IsConflict(err) || patched.Load() {
					t.Fatalf("stale edit wrote data: %v", err)
				}
			})
		}
	}
}
