// Package discovery builds the Service Catalog: every Service in the cluster
// enriched with its backing workloads, endpoint health, and every Ingress /
// Gateway / LoadBalancer / NodePort exposure that makes it reachable.
package discovery

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	netv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

const (
	debounce = 500 * time.Millisecond

	annDescription = "kmate.io/description"
	annIcon        = "kmate.io/icon"
	annURL         = "kmate.io/url"
	annHide        = "kmate.io/hide"
	annHelmRelease = "meta.helm.sh/release-name"
	lblPartOf      = "app.kubernetes.io/part-of"
	lblManagedBy   = "app.kubernetes.io/managed-by"
)

var (
	gvrHTTPRoute = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "httproutes"}
	gvrGateway   = schema.GroupVersionResource{Group: "gateway.networking.k8s.io", Version: "v1", Resource: "gateways"}
)

// Options configure the builder.
type Options struct {
	HideNamespaces []string
	Namespaces     []string // scope; empty = all
	Probe          bool
	ProbeInterval  time.Duration
	Log            *slog.Logger
}

// DefaultHideNamespaces are platform namespaces collapsed under "System" by
// default. A trailing "*" matches a prefix.
const DefaultHideNamespaces = "kube-system,kube-public,kube-node-lease,kmate-system,istio-system,gke-managed-*,gmp-system,gmp-public,gke-gmp-system,config-management-system,cert-manager,ingress-nginx"

// Builder maintains the catalog.
type Builder struct {
	opts         Options
	log          *slog.Logger
	cs           kubernetes.Interface
	dyn          dynamic.Interface
	hideNS       map[string]bool
	hidePrefixes []string

	factories  []informers.SharedInformerFactory
	dynFactory []dynamicinformer.DynamicSharedInformerFactory
	gatewayAPI bool

	services   []cache.SharedIndexInformer
	slices     []cache.SharedIndexInformer
	pods       []cache.SharedIndexInformer
	rs         []cache.SharedIndexInformer
	deploys    []cache.SharedIndexInformer
	sts        []cache.SharedIndexInformer
	ds         []cache.SharedIndexInformer
	ingresses  []cache.SharedIndexInformer
	nodes      cache.SharedIndexInformer
	httproutes []cache.SharedIndexInformer
	gateways   []cache.SharedIndexInformer

	istioVersion  string // "" when Istio CRDs are absent
	vservices     []cache.SharedIndexInformer
	istioGateways []cache.SharedIndexInformer

	dirtyMu sync.Mutex
	dirty   map[string]bool
	kick    chan struct{}

	mu      sync.RWMutex
	entries map[string]*kmatev1.CatalogEntry // namespace/name
	version int64
	synced  bool
	subs    map[int]chan *kmatev1.Catalog
	nextSub int
	probes  map[string]*kmatev1.ProbeResult
}

// New creates a Builder. disc may be nil; it is used to detect Gateway API.
func New(cs kubernetes.Interface, dyn dynamic.Interface, disc discovery.DiscoveryInterface, opts Options) *Builder {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.ProbeInterval == 0 {
		opts.ProbeInterval = 60 * time.Second
	}
	b := &Builder{
		opts:    opts,
		log:     opts.Log,
		cs:      cs,
		dyn:     dyn,
		hideNS:  map[string]bool{},
		dirty:   map[string]bool{},
		kick:    make(chan struct{}, 1),
		entries: map[string]*kmatev1.CatalogEntry{},
		subs:    map[int]chan *kmatev1.Catalog{},
		probes:  map[string]*kmatev1.ProbeResult{},
	}
	for _, ns := range opts.HideNamespaces {
		if ns = strings.TrimSpace(ns); ns != "" {
			if strings.HasSuffix(ns, "*") {
				b.hidePrefixes = append(b.hidePrefixes, strings.TrimSuffix(ns, "*"))
			} else {
				b.hideNS[ns] = true
			}
		}
	}
	b.istioVersion = detectIstio(disc)
	if disc != nil {
		if res, err := disc.ServerResourcesForGroupVersion("gateway.networking.k8s.io/v1"); err == nil {
			for _, r := range res.APIResources {
				if r.Name == "httproutes" {
					b.gatewayAPI = true
				}
			}
		}
	}
	scopes := opts.Namespaces
	if len(scopes) == 0 {
		scopes = []string{metav1.NamespaceAll}
	}
	for _, ns := range scopes {
		f := informers.NewSharedInformerFactoryWithOptions(cs, 0, informers.WithNamespace(ns))
		b.factories = append(b.factories, f)
		b.services = append(b.services, f.Core().V1().Services().Informer())
		b.slices = append(b.slices, f.Discovery().V1().EndpointSlices().Informer())
		b.pods = append(b.pods, f.Core().V1().Pods().Informer())
		b.rs = append(b.rs, f.Apps().V1().ReplicaSets().Informer())
		b.deploys = append(b.deploys, f.Apps().V1().Deployments().Informer())
		b.sts = append(b.sts, f.Apps().V1().StatefulSets().Informer())
		b.ds = append(b.ds, f.Apps().V1().DaemonSets().Informer())
		b.ingresses = append(b.ingresses, f.Networking().V1().Ingresses().Informer())
		if (b.gatewayAPI || b.istioEnabled()) && dyn != nil {
			df := dynamicinformer.NewFilteredDynamicSharedInformerFactory(dyn, 0, ns, nil)
			b.dynFactory = append(b.dynFactory, df)
			if b.gatewayAPI {
				b.httproutes = append(b.httproutes, df.ForResource(gvrHTTPRoute).Informer())
				b.gateways = append(b.gateways, df.ForResource(gvrGateway).Informer())
			}
			if b.istioEnabled() {
				vsGVR, gwGVR := istioGVRs(b.istioVersion)
				b.vservices = append(b.vservices, df.ForResource(vsGVR).Informer())
				b.istioGateways = append(b.istioGateways, df.ForResource(gwGVR).Informer())
			}
		}
	}
	// nodes are cluster-scoped; use first factory (namespace filter irrelevant for nodes)
	nf := informers.NewSharedInformerFactory(cs, 0)
	b.factories = append(b.factories, nf)
	b.nodes = nf.Core().V1().Nodes().Informer()

	nsOf := func(obj interface{}) string {
		if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
			obj = d.Obj
		}
		if m, err := metaAccessor(obj); err == nil {
			return m.GetNamespace()
		}
		return ""
	}
	h := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(o interface{}) { b.markDirty(nsOf(o)) },
		UpdateFunc: func(_, o interface{}) { b.markDirty(nsOf(o)) },
		DeleteFunc: func(o interface{}) { b.markDirty(nsOf(o)) },
	}
	hAll := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(interface{}) { b.markDirty("*") },
		UpdateFunc: func(_, _ interface{}) { b.markDirty("*") },
		DeleteFunc: func(interface{}) { b.markDirty("*") },
	}
	for _, group := range [][]cache.SharedIndexInformer{b.gateways, b.vservices, b.istioGateways} {
		for _, inf := range group {
			_, _ = inf.AddEventHandler(hAll)
		}
	}
	for _, group := range [][]cache.SharedIndexInformer{b.services, b.slices, b.pods, b.rs, b.deploys, b.sts, b.ds, b.ingresses, b.httproutes} {
		for _, inf := range group {
			_, _ = inf.AddEventHandler(h)
		}
	}
	all := cache.ResourceEventHandlerFuncs{
		AddFunc:    func(o interface{}) { b.markDirty("*") },
		UpdateFunc: func(_, o interface{}) { b.markDirty("*") },
		DeleteFunc: func(o interface{}) { b.markDirty("*") },
	}
	_, _ = b.nodes.AddEventHandler(all)
	for _, inf := range b.gateways {
		_, _ = inf.AddEventHandler(all)
	}
	return b
}

func metaAccessor(obj interface{}) (metav1.Object, error) {
	switch o := obj.(type) {
	case metav1.Object:
		return o, nil
	case *unstructured.Unstructured:
		return o, nil
	}
	return nil, fmt.Errorf("not a metav1.Object")
}

// isHidden reports whether ns is a system namespace.
func (b *Builder) isHidden(ns string) bool {
	if b.hideNS[ns] {
		return true
	}
	for _, p := range b.hidePrefixes {
		if strings.HasPrefix(ns, p) {
			return true
		}
	}
	return false
}

func (b *Builder) markDirty(ns string) {
	b.dirtyMu.Lock()
	b.dirty[ns] = true
	b.dirtyMu.Unlock()
	select {
	case b.kick <- struct{}{}:
	default:
	}
}

// Run starts informers and the rebuild loop; blocks until ctx is done.
func (b *Builder) Run(ctx context.Context) {
	for _, f := range b.factories {
		f.Start(ctx.Done())
	}
	for _, f := range b.dynFactory {
		f.Start(ctx.Done())
	}
	for _, f := range b.factories {
		f.WaitForCacheSync(ctx.Done())
	}
	for _, f := range b.dynFactory {
		f.WaitForCacheSync(ctx.Done())
	}
	b.rebuild(true)
	b.mu.Lock()
	b.synced = true
	b.mu.Unlock()
	b.log.Info("catalog: initial build complete", "entries", len(b.entries), "gatewayAPI", b.gatewayAPI, "istio", b.istioVersion)

	if b.opts.Probe {
		go b.probeLoop(ctx)
	}
	var timer *time.Timer
	var timerC <-chan time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-b.kick:
			if timer == nil {
				timer = time.NewTimer(debounce)
				timerC = timer.C
			}
		case <-timerC:
			timer = nil
			timerC = nil
			b.rebuild(false)
		}
	}
}

// WaitSynced blocks until the first build is done.
func (b *Builder) WaitSynced(ctx context.Context) error {
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for {
		b.mu.RLock()
		s := b.synced
		b.mu.RUnlock()
		if s {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}

// Current returns the current catalog snapshot.
func (b *Builder) Current() *kmatev1.Catalog {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.snapshotLocked()
}

// Version returns the current catalog version.
// PodCount returns the number of pods currently in the informer caches.
func (b *Builder) PodCount() int32 {
	n := 0
	for _, inf := range b.pods {
		n += len(inf.GetStore().ListKeys())
	}
	return int32(n)
}

func (b *Builder) Version() int64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.version
}

func (b *Builder) snapshotLocked() *kmatev1.Catalog {
	out := &kmatev1.Catalog{Version: b.version, GeneratedAt: timestamppb.Now()}
	for _, e := range b.entries {
		out.Entries = append(out.Entries, e)
	}
	sort.Slice(out.Entries, func(i, j int) bool { return out.Entries[i].Id < out.Entries[j].Id })
	return out
}

// Subscribe returns a channel that receives a snapshot on every change.
func (b *Builder) Subscribe() (<-chan *kmatev1.Catalog, func()) {
	ch := make(chan *kmatev1.Catalog, 4)
	b.mu.Lock()
	id := b.nextSub
	b.nextSub++
	b.subs[id] = ch
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.subs, id)
		b.mu.Unlock()
	}
}

func (b *Builder) rebuild(all bool) {
	b.dirtyMu.Lock()
	dirty := b.dirty
	b.dirty = map[string]bool{}
	b.dirtyMu.Unlock()
	if dirty["*"] {
		all = true
	}

	nsSet := map[string]bool{}
	if all {
		for _, inf := range b.services {
			for _, o := range inf.GetStore().List() {
				nsSet[o.(*corev1.Service).Namespace] = true
			}
		}
		// also namespaces that previously had entries (to drop them)
		b.mu.RLock()
		for _, e := range b.entries {
			nsSet[e.Namespace] = true
		}
		b.mu.RUnlock()
	} else {
		for ns := range dirty {
			if ns != "" {
				nsSet[ns] = true
			}
		}
	}
	if len(nsSet) == 0 {
		return
	}
	nodeAddr := b.nodeAddress()
	istio := b.buildIstioIndex()
	changed := false
	b.mu.Lock()
	for ns := range nsSet {
		fresh := b.buildNamespace(ns, nodeAddr, istio)
		// drop removed
		for id, e := range b.entries {
			if e.Namespace == ns {
				if _, ok := fresh[id]; !ok {
					delete(b.entries, id)
					changed = true
				}
			}
		}
		for id, e := range fresh {
			old, ok := b.entries[id]
			if ok && entryEqual(old, e) {
				e.LastChange = old.LastChange
				e.Probes = old.Probes
				b.entries[id] = e
				continue
			}
			if p := b.probes; len(p) > 0 {
				e.Probes = map[string]*kmatev1.ProbeResult{}
				for _, x := range e.Exposures {
					if r, ok := p[x.Url]; ok {
						e.Probes[x.Url] = r
					}
				}
			}
			b.entries[id] = e
			changed = true
		}
	}
	if changed || b.version == 0 {
		b.version++
		snap := b.snapshotLocked()
		for _, ch := range b.subs {
			select {
			case ch <- snap:
			default:
				// drop; subscriber will get next one
			}
		}
	}
	b.mu.Unlock()
}

func entryEqual(a, b *kmatev1.CatalogEntry) bool {
	a2 := proto.Clone(a).(*kmatev1.CatalogEntry)
	b2 := proto.Clone(b).(*kmatev1.CatalogEntry)
	a2.LastChange, b2.LastChange = nil, nil
	a2.Probes, b2.Probes = nil, nil
	return proto.Equal(a2, b2)
}

func (b *Builder) nodeAddress() string {
	var internal, external string
	for _, o := range b.nodes.GetStore().List() {
		n := o.(*corev1.Node)
		for _, a := range n.Status.Addresses {
			switch a.Type {
			case corev1.NodeExternalIP:
				if external == "" {
					external = a.Address
				}
			case corev1.NodeInternalIP:
				if internal == "" {
					internal = a.Address
				}
			}
		}
	}
	if external != "" {
		return external
	}
	return internal
}

func listNS[T any](infs []cache.SharedIndexInformer, ns string) []T {
	var out []T
	for _, inf := range infs {
		objs, _ := inf.GetIndexer().ByIndex(cache.NamespaceIndex, ns)
		for _, o := range objs {
			if t, ok := o.(T); ok {
				out = append(out, t)
			}
		}
	}
	return out
}

func (b *Builder) buildNamespace(ns string, nodeAddr string, istio *istioIndex) map[string]*kmatev1.CatalogEntry {
	out := map[string]*kmatev1.CatalogEntry{}
	if istio == nil {
		istio = b.buildIstioIndex()
	}
	services := listNS[*corev1.Service](b.services, ns)
	if len(services) == 0 {
		return out
	}
	pods := listNS[*corev1.Pod](b.pods, ns)
	slices := listNS[*discoveryv1.EndpointSlice](b.slices, ns)
	rss := listNS[*appsv1.ReplicaSet](b.rs, ns)
	deploys := listNS[*appsv1.Deployment](b.deploys, ns)
	stss := listNS[*appsv1.StatefulSet](b.sts, ns)
	dss := listNS[*appsv1.DaemonSet](b.ds, ns)
	ingresses := listNS[*netv1.Ingress](b.ingresses, ns)
	routes := listNS[*unstructured.Unstructured](b.httproutes, ns)

	rsByName := map[string]*appsv1.ReplicaSet{}
	for _, r := range rss {
		rsByName[r.Name] = r
	}
	depByName := map[string]*appsv1.Deployment{}
	for _, d := range deploys {
		depByName[d.Name] = d
	}
	stsByName := map[string]*appsv1.StatefulSet{}
	for _, s := range stss {
		stsByName[s.Name] = s
	}
	dsByName := map[string]*appsv1.DaemonSet{}
	for _, d := range dss {
		dsByName[d.Name] = d
	}

	for _, svc := range services {
		if strings.EqualFold(svc.Annotations[annHide], "true") {
			continue
		}
		e := &kmatev1.CatalogEntry{
			Id:          svc.Namespace + "/" + svc.Name,
			Namespace:   svc.Namespace,
			Name:        svc.Name,
			Type:        string(svc.Spec.Type),
			Selector:    svc.Spec.Selector,
			Labels:      svc.Labels,
			Annotations: filterAnnotations(svc.Annotations),
			Description: svc.Annotations[annDescription],
			Icon:        svc.Annotations[annIcon],
			System:      b.isHidden(svc.Namespace),
			LastChange:  timestamppb.Now(),
			Endpoints:   &kmatev1.EndpointStats{},
		}
		if e.Type == "" {
			e.Type = "ClusterIP"
		}
		if svc.Spec.ClusterIP == corev1.ClusterIPNone {
			e.Type = "Headless"
		}
		for _, p := range svc.Spec.Ports {
			sp := &kmatev1.ServicePort{Name: p.Name, Port: p.Port, TargetPort: p.TargetPort.String(), Protocol: string(p.Protocol), NodePort: p.NodePort}
			if p.AppProtocol != nil {
				sp.AppProtocol = *p.AppProtocol
			}
			e.Ports = append(e.Ports, sp)
		}
		// helm / group
		if rel := svc.Annotations[annHelmRelease]; rel != "" {
			e.HelmRelease = rel
		}
		switch {
		case svc.Labels[lblPartOf] != "":
			e.Group = svc.Labels[lblPartOf]
		case e.HelmRelease != "":
			e.Group = e.HelmRelease
		default:
			e.Group = svc.Namespace
		}

		// workloads via selector
		if len(svc.Spec.Selector) > 0 {
			sel := labels.SelectorFromSet(svc.Spec.Selector)
			seen := map[string]*kmatev1.WorkloadRef{}
			var order []string
			for _, p := range pods {
				if !sel.Matches(labels.Set(p.Labels)) {
					continue
				}
				kind, name := resolveOwner(p, rsByName)
				if kind == "" {
					continue
				}
				if kind == "Job" && (p.Status.Phase == corev1.PodSucceeded || p.Status.Phase == corev1.PodFailed) {
					// finished Job pods (migrations, hooks) are not part of the service
					continue
				}
				key := kind + "/" + name
				if _, ok := seen[key]; ok {
					continue
				}
				ref := &kmatev1.WorkloadRef{Kind: kind, Name: name}
				switch kind {
				case "Deployment":
					if d := depByName[name]; d != nil {
						ref.Ready = d.Status.ReadyReplicas
						if d.Spec.Replicas != nil {
							ref.Desired = *d.Spec.Replicas
						} else {
							ref.Desired = 1
						}
					}
				case "StatefulSet":
					if s := stsByName[name]; s != nil {
						ref.Ready = s.Status.ReadyReplicas
						if s.Spec.Replicas != nil {
							ref.Desired = *s.Spec.Replicas
						} else {
							ref.Desired = 1
						}
					}
				case "DaemonSet":
					if d := dsByName[name]; d != nil {
						ref.Ready = d.Status.NumberReady
						ref.Desired = d.Status.DesiredNumberScheduled
					}
				case "ReplicaSet":
					if r := rsByName[name]; r != nil {
						ref.Ready = r.Status.ReadyReplicas
						if r.Spec.Replicas != nil {
							ref.Desired = *r.Spec.Replicas
						}
					}
				default:
					ref.Desired = 1
					if isPodReady(p) {
						ref.Ready = 1
					}
				}
				seen[key] = ref
				order = append(order, key)
			}
			for _, k := range order {
				e.Workloads = append(e.Workloads, seen[k])
			}
			if e.HelmRelease == "" {
				// inherit from workload
				for _, w := range e.Workloads {
					if w.Kind == "Deployment" {
						if d := depByName[w.Name]; d != nil && d.Annotations[annHelmRelease] != "" {
							e.HelmRelease = d.Annotations[annHelmRelease]
						}
					}
				}
			}
		}

		// endpoints from EndpointSlices
		for _, s := range slices {
			if s.Labels[discoveryv1.LabelServiceName] != svc.Name {
				continue
			}
			for _, ep := range s.Endpoints {
				if ep.Conditions.Ready != nil && *ep.Conditions.Ready {
					e.Endpoints.Ready++
				} else {
					e.Endpoints.NotReady++
				}
			}
		}

		// health
		e.Health = computeHealth(svc, e)

		// exposures
		e.Exposures = append(e.Exposures, ingressExposures(svc, ingresses)...)
		if b.gatewayAPI {
			e.Exposures = append(e.Exposures, b.routeExposures(svc, routes)...)
		}
		if b.istioEnabled() {
			e.Exposures = append(e.Exposures, b.istioExposures(svc, istio)...)
		}
		e.Exposures = append(e.Exposures, serviceExposures(svc, nodeAddr)...)
		if u := svc.Annotations[annURL]; u != "" {
			e.Exposures = append([]*kmatev1.Exposure{{Kind: "Annotation", Url: u}}, e.Exposures...)
		}
		out[e.Id] = e
	}
	return out
}

func filterAnnotations(a map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range a {
		if strings.HasPrefix(k, "kmate.io/") || k == annHelmRelease {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func isPodReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func resolveOwner(p *corev1.Pod, rsByName map[string]*appsv1.ReplicaSet) (string, string) {
	if len(p.OwnerReferences) == 0 {
		return "Pod", p.Name
	}
	o := p.OwnerReferences[0]
	if o.Kind == "ReplicaSet" {
		if rs := rsByName[o.Name]; rs != nil && len(rs.OwnerReferences) > 0 {
			return rs.OwnerReferences[0].Kind, rs.OwnerReferences[0].Name
		}
	}
	return o.Kind, o.Name
}

// healthCounts reports whether a workload kind participates in health.
// Jobs and CronJobs are batch work; their pods come and go and must not
// make a long-running service look degraded.
func healthCounts(kind string) bool {
	return kind != "Job" && kind != "CronJob"
}

func computeHealth(svc *corev1.Service, e *kmatev1.CatalogEntry) kmatev1.Health {
	if svc.Spec.Type == corev1.ServiceTypeExternalName || len(svc.Spec.Selector) == 0 {
		return kmatev1.Health_HEALTH_NO_SELECTOR
	}
	var desired, ready int32
	counted := 0
	for _, w := range e.Workloads {
		if !healthCounts(w.Kind) {
			continue
		}
		counted++
		desired += w.Desired
		ready += w.Ready
	}
	if counted == 0 {
		// selector matches no pods
		if e.Endpoints.Ready > 0 {
			return kmatev1.Health_HEALTH_HEALTHY
		}
		return kmatev1.Health_HEALTH_DOWN
	}
	epReady := e.Endpoints.Ready
	switch {
	case desired == 0:
		return kmatev1.Health_HEALTH_DOWN
	case epReady >= 1 && ready >= desired:
		return kmatev1.Health_HEALTH_HEALTHY
	case epReady >= 1 || ready >= 1:
		return kmatev1.Health_HEALTH_DEGRADED
	default:
		return kmatev1.Health_HEALTH_DOWN
	}
}

func lbAddresses(ing []netv1.IngressLoadBalancerIngress) []string {
	var out []string
	for _, i := range ing {
		if i.IP != "" {
			out = append(out, i.IP)
		} else if i.Hostname != "" {
			out = append(out, i.Hostname)
		}
	}
	return out
}

func ingressExposures(svc *corev1.Service, ingresses []*netv1.Ingress) []*kmatev1.Exposure {
	var out []*kmatev1.Exposure
	for _, ing := range ingresses {
		tlsHosts := map[string]bool{}
		anyTLS := false
		for _, t := range ing.Spec.TLS {
			anyTLS = true
			for _, h := range t.Hosts {
				tlsHosts[h] = true
			}
		}
		class := ""
		if ing.Spec.IngressClassName != nil {
			class = *ing.Spec.IngressClassName
		} else if c := ing.Annotations["kubernetes.io/ingress.class"]; c != "" {
			class = c
		}
		addrs := lbAddresses(ing.Status.LoadBalancer.Ingress)
		mk := func(host, path, pathType string, port int32) *kmatev1.Exposure {
			tls := tlsHosts[host] || (host == "" && anyTLS) || matchWildcardTLS(host, tlsHosts)
			x := &kmatev1.Exposure{Kind: "Ingress", Name: ing.Name, Class: class, Host: host, Path: path, PathType: pathType, Tls: tls, Addresses: addrs, Port: port}
			x.Url = buildURL(tls, host, addrs, path, 0)
			return x
		}
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil && ing.Spec.DefaultBackend.Service.Name == svc.Name {
			out = append(out, mk("", "/", "Prefix", ing.Spec.DefaultBackend.Service.Port.Number))
		}
		for _, rule := range ing.Spec.Rules {
			if rule.HTTP == nil {
				continue
			}
			for _, p := range rule.HTTP.Paths {
				if p.Backend.Service == nil || p.Backend.Service.Name != svc.Name {
					continue
				}
				pt := "Prefix"
				if p.PathType != nil {
					pt = string(*p.PathType)
				}
				path := p.Path
				if path == "" {
					path = "/"
				}
				out = append(out, mk(rule.Host, path, pt, p.Backend.Service.Port.Number))
			}
		}
	}
	return out
}

func matchWildcardTLS(host string, tlsHosts map[string]bool) bool {
	if host == "" {
		return false
	}
	if i := strings.Index(host, "."); i > 0 {
		return tlsHosts["*"+host[i:]]
	}
	return false
}

func buildURL(tls bool, host string, addrs []string, path string, port int32) string {
	scheme := "http"
	if tls {
		scheme = "https"
	}
	h := host
	if h == "" && len(addrs) > 0 {
		h = addrs[0]
	}
	if h == "" {
		return ""
	}
	if strings.HasPrefix(h, "*.") {
		h = "any" + h[1:]
	}
	if port > 0 && !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) {
		h = h + ":" + strconv.Itoa(int(port))
	}
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	// strip regex-ish suffixes commonly used with rewrite annotations
	path = strings.TrimSuffix(path, "(/|$)(.*)")
	path = strings.TrimSuffix(path, "/*")
	return scheme + "://" + h + path
}

func serviceExposures(svc *corev1.Service, nodeAddr string) []*kmatev1.Exposure {
	var out []*kmatev1.Exposure
	switch svc.Spec.Type {
	case corev1.ServiceTypeLoadBalancer:
		var addrs []string
		for _, i := range svc.Status.LoadBalancer.Ingress {
			if i.IP != "" {
				addrs = append(addrs, i.IP)
			} else if i.Hostname != "" {
				addrs = append(addrs, i.Hostname)
			}
		}
		// A LoadBalancer with no allocated address (pending, or kind without an LB
		// provider) is not reachable yet; only the NodePort fallback applies.
		if len(addrs) > 0 {
			for _, p := range svc.Spec.Ports {
				x := &kmatev1.Exposure{Kind: "LoadBalancer", Addresses: addrs, Port: p.Port}
				x.Url = portURL(p, addrs[0], p.Port)
				out = append(out, x)
			}
		}
		// NodePort also allocated for LB services (unless disabled)
		fallthrough
	case corev1.ServiceTypeNodePort:
		for _, p := range svc.Spec.Ports {
			if p.NodePort == 0 {
				continue
			}
			x := &kmatev1.Exposure{Kind: "NodePort", Port: p.NodePort}
			if nodeAddr != "" {
				x.Addresses = []string{nodeAddr}
				x.Url = portURL(p, nodeAddr, p.NodePort)
			}
			out = append(out, x)
		}
	case corev1.ServiceTypeExternalName:
		x := &kmatev1.Exposure{Kind: "ExternalName", Host: svc.Spec.ExternalName}
		port := int32(0)
		if len(svc.Spec.Ports) > 0 {
			port = svc.Spec.Ports[0].Port
		}
		x.Port = port
		x.Url = buildURL(port == 443, svc.Spec.ExternalName, nil, "/", port)
		out = append(out, x)
	}
	return out
}

func portURL(p corev1.ServicePort, host string, port int32) string {
	scheme := "http"
	if p.Protocol != "" && p.Protocol != corev1.ProtocolTCP {
		return fmt.Sprintf("%s://%s:%d", strings.ToLower(string(p.Protocol)), host, port)
	}
	ap := ""
	if p.AppProtocol != nil {
		ap = strings.ToLower(*p.AppProtocol)
	}
	switch {
	case ap == "https" || p.Port == 443 || strings.Contains(p.Name, "https"):
		scheme = "https"
	case ap == "grpc":
		scheme = "grpc"
	case ap != "" && ap != "http" && ap != "http2":
		scheme = ap
	}
	if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
		return fmt.Sprintf("%s://%s/", scheme, host)
	}
	return fmt.Sprintf("%s://%s:%d/", scheme, host, port)
}

// routeExposures resolves Gateway API HTTPRoutes pointing at svc.
func (b *Builder) routeExposures(svc *corev1.Service, routes []*unstructured.Unstructured) []*kmatev1.Exposure {
	var out []*kmatev1.Exposure
	for _, r := range routes {
		rules, _, _ := unstructured.NestedSlice(r.Object, "spec", "rules")
		var matchedPaths []string
		for _, ru := range rules {
			rm, _ := ru.(map[string]interface{})
			refs, _, _ := unstructured.NestedSlice(rm, "backendRefs")
			hit := false
			for _, ref := range refs {
				refm, _ := ref.(map[string]interface{})
				name, _ := refm["name"].(string)
				kind, _ := refm["kind"].(string)
				ns, _ := refm["namespace"].(string)
				if (kind == "" || kind == "Service") && name == svc.Name && (ns == "" || ns == svc.Namespace) {
					hit = true
				}
			}
			if !hit {
				continue
			}
			matches, _, _ := unstructured.NestedSlice(rm, "matches")
			if len(matches) == 0 {
				matchedPaths = append(matchedPaths, "/")
			}
			for _, m := range matches {
				mm, _ := m.(map[string]interface{})
				p, _, _ := unstructured.NestedString(mm, "path", "value")
				if p == "" {
					p = "/"
				}
				matchedPaths = append(matchedPaths, p)
			}
		}
		if len(matchedPaths) == 0 {
			continue
		}
		hostnames, _, _ := unstructured.NestedStringSlice(r.Object, "spec", "hostnames")
		parents, _, _ := unstructured.NestedSlice(r.Object, "spec", "parentRefs")
		for _, p := range parents {
			pm, _ := p.(map[string]interface{})
			gwName, _ := pm["name"].(string)
			gwNS, _ := pm["namespace"].(string)
			if gwNS == "" {
				gwNS = r.GetNamespace()
			}
			gw := b.findGateway(gwNS, gwName)
			var addrs []string
			tls := false
			var gwHosts []string
			if gw != nil {
				ga, _, _ := unstructured.NestedSlice(gw.Object, "status", "addresses")
				for _, a := range ga {
					am, _ := a.(map[string]interface{})
					if v, ok := am["value"].(string); ok {
						addrs = append(addrs, v)
					}
				}
				listeners, _, _ := unstructured.NestedSlice(gw.Object, "spec", "listeners")
				for _, l := range listeners {
					lm, _ := l.(map[string]interface{})
					proto, _ := lm["protocol"].(string)
					if proto == "HTTPS" || proto == "TLS" {
						tls = true
					}
					if h, ok := lm["hostname"].(string); ok && h != "" {
						gwHosts = append(gwHosts, h)
					}
				}
			}
			hosts := hostnames
			if len(hosts) == 0 {
				hosts = gwHosts
			}
			if len(hosts) == 0 {
				hosts = []string{""}
			}
			for _, h := range hosts {
				for _, path := range matchedPaths {
					x := &kmatev1.Exposure{Kind: "HTTPRoute", Name: r.GetName(), Class: gwNS + "/" + gwName, Host: h, Path: path, PathType: "PathPrefix", Tls: tls, Addresses: addrs}
					x.Url = buildURL(tls, h, addrs, path, 0)
					out = append(out, x)
				}
			}
		}
	}
	return out
}

func (b *Builder) findGateway(ns, name string) *unstructured.Unstructured {
	for _, inf := range b.gateways {
		if o, ok, _ := inf.GetStore().GetByKey(ns + "/" + name); ok {
			return o.(*unstructured.Unstructured)
		}
	}
	return nil
}

func (b *Builder) probeLoop(ctx context.Context) {
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	t := time.NewTicker(b.opts.ProbeInterval)
	defer t.Stop()
	for {
		urls := map[string]bool{}
		b.mu.RLock()
		for _, e := range b.entries {
			for _, x := range e.Exposures {
				if strings.HasPrefix(x.Url, "http") {
					urls[x.Url] = true
				}
			}
		}
		b.mu.RUnlock()
		results := map[string]*kmatev1.ProbeResult{}
		for u := range urls {
			start := time.Now()
			req, _ := http.NewRequestWithContext(ctx, http.MethodHead, u, nil)
			res := &kmatev1.ProbeResult{CheckedAt: timestamppb.Now()}
			resp, err := client.Do(req)
			res.LatencyMs = time.Since(start).Milliseconds()
			if err != nil {
				res.Error = err.Error()
			} else {
				res.StatusCode = int32(resp.StatusCode)
				resp.Body.Close()
			}
			results[u] = res
		}
		b.mu.Lock()
		b.probes = results
		for _, e := range b.entries {
			e.Probes = map[string]*kmatev1.ProbeResult{}
			for _, x := range e.Exposures {
				if r, ok := results[x.Url]; ok {
					e.Probes[x.Url] = r
				}
			}
		}
		b.version++
		snap := b.snapshotLocked()
		for _, ch := range b.subs {
			select {
			case ch <- snap:
			default:
			}
		}
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
