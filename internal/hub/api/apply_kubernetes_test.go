package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"testing"
	"time"

	"connectrpc.com/connect"
	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/handlers"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/mux"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// This opt-in test creates and removes its own namespaces. It never loads the
// default kubeconfig: point KMATE_TEST_KUBECONFIG at a disposable cluster.
func TestApplyKubernetesNamespaceBoundary(t *testing.T) {
	path := os.Getenv("KMATE_TEST_KUBECONFIG")
	if path == "" {
		t.Skip("set KMATE_TEST_KUBECONFIG to a disposable cluster kubeconfig")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	clients, err := kube.New(kube.Options{Kubeconfig: path, CanImpersonate: true})
	if err != nil {
		t.Fatal(err)
	}
	namespaces := make([]string, 0, 2)
	for range 2 {
		ns, err := clients.Clientset.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "kmate-apply-test-"}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
		namespaces = append(namespaces, ns.Name)
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			if err := clients.Clientset.CoreV1().Namespaces().Delete(cleanup, ns.Name, metav1.DeleteOptions{}); err != nil {
				t.Error(err)
			}
		})
	}
	allowed, denied := namespaces[0], namespaces[1]
	if _, err := clients.Clientset.RbacV1().Roles(allowed).Create(ctx, &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: "editor"}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"configmaps"}, Verbs: []string{"get", "create", "patch"}}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := clients.Clientset.RbacV1().RoleBindings(allowed).Create(ctx, &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "editor"}, RoleRef: rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: "editor"}, Subjects: []rbacv1.Subject{{Kind: "User", Name: "operator@x"}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	f := newFixture(t)
	mustGrant(t, f.st, f.ids["operator@x"], f.cID, auth.RoleOperator, []string{allowed})
	one, two := mux.Pipe()
	defer mux.ClosePipe(one)
	hub, agent := mux.New(one, mux.Initiator), mux.New(two, mux.Responder)
	go hub.Run(ctx)
	go agent.Run(ctx)
	f.cluster.relay.Registry().Register(&registry.AgentConn{ClusterID: f.cID, Session: hub})
	h := &handlers.Handler{Clients: clients, CanWrite: true, Log: slog.Default()}
	go func() {
		for {
			stream, err := agent.Accept(ctx)
			if err != nil {
				return
			}
			frame, err := stream.Recv(ctx)
			if err != nil {
				return
			}
			h.Dispatch(ctx, stream, frame.GetRequest())
		}
	}()
	for _, tc := range []struct {
		name, envelopeNS, bodyNS, envelopeName, bodyName string
		want                                             connect.Code
	}{
		{"namespace mismatch", allowed, denied, "sample", "sample", connect.CodeInvalidArgument},
		{"name mismatch", allowed, allowed, "sample", "different", connect.CodeInvalidArgument},
		{"outside grant", denied, denied, "sample", "sample", connect.CodePermissionDenied},
		{"honest control", allowed, allowed, "sample", "sample", connect.CodeUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]interface{}{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"name": tc.bodyName, "namespace": tc.bodyNS}, "data": map[string]string{"key": "value"}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = f.cluster.Apply(f.as(t, "operator@x"), connect.NewRequest(&kmatev1.ClusterApplyRequest{ClusterId: f.cID, Apply: &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{ApiVersion: "v1", Kind: "ConfigMap", Namespace: tc.envelopeNS, Name: tc.envelopeName, Json: body}}}))
			if tc.name == "honest control" {
				if err != nil {
					t.Fatal(err)
				}
			} else if connect.CodeOf(err) != tc.want {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
	if _, err := clients.Clientset.CoreV1().ConfigMaps(allowed).Get(ctx, "sample", metav1.GetOptions{}); err != nil {
		t.Fatalf("honest request did not persist: %v", err)
	}
	for _, target := range []struct{ ns, name string }{{denied, "sample"}, {allowed, "different"}} {
		if _, err := clients.Clientset.CoreV1().ConfigMaps(target.ns).Get(ctx, target.name, metav1.GetOptions{}); !apierrors.IsNotFound(err) {
			t.Fatalf("rejected request changed %s/%s: %v", target.ns, target.name, err)
		}
	}
}
