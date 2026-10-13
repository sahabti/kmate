package handlers

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/cache"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"github.com/kmate-dev/kmate/internal/mux"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestCachedReadsKubernetesRBAC(t *testing.T) {
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
	ns, err := clients.Clientset.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{GenerateName: "kmate-read-test-"}}, metav1.CreateOptions{})
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
	if _, err := clients.Clientset.CoreV1().Secrets(ns.Name).Create(ctx, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "sample"}, Data: map[string][]byte{"key": []byte("synthetic-value")}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := clients.Clientset.RbacV1().Roles(ns.Name).Create(ctx, &rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: "reader"}, Rules: []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"secrets"}, Verbs: []string{"get", "list", "watch"}}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	user := ns.Name + "-reader"
	if _, err := clients.Clientset.RbacV1().RoleBindings(ns.Name).Create(ctx, &rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: "reader"}, RoleRef: rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: "reader"}, Subjects: []rbacv1.Subject{{Kind: "User", Name: user}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	cc := cache.New(clients, []string{ns.Name}, slog.Default())
	go cc.Run(ctx)
	g := &kmatev1.GVR{Version: "v1", Resource: "secrets"}
	options := &kmatev1.ListOptions{Namespace: ns.Name}
	// Warm the ServiceAccount cache before denied requests to exercise the
	// original leak rather than relying on the API server rejecting a cache miss.
	if objects, err := cc.List(ctx, cache.GVR(g), options); err != nil || len(objects) != 1 {
		t.Fatalf("cache did not warm: objects=%d err=%v", len(objects), err)
	}
	h := &Handler{Clients: clients, Cache: cc, Log: slog.Default()}
	for _, verb := range []string{"get", "list", "watch"} {
		for _, allowed := range []bool{true, false} {
			t.Run(verb+map[bool]string{true: "/allowed", false: "/denied"}[allowed], func(t *testing.T) {
				identity := user
				if !allowed {
					identity = ns.Name + "-denied"
				}
				req := &kmatev1.Request{Identity: &kmatev1.Identity{User: identity}}
				switch verb {
				case "get":
					req.Kind = &kmatev1.Request_Get{Get: &kmatev1.GetRequest{Ref: &kmatev1.ObjectRef{Gvr: g, Namespace: ns.Name, Name: "sample"}}}
				case "list":
					req.Kind = &kmatev1.Request_List{List: &kmatev1.ListRequest{Gvr: g, Options: options}}
				case "watch":
					req.Kind = &kmatev1.Request_Watch{Watch: &kmatev1.WatchRequest{Gvr: g, Options: options}}
				}
				frame := cachedReadFirstFrame(t, h, req)
				if !allowed {
					code := frame.GetResponse().GetError().GetCode()
					if verb == "watch" {
						code = frame.GetClose().GetError().GetCode()
					}
					if code != 403 {
						t.Fatalf("denied identity received data: %v", frame)
					}
				} else if verb == "watch" {
					if frame.GetWatchEvent().GetObject().GetName() != "sample" {
						t.Fatalf("authorized watch failed: %v", frame)
					}
				} else if frame.GetResponse() == nil || frame.GetResponse().GetError() != nil {
					t.Fatalf("authorized read failed: %v", frame)
				}
			})
		}
	}
}

func cachedReadFirstFrame(t *testing.T, h *Handler, req *kmatev1.Request) *kmatev1.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	one, two := mux.Pipe()
	defer mux.ClosePipe(one)
	hub, agent := mux.New(one, mux.Initiator), mux.New(two, mux.Responder)
	go hub.Run(ctx)
	go agent.Run(ctx)
	go func() {
		st, err := agent.Accept(ctx)
		if err != nil {
			return
		}
		f, err := st.Recv(ctx)
		if err != nil {
			return
		}
		h.Dispatch(ctx, st, f.GetRequest())
	}()
	st, err := hub.Open()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Request{Request: req}}); err != nil {
		t.Fatal(err)
	}
	f, err := st.Recv(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return f
}
