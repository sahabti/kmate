package handlers

import (
	"context"
	"testing"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func TestDisabledSecretsFailBeforeCache(t *testing.T) {
	for _, impersonate := range []bool{false, true} {
		t.Run(map[bool]string{false: "shared", true: "impersonated"}[impersonate], func(t *testing.T) {
			h := &Handler{DenySecrets: true, Clients: &kube.Clients{CanImpersonate: impersonate}}
			g := &kmatev1.GVR{Version: "v1", Resource: "secrets"}
			identity := &kmatev1.Request{Identity: &kmatev1.Identity{User: "alice"}}
			if _, err := h.list(context.Background(), identity, &kmatev1.ListRequest{Gvr: g}); !apierrors.IsForbidden(err) {
				t.Fatalf("list did not fail before cache: %v", err)
			}
			if _, err := h.get(context.Background(), identity, &kmatev1.GetRequest{Ref: &kmatev1.ObjectRef{Gvr: g}}); !apierrors.IsForbidden(err) {
				t.Fatalf("get did not fail before cache: %v", err)
			}
			if err := h.authorizeCachedRead(context.Background(), identity, g, "shop", "", "watch"); !apierrors.IsForbidden(err) {
				t.Fatalf("watch did not fail before access review: %v", err)
			}
			if err := h.checkSecrets(schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "secrets"}); err != nil {
				t.Fatalf("non-core resource denied: %v", err)
			}
		})
	}
}
