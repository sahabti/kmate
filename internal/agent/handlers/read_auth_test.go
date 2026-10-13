package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	authzv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/rest"
)

func TestCachedReadsCheckImpersonatedPermissions(t *testing.T) {
	for _, verb := range []string{"get", "list", "watch"} {
		for _, allowed := range []bool{true, false} {
			t.Run(verb+map[bool]string{true: "/allowed", false: "/denied"}[allowed], func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Impersonate-User") != "alice" {
						t.Error("review used the agent's identity")
					}
					var review authzv1.SelfSubjectAccessReview
					if err := json.NewDecoder(r.Body).Decode(&review); err != nil {
						t.Error(err)
					}
					attrs := review.Spec.ResourceAttributes
					if attrs == nil || attrs.Verb != verb || attrs.Resource != "secrets" || attrs.Namespace != "shop" {
						t.Errorf("wrong review: %v", attrs)
					}
					w.Header().Set("Content-Type", "application/json")
					review.Status.Allowed = allowed
					if err := json.NewEncoder(w).Encode(review); err != nil {
						t.Error(err)
					}
				}))
				defer server.Close()
				clients, err := kube.FromConfig(&rest.Config{Host: server.URL, ContentConfig: rest.ContentConfig{ContentType: "application/json"}}, kube.Options{CanImpersonate: true})
				if err != nil {
					t.Fatal(err)
				}
				h := &Handler{Clients: clients}
				err = h.authorizeCachedRead(context.Background(), &kmatev1.Request{Identity: &kmatev1.Identity{User: "alice"}}, &kmatev1.GVR{Version: "v1", Resource: "secrets"}, "shop", "", verb)
				if allowed && err != nil {
					t.Fatal(err)
				}
				if !allowed && !apierrors.IsForbidden(err) {
					t.Fatalf("denied review did not fail closed: %v", err)
				}
			})
		}
	}
}

func TestMissingIdentityFailsBeforeCache(t *testing.T) {
	h := &Handler{Clients: &kube.Clients{CanImpersonate: true}}
	_, err := h.list(context.Background(), &kmatev1.Request{}, &kmatev1.ListRequest{Gvr: &kmatev1.GVR{Version: "v1", Resource: "secrets"}})
	if !apierrors.IsForbidden(err) {
		t.Fatalf("read should fail before touching cache: %v", err)
	}
}
