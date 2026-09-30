// Package cache serves list/watch requests from lazily-created dynamic
// informers so that clients never trigger LIST calls on the API server.
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

const (
	idleTimeout    = 10 * time.Minute
	resyncPeriod   = 0
	discoveryEvery = 5 * time.Minute
)

// Event is a watch event produced by the cache.
type Event struct {
	Type   kmatev1.EventType
	Object *unstructured.Unstructured
	Synced bool
	Err    error
}

// Cache manages lazy informers.
type Cache struct {
	clients    *kube.Clients
	namespaces []string // empty = all
	log        *slog.Logger

	mu        sync.Mutex
	informers map[schema.GroupVersionResource]*entry
}

type entry struct {
	gvr       schema.GroupVersionResource
	informers []cache.SharedIndexInformer // one per namespace scope (or one for all)
	stop      chan struct{}
	lastUsed  time.Time
	watchers  int
	synced    bool
	mu        sync.Mutex
	handlers  map[uint64]*watcher
	nextID    uint64
}

type watcher struct {
	ns   string
	lsel labels.Selector
	fsel fields.Selector
	ch   chan Event
	ctx  context.Context
	stop func()
}

// New creates a Cache. namespaces scopes informers; empty means cluster-wide.
func New(c *kube.Clients, namespaces []string, log *slog.Logger) *Cache {
	cc := &Cache{clients: c, namespaces: namespaces, log: log, informers: map[schema.GroupVersionResource]*entry{}}
	return cc
}

// Run performs periodic maintenance until ctx is done.
func (c *Cache) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	d := time.NewTicker(discoveryEvery)
	defer t.Stop()
	defer d.Stop()
	for {
		select {
		case <-ctx.Done():
			c.mu.Lock()
			for _, e := range c.informers {
				close(e.stop)
			}
			c.informers = map[schema.GroupVersionResource]*entry{}
			c.mu.Unlock()
			return
		case <-t.C:
			c.gc()
		case <-d.C:
			c.clients.RefreshDiscovery()
		}
	}
}

func (c *Cache) gc() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for gvr, e := range c.informers {
		e.mu.Lock()
		idle := e.watchers == 0 && time.Since(e.lastUsed) > idleTimeout
		e.mu.Unlock()
		if idle {
			c.log.Info("cache: tearing down idle informer", "gvr", gvr.String())
			close(e.stop)
			delete(c.informers, gvr)
		}
	}
}

// Stats returns object counts per GVR (for /metrics).
func (c *Cache) Stats() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := map[string]int{}
	for gvr, e := range c.informers {
		n := 0
		for _, inf := range e.informers {
			n += len(inf.GetStore().ListKeys())
		}
		out[gvr.String()] = n
	}
	return out
}

// GVR converts the proto GVR.
func GVR(g *kmatev1.GVR) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: g.GetGroup(), Version: g.GetVersion(), Resource: g.GetResource()}
}

func (c *Cache) get(ctx context.Context, gvr schema.GroupVersionResource) (*entry, error) {
	c.mu.Lock()
	e, ok := c.informers[gvr]
	if ok {
		e.mu.Lock()
		e.lastUsed = time.Now()
		e.mu.Unlock()
		c.mu.Unlock()
	} else {
		// validate the resource exists
		if _, err := c.clients.Mapper.KindFor(gvr); err != nil {
			c.mu.Unlock()
			return nil, fmt.Errorf("unknown resource %s: %w", gvr.String(), err)
		}
		e = &entry{gvr: gvr, stop: make(chan struct{}), lastUsed: time.Now(), handlers: map[uint64]*watcher{}}
		scopes := c.namespaces
		if len(scopes) == 0 {
			scopes = []string{metav1.NamespaceAll}
		}
		for _, ns := range scopes {
			f := dynamicinformer.NewFilteredDynamicSharedInformerFactory(c.clients.Dynamic, resyncPeriod, ns, nil)
			inf := f.ForResource(gvr).Informer()
			_ = inf.SetTransform(stripManagedFields)
			e.informers = append(e.informers, inf)
			ent := e
			_, _ = inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
				AddFunc:    func(obj interface{}) { ent.broadcast(kmatev1.EventType_EVENT_TYPE_ADDED, obj) },
				UpdateFunc: func(_, obj interface{}) { ent.broadcast(kmatev1.EventType_EVENT_TYPE_MODIFIED, obj) },
				DeleteFunc: func(obj interface{}) { ent.broadcast(kmatev1.EventType_EVENT_TYPE_DELETED, obj) },
			})
			go inf.Run(e.stop)
		}
		c.informers[gvr] = e
		c.mu.Unlock()
		c.log.Info("cache: started informer", "gvr", gvr.String())
	}
	// wait for sync
	syncCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	for _, inf := range e.informers {
		if !cache.WaitForCacheSync(syncCtx.Done(), inf.HasSynced) {
			return nil, fmt.Errorf("informer for %s did not sync", gvr.String())
		}
	}
	e.mu.Lock()
	e.synced = true
	e.mu.Unlock()
	return e, nil
}

func stripManagedFields(obj interface{}) (interface{}, error) {
	if u, ok := obj.(*unstructured.Unstructured); ok {
		unstructured.RemoveNestedField(u.Object, "metadata", "managedFields")
	}
	return obj, nil
}

func (e *entry) broadcast(t kmatev1.EventType, obj interface{}) {
	if d, ok := obj.(cache.DeletedFinalStateUnknown); ok {
		obj = d.Obj
	}
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return
	}
	e.mu.Lock()
	ws := make([]*watcher, 0, len(e.handlers))
	for _, w := range e.handlers {
		ws = append(ws, w)
	}
	e.mu.Unlock()
	for _, w := range ws {
		if !w.matches(u) {
			continue
		}
		select {
		case w.ch <- Event{Type: t, Object: u}:
		case <-w.ctx.Done():
		}
	}
}

func (w *watcher) matches(u *unstructured.Unstructured) bool {
	if w.ns != "" && u.GetNamespace() != w.ns {
		return false
	}
	if w.lsel != nil && !w.lsel.Matches(labels.Set(u.GetLabels())) {
		return false
	}
	if w.fsel != nil && !w.fsel.Empty() {
		if !w.fsel.Matches(fieldSetFor(u, w.fsel)) {
			return false
		}
	}
	return true
}

// fieldSetFor resolves every field path the selector references against the
// object, so selectors like spec.nodeName=x, status.phase=Running or
// involvedObject.name=y work from the cache the same way they do server-side.
// Non-string leaves (numbers, bools) are rendered with %v.
func fieldSetFor(u *unstructured.Unstructured, sel fields.Selector) fields.Set {
	set := fields.Set{"metadata.name": u.GetName(), "metadata.namespace": u.GetNamespace()}
	for _, r := range sel.Requirements() {
		if _, ok := set[r.Field]; ok {
			continue
		}
		v, found, err := unstructured.NestedFieldNoCopy(u.Object, strings.Split(r.Field, ".")...)
		if err != nil || !found || v == nil {
			set[r.Field] = ""
			continue
		}
		switch t := v.(type) {
		case string:
			set[r.Field] = t
		default:
			set[r.Field] = fmt.Sprintf("%v", t)
		}
	}
	return set
}

func selectors(opts *kmatev1.ListOptions) (labels.Selector, fields.Selector, error) {
	var lsel labels.Selector
	var fsel fields.Selector
	var err error
	if opts.GetLabelSelector() != "" {
		lsel, err = labels.Parse(opts.GetLabelSelector())
		if err != nil {
			return nil, nil, fmt.Errorf("bad label selector: %w", err)
		}
	}
	if opts.GetFieldSelector() != "" {
		fsel, err = fields.ParseSelector(opts.GetFieldSelector())
		if err != nil {
			return nil, nil, fmt.Errorf("bad field selector: %w", err)
		}
	}
	return lsel, fsel, nil
}

func (e *entry) list(w *watcher) []*unstructured.Unstructured {
	var out []*unstructured.Unstructured
	for _, inf := range e.informers {
		for _, o := range inf.GetStore().List() {
			u, ok := o.(*unstructured.Unstructured)
			if !ok || !w.matches(u) {
				continue
			}
			out = append(out, u)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GetNamespace() != out[j].GetNamespace() {
			return out[i].GetNamespace() < out[j].GetNamespace()
		}
		return out[i].GetName() < out[j].GetName()
	})
	return out
}

// List returns objects from the cache.
func (c *Cache) List(ctx context.Context, gvr schema.GroupVersionResource, opts *kmatev1.ListOptions) ([]*unstructured.Unstructured, error) {
	e, err := c.get(ctx, gvr)
	if err != nil {
		return nil, err
	}
	lsel, fsel, err := selectors(opts)
	if err != nil {
		return nil, err
	}
	w := &watcher{ns: opts.GetNamespace(), lsel: lsel, fsel: fsel}
	items := e.list(w)
	if opts.GetLimit() > 0 && int(opts.GetLimit()) < len(items) {
		items = items[:opts.GetLimit()]
	}
	return items, nil
}

// Get returns a single object from the cache (falls back to API on miss).
func (c *Cache) Get(ctx context.Context, gvr schema.GroupVersionResource, ns, name string) (*unstructured.Unstructured, error) {
	e, err := c.get(ctx, gvr)
	if err != nil {
		return nil, err
	}
	key := name
	if ns != "" {
		key = ns + "/" + name
	}
	for _, inf := range e.informers {
		if o, ok, _ := inf.GetStore().GetByKey(key); ok {
			return o.(*unstructured.Unstructured), nil
		}
	}
	return nil, nil
}

// Watch streams events. The returned channel first yields SYNC events for every
// current object, then a Synced marker, then live events. Call stop to release.
func (c *Cache) Watch(ctx context.Context, gvr schema.GroupVersionResource, opts *kmatev1.ListOptions) (<-chan Event, func(), error) {
	e, err := c.get(ctx, gvr)
	if err != nil {
		return nil, nil, err
	}
	lsel, fsel, err := selectors(opts)
	if err != nil {
		return nil, nil, err
	}
	wctx, cancel := context.WithCancel(ctx)
	w := &watcher{ns: opts.GetNamespace(), lsel: lsel, fsel: fsel, ch: make(chan Event, 1024), ctx: wctx}
	e.mu.Lock()
	id := e.nextID
	e.nextID++
	e.watchers++
	initial := e.list(w) // snapshot under lock so live events after it are consistent
	e.handlers[id] = w
	e.mu.Unlock()

	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			e.mu.Lock()
			delete(e.handlers, id)
			e.watchers--
			e.lastUsed = time.Now()
			e.mu.Unlock()
		})
	}
	w.stop = stop

	out := make(chan Event, 256)
	go func() {
		defer close(out)
		for _, u := range initial {
			select {
			case out <- Event{Type: kmatev1.EventType_EVENT_TYPE_SYNC, Object: u}:
			case <-wctx.Done():
				return
			}
		}
		select {
		case out <- Event{Type: kmatev1.EventType_EVENT_TYPE_SYNC, Synced: true}:
		case <-wctx.Done():
			return
		}
		for {
			select {
			case ev := <-w.ch:
				select {
				case out <- ev:
				case <-wctx.Done():
					return
				}
			case <-wctx.Done():
				return
			}
		}
	}()
	return out, stop, nil
}

// ToKubeObject encodes an unstructured object into the wire form.
func ToKubeObject(u *unstructured.Unstructured, columnsOnly bool) (*kmatev1.KubeObject, error) {
	obj := u
	if columnsOnly {
		obj = Project(u)
	}
	b, err := json.Marshal(obj.Object)
	if err != nil {
		return nil, err
	}
	return &kmatev1.KubeObject{
		Json:            b,
		ApiVersion:      u.GetAPIVersion(),
		Kind:            u.GetKind(),
		Namespace:       u.GetNamespace(),
		Name:            u.GetName(),
		Uid:             string(u.GetUID()),
		ResourceVersion: u.GetResourceVersion(),
	}, nil
}

// specAllowlist lists spec fields kept in columns_only projections per kind.
var specAllowlist = map[string][]string{
	"Pod":                     {"nodeName", "containers", "initContainers", "serviceAccountName", "restartPolicy"},
	"Deployment":              {"replicas", "strategy", "selector"},
	"StatefulSet":             {"replicas", "serviceName", "selector"},
	"DaemonSet":               {"selector"},
	"ReplicaSet":              {"replicas", "selector"},
	"Job":                     {"completions", "parallelism", "selector"},
	"CronJob":                 {"schedule", "suspend"},
	"Service":                 {"type", "clusterIP", "clusterIPs", "ports", "selector", "externalName", "externalIPs"},
	"Ingress":                 {"*"},
	"HTTPRoute":               {"*"},
	"Gateway":                 {"*"},
	"Node":                    {"podCIDR", "providerID", "taints", "unschedulable"},
	"PersistentVolumeClaim":   {"accessModes", "resources", "storageClassName", "volumeName", "volumeMode"},
	"PersistentVolume":        {"accessModes", "capacity", "storageClassName", "claimRef", "persistentVolumeReclaimPolicy"},
	"HorizontalPodAutoscaler": {"*"},
	"Namespace":               {"*"},
	"ConfigMap":               {},
	"Secret":                  {},
}

// Project trims an object for table views.
func Project(u *unstructured.Unstructured) *unstructured.Unstructured {
	out := &unstructured.Unstructured{Object: map[string]interface{}{}}
	out.Object["apiVersion"] = u.GetAPIVersion()
	out.Object["kind"] = u.GetKind()
	md := map[string]interface{}{
		"name":            u.GetName(),
		"uid":             string(u.GetUID()),
		"resourceVersion": u.GetResourceVersion(),
	}
	if ns := u.GetNamespace(); ns != "" {
		md["namespace"] = ns
	}
	if ct, ok, _ := unstructured.NestedString(u.Object, "metadata", "creationTimestamp"); ok {
		md["creationTimestamp"] = ct
	}
	if dt, ok, _ := unstructured.NestedString(u.Object, "metadata", "deletionTimestamp"); ok {
		md["deletionTimestamp"] = dt
	}
	if l := u.GetLabels(); len(l) > 0 {
		md["labels"] = toIface(l)
	}
	ann := map[string]interface{}{}
	for k, v := range u.GetAnnotations() {
		if strings.HasPrefix(k, "kmate.io/") || k == "meta.helm.sh/release-name" || k == "deployment.kubernetes.io/revision" {
			ann[k] = v
		}
	}
	if len(ann) > 0 {
		md["annotations"] = ann
	}
	if ors, ok, _ := unstructured.NestedSlice(u.Object, "metadata", "ownerReferences"); ok {
		md["ownerReferences"] = ors
	}
	out.Object["metadata"] = md
	if st, ok, _ := unstructured.NestedMap(u.Object, "status"); ok {
		out.Object["status"] = st
	}
	if spec, ok, _ := unstructured.NestedMap(u.Object, "spec"); ok {
		allow, known := specAllowlist[u.GetKind()]
		switch {
		case !known:
			// unknown kinds (CRDs): keep spec, it's usually small and needed for columns
			out.Object["spec"] = spec
		case len(allow) == 1 && allow[0] == "*":
			out.Object["spec"] = spec
		default:
			trimmed := map[string]interface{}{}
			for _, k := range allow {
				if v, ok := spec[k]; ok {
					trimmed[k] = v
				}
			}
			if u.GetKind() == "Pod" {
				for _, key := range []string{"containers", "initContainers"} {
					if cs, ok := trimmed[key].([]interface{}); ok {
						var slim []interface{}
						for _, c := range cs {
							if cm, ok := c.(map[string]interface{}); ok {
								sc := map[string]interface{}{"name": cm["name"], "image": cm["image"], "ports": cm["ports"]}
								// restartPolicy: Always marks a native sidecar (init container that keeps running)
								if rp, ok := cm["restartPolicy"]; ok {
									sc["restartPolicy"] = rp
								}
								slim = append(slim, sc)
							}
						}
						trimmed[key] = slim
					}
				}
			}
			out.Object["spec"] = trimmed
		}
	}
	if u.GetKind() == "Secret" {
		// never ship secret data in table mode
		if d, ok, _ := unstructured.NestedMap(u.Object, "data"); ok {
			keys := map[string]interface{}{}
			for k := range d {
				keys[k] = ""
			}
			out.Object["data"] = keys
		}
		if t, ok, _ := unstructured.NestedString(u.Object, "type"); ok {
			out.Object["type"] = t
		}
	}
	if u.GetKind() == "ConfigMap" {
		if d, ok, _ := unstructured.NestedMap(u.Object, "data"); ok {
			keys := map[string]interface{}{}
			for k := range d {
				keys[k] = ""
			}
			out.Object["data"] = keys
		}
	}
	return out
}

func toIface(m map[string]string) map[string]interface{} {
	o := make(map[string]interface{}, len(m))
	for k, v := range m {
		o[k] = v
	}
	return o
}

// Ensure meta import used (RESTMapper errors).
var _ = meta.NoKindMatchError{}
