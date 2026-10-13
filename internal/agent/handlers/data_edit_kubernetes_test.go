package handlers

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

func TestDataEditsKubernetesOwnershipAndConcurrency(t *testing.T) {
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
	ns, err := clients.Clientset.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "kmate-edit-test-"}}, metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		if err := clients.Clientset.CoreV1().Namespaces().Delete(cleanup, ns.Name, metav1.DeleteOptions{}); err != nil {
			t.Error(err)
		}
	})
	if _, err := clients.Clientset.RbacV1().Roles(ns.Name).Create(ctx, &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: "editor"}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"secrets", "configmaps"}, Verbs: []string{"get", "patch"}}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	user := ns.Name + "-editor"
	if _, err := clients.Clientset.RbacV1().RoleBindings(ns.Name).Create(ctx, &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "editor"}, RoleRef: rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: "editor"}, Subjects: []rbacv1.Subject{{Kind: "User", Name: user}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	h := &Handler{Clients: clients, CanWrite: true}
	for _, kind := range []string{"Secret", "ConfigMap"} {
		t.Run(kind, func(t *testing.T) {
			resource, value := "configmaps", "synthetic-value"
			if kind == "Secret" {
				resource, value = "secrets", "c3ludGhldGljLXZhbHVl"
			}
			gvr := schema.GroupVersionResource{Version: "v1", Resource: resource}
			api := clients.Dynamic.Resource(gvr).Namespace(ns.Name)
			initial := &unstructured.Unstructured{Object: map[string]interface{}{"apiVersion": "v1", "kind": kind, "metadata": map[string]interface{}{"name": "sample", "namespace": ns.Name}, "data": map[string]interface{}{"keep": value, "remove": value}}}
			body, err := json.Marshal(initial.Object)
			if err != nil {
				t.Fatal(err)
			}
			force := true
			before, err := api.Patch(ctx, "sample", types.ApplyPatchType, body, metav1.PatchOptions{FieldManager: "helm", Force: &force})
			if err != nil {
				t.Fatal(err)
			}
			if len(before.GetManagedFields()) == 0 || before.GetManagedFields()[0].Manager != "helm" {
				t.Fatal("fixture did not establish foreign field ownership")
			}
			desired := before.DeepCopy()
			desired.Object["data"] = map[string]interface{}{"keep": value, "added": value}
			body, err = editJSON(desired)
			if err != nil {
				t.Fatal(err)
			}
			a := &kmatev1.ApplyRequest{Object: &kmatev1.KubeObject{ApiVersion: "v1", Kind: kind, Name: "sample", Namespace: ns.Name, Json: body, ResourceVersion: before.GetResourceVersion()}, DryRun: true}
			req := &kmatev1.Request{Identity: &kmatev1.Identity{User: user}}
			preview, err := h.apply(ctx, req, a)
			if err != nil {
				t.Fatal(err)
			}
			var previewObject unstructured.Unstructured
			if err := json.Unmarshal(preview.GetApply().GetObject().GetJson(), &previewObject.Object); err != nil {
				t.Fatal(err)
			}
			if _, exists, _ := unstructured.NestedString(previewObject.Object, "data", "remove"); exists {
				t.Fatal("dry run did not preview deletion")
			}
			live, err := api.Get(ctx, "sample", metav1.GetOptions{})
			if err != nil || live.GetResourceVersion() != before.GetResourceVersion() {
				t.Fatalf("dry run persisted changes: %v", err)
			}
			a.DryRun = false
			if _, err := h.apply(ctx, req, a); err != nil {
				t.Fatal(err)
			}
			live, err = api.Get(ctx, "sample", metav1.GetOptions{})
			if err != nil {
				t.Fatal(err)
			}
			data, _, err := unstructured.NestedStringMap(live.Object, "data")
			if err != nil || len(data) != 2 || data["keep"] != value || data["added"] != value {
				t.Fatalf("edit did not preserve/add/remove keys: %v err=%v", data, err)
			}
			a.Force = true
			if _, err := h.apply(ctx, req, a); !apierrors.IsConflict(err) {
				t.Fatalf("stale edit bypassed concurrency protection: %v", err)
			}
			a.Object.ResourceVersion = live.GetResourceVersion()
			denied := &kmatev1.Request{Identity: &kmatev1.Identity{User: ns.Name + "-denied"}}
			if _, err := h.apply(ctx, denied, a); !apierrors.IsForbidden(err) {
				t.Fatalf("edit bypassed impersonation: %v", err)
			}
		})
	}
}
