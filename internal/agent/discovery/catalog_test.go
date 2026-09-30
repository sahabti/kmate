package discovery

import (
	"context"
	"testing"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	netv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/utils/ptr"
)

func deployment(ns, name string, desired, ready int32, lbls map[string]string) *appsv1.Deployment {
	return &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, UID: types.UID("dep-" + name)},
		Spec:       appsv1.DeploymentSpec{Replicas: ptr.To(desired), Selector: &metav1.LabelSelector{MatchLabels: lbls}},
		Status:     appsv1.DeploymentStatus{ReadyReplicas: ready},
	}
}

func replicaSet(ns, name, dep string, lbls map[string]string) *appsv1.ReplicaSet {
	return &appsv1.ReplicaSet{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, UID: types.UID("rs-" + name),
		OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: dep, UID: types.UID("dep-" + dep)}}},
		Spec: appsv1.ReplicaSetSpec{Selector: &metav1.LabelSelector{MatchLabels: lbls}}}
}

func pod(ns, name, rs string, lbls map[string]string, ready bool) *corev1.Pod {
	cond := corev1.ConditionFalse
	if ready {
		cond = corev1.ConditionTrue
	}
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: lbls,
		OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: rs}}},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: cond}}}}
}

func slice(ns, svc string, ready, notReady int) *discoveryv1.EndpointSlice {
	s := &discoveryv1.EndpointSlice{ObjectMeta: metav1.ObjectMeta{Name: svc + "-abc", Namespace: ns, Labels: map[string]string{discoveryv1.LabelServiceName: svc}}}
	for i := 0; i < ready; i++ {
		s.Endpoints = append(s.Endpoints, discoveryv1.Endpoint{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr.To(true)}})
	}
	for i := 0; i < notReady; i++ {
		s.Endpoints = append(s.Endpoints, discoveryv1.Endpoint{Addresses: []string{"10.0.0.2"}, Conditions: discoveryv1.EndpointConditions{Ready: ptr.To(false)}})
	}
	return s
}

func build(t *testing.T, objs ...runtime.Object) *kmatev1.Catalog {
	t.Helper()
	cs := fake.NewSimpleClientset(objs...)
	b := New(cs, nil, nil, Options{HideNamespaces: []string{"kube-system"}})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go b.Run(ctx)
	if err := b.WaitSynced(ctx); err != nil {
		t.Fatal(err)
	}
	return b.Current()
}

func find(c *kmatev1.Catalog, id string) *kmatev1.CatalogEntry {
	for _, e := range c.Entries {
		if e.Id == id {
			return e
		}
	}
	return nil
}

func TestHealthyClusterIP(t *testing.T) {
	l := map[string]string{"app": "web"}
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop", Labels: map[string]string{lblPartOf: "shop"}, Annotations: map[string]string{annDescription: "front"}},
			Spec: corev1.ServiceSpec{Selector: l, Ports: []corev1.ServicePort{{Name: "http", Port: 80}}}},
		deployment("shop", "web", 2, 2, l),
		replicaSet("shop", "web-1", "web", l),
		pod("shop", "web-1-a", "web-1", l, true),
		pod("shop", "web-1-b", "web-1", l, true),
		slice("shop", "web", 2, 0),
	)
	e := find(c, "shop/web")
	if e == nil {
		t.Fatal("entry missing")
	}
	if e.Health != kmatev1.Health_HEALTH_HEALTHY {
		t.Fatalf("want healthy got %v", e.Health)
	}
	if len(e.Workloads) != 1 || e.Workloads[0].Kind != "Deployment" || e.Workloads[0].Ready != 2 || e.Workloads[0].Desired != 2 {
		t.Fatalf("bad workloads %v", e.Workloads)
	}
	if e.Group != "shop" || e.Description != "front" || e.Type != "ClusterIP" {
		t.Fatalf("bad meta %v", e)
	}
	if e.Endpoints.Ready != 2 {
		t.Fatalf("bad endpoints %v", e.Endpoints)
	}
}

func TestDegraded(t *testing.T) {
	l := map[string]string{"app": "api"}
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: l, Ports: []corev1.ServicePort{{Port: 8080}}}},
		deployment("shop", "api", 3, 1, l),
		replicaSet("shop", "api-1", "api", l),
		pod("shop", "api-1-a", "api-1", l, true),
		slice("shop", "api", 1, 2),
	)
	e := find(c, "shop/api")
	if e.Health != kmatev1.Health_HEALTH_DEGRADED {
		t.Fatalf("want degraded got %v", e.Health)
	}
}

func TestDown(t *testing.T) {
	l := map[string]string{"app": "w"}
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "w", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: l, Ports: []corev1.ServicePort{{Port: 1}}}},
		deployment("shop", "w", 1, 0, l),
		replicaSet("shop", "w-1", "w", l),
		pod("shop", "w-1-a", "w-1", l, false),
		slice("shop", "w", 0, 1),
	)
	if e := find(c, "shop/w"); e.Health != kmatev1.Health_HEALTH_DOWN {
		t.Fatalf("want down got %v", e.Health)
	}
}

func TestIngressTLS(t *testing.T) {
	l := map[string]string{"app": "web"}
	pt := netv1.PathTypePrefix
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: l, Ports: []corev1.ServicePort{{Port: 80}}}},
		&netv1.Ingress{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"},
			Spec: netv1.IngressSpec{IngressClassName: ptr.To("nginx"),
				TLS: []netv1.IngressTLS{{Hosts: []string{"shop.example.com"}}},
				Rules: []netv1.IngressRule{{Host: "shop.example.com", IngressRuleValue: netv1.IngressRuleValue{HTTP: &netv1.HTTPIngressRuleValue{Paths: []netv1.HTTPIngressPath{
					{Path: "/", PathType: &pt, Backend: netv1.IngressBackend{Service: &netv1.IngressServiceBackend{Name: "web", Port: netv1.ServiceBackendPort{Number: 80}}}},
					{Path: "/other", PathType: &pt, Backend: netv1.IngressBackend{Service: &netv1.IngressServiceBackend{Name: "other", Port: netv1.ServiceBackendPort{Number: 80}}}},
				}}}}}},
			Status: netv1.IngressStatus{LoadBalancer: netv1.IngressLoadBalancerStatus{Ingress: []netv1.IngressLoadBalancerIngress{{IP: "203.0.113.10"}}}}},
	)
	e := find(c, "shop/web")
	if len(e.Exposures) != 1 {
		t.Fatalf("want 1 exposure got %v", e.Exposures)
	}
	x := e.Exposures[0]
	if x.Kind != "Ingress" || !x.Tls || x.Url != "https://shop.example.com/" || x.Class != "nginx" || x.Addresses[0] != "203.0.113.10" {
		t.Fatalf("bad exposure %v", x)
	}
}

func TestNodePortAndLB(t *testing.T) {
	l := map[string]string{"app": "np"}
	c := build(t,
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "n1"}, Status: corev1.NodeStatus{Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: "10.1.1.1"}, {Type: corev1.NodeExternalIP, Address: "198.51.100.5"}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "np", Namespace: "shop"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeNodePort, Selector: l, Ports: []corev1.ServicePort{{Name: "http", Port: 80, NodePort: 31080}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "lb", Namespace: "shop"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer, Selector: l, Ports: []corev1.ServicePort{{Name: "https", Port: 443, NodePort: 31443}}},
			Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: []corev1.LoadBalancerIngress{{IP: "203.0.113.11"}}}}},
	)
	np := find(c, "shop/np")
	if len(np.Exposures) != 1 || np.Exposures[0].Kind != "NodePort" || np.Exposures[0].Url != "http://198.51.100.5:31080/" {
		t.Fatalf("bad nodeport %v", np.Exposures)
	}
	lb := find(c, "shop/lb")
	if len(lb.Exposures) != 2 || lb.Exposures[0].Kind != "LoadBalancer" || lb.Exposures[0].Url != "https://203.0.113.11/" || lb.Exposures[1].Kind != "NodePort" {
		t.Fatalf("bad lb %v", lb.Exposures)
	}
}

func TestExternalNameAndHidden(t *testing.T) {
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "ext", Namespace: "shop"}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeExternalName, ExternalName: "pay.example.com", Ports: []corev1.ServicePort{{Port: 443}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "hidden", Namespace: "shop", Annotations: map[string]string{annHide: "true"}}, Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 1}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "kube-dns", Namespace: "kube-system"}, Spec: corev1.ServiceSpec{Ports: []corev1.ServicePort{{Port: 53}}}},
	)
	e := find(c, "shop/ext")
	if e.Health != kmatev1.Health_HEALTH_NO_SELECTOR || e.Exposures[0].Url != "https://pay.example.com/" {
		t.Fatalf("bad external %v", e)
	}
	if find(c, "shop/hidden") != nil {
		t.Fatal("hidden should be skipped")
	}
	if s := find(c, "kube-system/kube-dns"); s == nil || !s.System {
		t.Fatal("system flag expected")
	}
}

func TestIncrementalUpdate(t *testing.T) {
	l := map[string]string{"app": "web"}
	cs := fake.NewSimpleClientset(
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "shop"}, Spec: corev1.ServiceSpec{Selector: l, Ports: []corev1.ServicePort{{Port: 80}}}},
		deployment("shop", "web", 1, 1, l),
		replicaSet("shop", "web-1", "web", l),
		pod("shop", "web-1-a", "web-1", l, true),
		slice("shop", "web", 1, 0),
	)
	b := New(cs, nil, nil, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go b.Run(ctx)
	if err := b.WaitSynced(ctx); err != nil {
		t.Fatal(err)
	}
	ch, unsub := b.Subscribe()
	defer unsub()
	v0 := b.Version()
	// scale desired to 3 -> degraded
	d := deployment("shop", "web", 3, 1, l)
	if _, err := cs.AppsV1().Deployments("shop").Update(ctx, d, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case snap := <-ch:
		if snap.Version <= v0 {
			t.Fatalf("version not bumped")
		}
		if e := find(snap, "shop/web"); e.Health != kmatev1.Health_HEALTH_DEGRADED {
			t.Fatalf("want degraded got %v", e.Health)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no snapshot after change")
	}
}

func istioObjects() (runtime.Object, runtime.Object, []runtime.Object) {
	vs := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.istio.io/v1", "kind": "VirtualService",
		"metadata": map[string]interface{}{"name": "auction-api", "namespace": "auction"},
		"spec": map[string]interface{}{
			"hosts":    []interface{}{"auction-api.dev.example.com"},
			"gateways": []interface{}{"istio-system/dev-gateway"},
			"http": []interface{}{
				map[string]interface{}{
					"match": []interface{}{map[string]interface{}{"uri": map[string]interface{}{"prefix": "/api"}}},
					"route": []interface{}{map[string]interface{}{"destination": map[string]interface{}{"host": "auction-api", "port": map[string]interface{}{"number": int64(80)}}}},
				},
				map[string]interface{}{
					"route": []interface{}{map[string]interface{}{"destination": map[string]interface{}{"host": "other.auction.svc.cluster.local"}}},
				},
			},
		},
	}}
	gw := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "networking.istio.io/v1", "kind": "Gateway",
		"metadata": map[string]interface{}{"name": "dev-gateway", "namespace": "istio-system"},
		"spec": map[string]interface{}{
			"selector": map[string]interface{}{"istio": "ingressgateway"},
			"servers": []interface{}{
				map[string]interface{}{"port": map[string]interface{}{"number": int64(80), "protocol": "HTTP"}, "hosts": []interface{}{"*.dev.example.com"}},
				map[string]interface{}{"port": map[string]interface{}{"number": int64(443), "protocol": "HTTPS"}, "hosts": []interface{}{"*.dev.example.com"}, "tls": map[string]interface{}{"mode": "SIMPLE"}},
			},
		},
	}}
	igwPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "igw-1", Namespace: "istio-system", Labels: map[string]string{"istio": "ingressgateway", "app": "istio-ingressgateway"}},
		Status: corev1.PodStatus{Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}}}
	igwSvc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "istio-ingressgateway", Namespace: "istio-system"},
		Spec:   corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer, Selector: map[string]string{"app": "istio-ingressgateway"}, Ports: []corev1.ServicePort{{Name: "https", Port: 443}}},
		Status: corev1.ServiceStatus{LoadBalancer: corev1.LoadBalancerStatus{Ingress: []corev1.LoadBalancerIngress{{IP: "34.1.2.3"}}}}}
	return vs, gw, []runtime.Object{igwPod, igwSvc}
}

func TestIstioVirtualService(t *testing.T) {
	vs, gw, core := istioObjects()
	lbls := map[string]string{"app": "auction-api"}
	objs := append(core,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "auction-api", Namespace: "auction"},
			Spec: corev1.ServiceSpec{Selector: lbls, Ports: []corev1.ServicePort{{Name: "http", Port: 80}}}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "auction"},
			Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "other"}, Ports: []corev1.ServicePort{{Port: 80}}}},
		deployment("auction", "auction-api", 1, 1, lbls), replicaSet("auction", "auction-api-1", "auction-api", lbls),
		pod("auction", "auction-api-1-a", "auction-api-1", lbls, true), slice("auction", "auction-api", 1, 0),
	)
	cs := fake.NewSimpleClientset(objs...)
	cs.Fake.Resources = []*metav1.APIResourceList{{GroupVersion: "networking.istio.io/v1", APIResources: []metav1.APIResource{
		{Name: "virtualservices", Kind: "VirtualService", Namespaced: true}, {Name: "gateways", Kind: "Gateway", Namespaced: true}}}}
	vsGVR, gwGVR := istioGVRs("v1")
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{vsGVR: "VirtualServiceList", gwGVR: "GatewayList"})
	// Register via the tracker with explicit GVRs: the fake's kind→resource
	// guesser would otherwise file Gateway under "gatewaies".
	if err := dyn.Tracker().Create(vsGVR, vs, "auction"); err != nil {
		t.Fatal(err)
	}
	if err := dyn.Tracker().Create(gwGVR, gw, "istio-system"); err != nil {
		t.Fatal(err)
	}
	b := New(cs, dyn, cs.Discovery(), Options{HideNamespaces: []string{"kube-system"}})
	if !b.istioEnabled() {
		t.Fatal("istio not detected")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go b.Run(ctx)
	if err := b.WaitSynced(ctx); err != nil {
		t.Fatal(err)
	}
	c := b.Current()

	e := find(c, "auction/auction-api")
	if e == nil {
		t.Fatal("entry missing")
	}
	var got *kmatev1.Exposure
	for _, x := range e.Exposures {
		if x.Kind == "VirtualService" {
			got = x
		}
	}
	if got == nil {
		t.Fatalf("no VirtualService exposure: %v", e.Exposures)
	}
	if got.Url != "https://auction-api.dev.example.com/api" {
		t.Errorf("url = %q", got.Url)
	}
	if !got.Tls || got.Host != "auction-api.dev.example.com" || got.Path != "/api" || got.Class != "istio-system/dev-gateway" {
		t.Errorf("unexpected exposure %+v", got)
	}
	if len(got.Addresses) != 1 || got.Addresses[0] != "34.1.2.3" {
		t.Errorf("addresses = %v", got.Addresses)
	}
	// second http rule routes to "other" via FQDN with no match → root path
	o := find(c, "auction/other")
	if o == nil || len(o.Exposures) != 1 || o.Exposures[0].Url != "https://auction-api.dev.example.com/" {
		t.Errorf("other exposures = %+v", o)
	}
}

func TestResolveServiceHost(t *testing.T) {
	cases := map[string]string{
		"api":                         "ns/api",
		"api.other":                   "other/api",
		"api.other.svc":               "other/api",
		"api.other.svc.cluster.local": "other/api",
		"payments.example.com":        "",
		"*":                           "",
	}
	for in, want := range cases {
		if got := resolveServiceHost(in, "ns"); got != want {
			t.Errorf("%s: got %q want %q", in, got, want)
		}
	}
	if !hostMatches("*.dev.example.com", "a.dev.example.com") || hostMatches("*.dev.example.com", "dev.example.com") || !hostMatches("*", "x") {
		t.Error("hostMatches wildcard semantics wrong")
	}
}

func TestFinishedJobDoesNotDegrade(t *testing.T) {
	lbls := map[string]string{"app": "api"}
	jobPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "api-db-migrate-x", Namespace: "ns", Labels: lbls,
		OwnerReferences: []metav1.OwnerReference{{Kind: "Job", Name: "api-db-migrate"}}},
		Status: corev1.PodStatus{Phase: corev1.PodSucceeded, Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse}}}}
	c := build(t,
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "ns"}, Spec: corev1.ServiceSpec{Selector: lbls, Ports: []corev1.ServicePort{{Port: 80}}}},
		deployment("ns", "api", 2, 2, lbls), replicaSet("ns", "api-1", "api", lbls),
		pod("ns", "api-1-a", "api-1", lbls, true), pod("ns", "api-1-b", "api-1", lbls, true), jobPod,
		slice("ns", "api", 2, 0),
	)
	e := find(c, "ns/api")
	if e == nil {
		t.Fatal("missing")
	}
	if e.Health != kmatev1.Health_HEALTH_HEALTHY {
		t.Errorf("health = %v, workloads = %v", e.Health, e.Workloads)
	}
	for _, w := range e.Workloads {
		if w.Kind == "Job" {
			t.Errorf("finished job listed as workload: %v", w)
		}
	}
}

func TestHiddenNamespacePrefix(t *testing.T) {
	b := New(fake.NewSimpleClientset(), nil, nil, Options{HideNamespaces: []string{"kube-system", "gke-managed-*"}})
	if !b.isHidden("gke-managed-cim") || !b.isHidden("kube-system") || b.isHidden("shop") {
		t.Error("prefix hiding wrong")
	}
}
