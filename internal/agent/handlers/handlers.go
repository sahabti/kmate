// Package handlers services tunnel requests from the hub.
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/cache"
	"github.com/kmate-dev/kmate/internal/agent/discovery"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"github.com/kmate-dev/kmate/internal/mux"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

const unaryTimeout = 30 * time.Second

// Handler dispatches requests.
type Handler struct {
	Clients  *kube.Clients
	Cache    *cache.Cache
	Catalog  *discovery.Builder
	Log      *slog.Logger
	CanExec  bool
	CanWrite bool
}

// Dispatch handles one stream whose first frame is req. It always closes the stream.
func (h *Handler) Dispatch(ctx context.Context, st *mux.Stream, req *kmatev1.Request) {
	log := h.Log.With("stream", st.ID, "request_id", req.GetRequestId(), "user", req.GetIdentity().GetUser())
	start := time.Now()
	var err error
	switch k := req.Kind.(type) {
	case *kmatev1.Request_Discover:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.discover(ctx, req) })
	case *kmatev1.Request_List:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.list(ctx, k.List) })
	case *kmatev1.Request_Get:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.get(ctx, req, k.Get) })
	case *kmatev1.Request_Watch:
		err = h.watch(ctx, st, k.Watch)
	case *kmatev1.Request_Apply:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.apply(ctx, req, k.Apply) })
	case *kmatev1.Request_Patch:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.patch(ctx, req, k.Patch) })
	case *kmatev1.Request_Delete:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.delete(ctx, req, k.Delete) })
	case *kmatev1.Request_Scale:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.scale(ctx, req, k.Scale) })
	case *kmatev1.Request_RolloutRestart:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) {
			return h.rolloutRestart(ctx, req, k.RolloutRestart)
		})
	case *kmatev1.Request_Logs:
		err = h.logs(ctx, st, req, k.Logs)
	case *kmatev1.Request_Exec:
		err = h.exec(ctx, st, req, k.Exec)
	case *kmatev1.Request_PortForward:
		err = h.portForward(ctx, st, req, k.PortForward)
	case *kmatev1.Request_Catalog:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) {
			var c *kmatev1.Catalog
			if h.Catalog != nil {
				c = h.Catalog.Current()
			}
			return &kmatev1.Response{Kind: &kmatev1.Response_Catalog{Catalog: &kmatev1.CatalogResponse{Catalog: c}}}, nil
		})
	case *kmatev1.Request_HelmList:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.helmList(ctx, req, k.HelmList) })
	case *kmatev1.Request_HelmGet:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.helmGet(ctx, req, k.HelmGet) })
	case *kmatev1.Request_Metrics:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) { return h.metrics(ctx, req, k.Metrics) })
	case *kmatev1.Request_ClusterInfo:
		err = h.unary(ctx, st, func(ctx context.Context) (*kmatev1.Response, error) {
			var v int64
			if h.Catalog != nil {
				v = h.Catalog.Version()
			}
			return &kmatev1.Response{Kind: &kmatev1.Response_ClusterInfo{ClusterInfo: &kmatev1.ClusterInfoResponse{Info: h.Clients.ClusterInfo(ctx, v)}}}, nil
		})
	default:
		err = fmt.Errorf("unsupported request kind %T", req.Kind)
		_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Response{Response: &kmatev1.Response{Error: toError(err)}}})
		_ = st.Close(toError(err))
	}
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, mux.ErrStreamClosed) {
		log.Warn("request failed", "kind", fmt.Sprintf("%T", req.Kind), "err", err, "took", time.Since(start))
	} else {
		log.Debug("request done", "kind", fmt.Sprintf("%T", req.Kind), "took", time.Since(start))
	}
}

func (h *Handler) unary(ctx context.Context, st *mux.Stream, fn func(context.Context) (*kmatev1.Response, error)) error {
	ctx, cancel := context.WithTimeout(ctx, unaryTimeout)
	defer cancel()
	resp, err := fn(ctx)
	if err != nil {
		resp = &kmatev1.Response{Error: toError(err)}
	}
	if serr := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_Response{Response: resp}}); serr != nil {
		return serr
	}
	_ = st.Close(nil)
	return err
}

func toError(err error) *kmatev1.Error {
	if err == nil {
		return nil
	}
	var se *apierrors.StatusError
	if errors.As(err, &se) {
		return &kmatev1.Error{Code: se.ErrStatus.Code, Reason: string(se.ErrStatus.Reason), Message: se.ErrStatus.Message}
	}
	code := int32(500)
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		code = 504
	case strings.Contains(err.Error(), "unknown resource"), strings.Contains(err.Error(), "not found"):
		code = 404
	case strings.Contains(err.Error(), "forbidden"):
		code = 403
	case strings.Contains(err.Error(), "bad "), strings.Contains(err.Error(), "invalid"):
		code = 400
	}
	return &kmatev1.Error{Code: code, Message: err.Error()}
}

func (h *Handler) discover(ctx context.Context, _ *kmatev1.Request) (*kmatev1.Response, error) {
	_, lists, err := h.Clients.Discovery.ServerGroupsAndResources()
	if err != nil && len(lists) == 0 {
		return nil, err
	}
	out := &kmatev1.DiscoverResponse{}
	for _, l := range lists {
		gv, err := schema.ParseGroupVersion(l.GroupVersion)
		if err != nil {
			continue
		}
		for _, r := range l.APIResources {
			if strings.Contains(r.Name, "/") {
				continue // subresource
			}
			if !contains(r.Verbs, "list") || !contains(r.Verbs, "watch") {
				continue
			}
			out.Resources = append(out.Resources, &kmatev1.APIResource{
				Gvr:        &kmatev1.GVR{Group: gv.Group, Version: gv.Version, Resource: r.Name},
				Kind:       r.Kind,
				Namespaced: r.Namespaced,
				Verbs:      r.Verbs,
				ShortNames: r.ShortNames,
				Categories: r.Categories,
			})
		}
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Discover{Discover: out}}, nil
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func (h *Handler) list(ctx context.Context, req *kmatev1.ListRequest) (*kmatev1.Response, error) {
	items, err := h.Cache.List(ctx, cache.GVR(req.Gvr), req.Options)
	if err != nil {
		return nil, err
	}
	out := &kmatev1.ListResponse{}
	for _, u := range items {
		ko, err := cache.ToKubeObject(u, req.GetOptions().GetColumnsOnly())
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, ko)
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_List{List: out}}, nil
}

func (h *Handler) get(ctx context.Context, req *kmatev1.Request, g *kmatev1.GetRequest) (*kmatev1.Response, error) {
	gvr := cache.GVR(g.GetRef().GetGvr())
	u, err := h.Cache.Get(ctx, gvr, g.GetRef().GetNamespace(), g.GetRef().GetName())
	if err != nil {
		return nil, err
	}
	if u == nil {
		// fall back to a live GET (object may be outside informer scope)
		dyn, _ := h.Clients.ForIdentity(req.Identity)
		u, err = dyn.Resource(gvr).Namespace(g.GetRef().GetNamespace()).Get(ctx, g.GetRef().GetName(), metav1.GetOptions{})
		if err != nil {
			return nil, err
		}
		unstructured.RemoveNestedField(u.Object, "metadata", "managedFields")
	}
	ko, err := cache.ToKubeObject(u, false)
	if err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Get{Get: &kmatev1.GetResponse{Object: ko}}}, nil
}

func (h *Handler) watch(ctx context.Context, st *mux.Stream, req *kmatev1.WatchRequest) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	events, stop, err := h.Cache.Watch(ctx, cache.GVR(req.Gvr), req.Options)
	if err != nil {
		_ = st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_WatchEvent{WatchEvent: &kmatev1.WatchEvent{Type: kmatev1.EventType_EVENT_TYPE_ERROR, Error: toError(err)}}})
		_ = st.Close(toError(err))
		return err
	}
	defer stop()
	// watch for peer close
	go func() {
		for {
			f, err := st.Recv(ctx)
			if err != nil {
				cancel()
				return
			}
			if f.GetClose() != nil {
				cancel()
				return
			}
		}
	}()
	columns := req.GetOptions().GetColumnsOnly()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-st.Context().Done():
			return st.Err()
		case ev, ok := <-events:
			if !ok {
				_ = st.Close(nil)
				return nil
			}
			we := &kmatev1.WatchEvent{Type: ev.Type, Synced: ev.Synced}
			if ev.Object != nil {
				ko, err := cache.ToKubeObject(ev.Object, columns)
				if err != nil {
					continue
				}
				we.Object = ko
			}
			if err := st.Send(&kmatev1.Frame{Payload: &kmatev1.Frame_WatchEvent{WatchEvent: we}}); err != nil {
				return err
			}
		}
	}
}

func (h *Handler) gvrFor(apiVersion, kind string) (schema.GroupVersionResource, error) {
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return schema.GroupVersionResource{}, err
	}
	m, err := h.Clients.Mapper.RESTMapping(schema.GroupKind{Group: gv.Group, Kind: kind}, gv.Version)
	if err != nil {
		return schema.GroupVersionResource{}, err
	}
	return m.Resource, nil
}

func (h *Handler) apply(ctx context.Context, req *kmatev1.Request, a *kmatev1.ApplyRequest) (*kmatev1.Response, error) {
	if !h.CanWrite {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("agent is read-only (rbac.write=false)"))
	}
	u := &unstructured.Unstructured{}
	if err := json.Unmarshal(a.GetObject().GetJson(), &u.Object); err != nil {
		return nil, fmt.Errorf("invalid object json: %w", err)
	}
	gvr, err := h.gvrFor(u.GetAPIVersion(), u.GetKind())
	if err != nil {
		return nil, err
	}
	fm := a.FieldManager
	if fm == "" {
		fm = "kmate"
	}
	opts := metav1.ApplyOptions{FieldManager: fm, Force: a.Force}
	if a.DryRun {
		opts.DryRun = []string{metav1.DryRunAll}
	}
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	res, err := dyn.Resource(gvr).Namespace(u.GetNamespace()).Apply(ctx, u.GetName(), u, opts)
	if err != nil {
		return nil, err
	}
	unstructured.RemoveNestedField(res.Object, "metadata", "managedFields")
	ko, err := cache.ToKubeObject(res, false)
	if err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Apply{Apply: &kmatev1.ApplyResponse{Object: ko}}}, nil
}

func (h *Handler) patch(ctx context.Context, req *kmatev1.Request, p *kmatev1.PatchRequest) (*kmatev1.Response, error) {
	if !h.CanWrite {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("agent is read-only (rbac.write=false)"))
	}
	pt := types.PatchType(p.PatchType)
	if pt == "" {
		pt = types.MergePatchType
	}
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	ref := p.GetRef()
	res, err := dyn.Resource(cache.GVR(ref.GetGvr())).Namespace(ref.GetNamespace()).Patch(ctx, ref.GetName(), pt, p.Patch, metav1.PatchOptions{FieldManager: "kmate"})
	if err != nil {
		return nil, err
	}
	unstructured.RemoveNestedField(res.Object, "metadata", "managedFields")
	ko, err := cache.ToKubeObject(res, false)
	if err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Patch{Patch: &kmatev1.PatchResponse{Object: ko}}}, nil
}

func (h *Handler) delete(ctx context.Context, req *kmatev1.Request, d *kmatev1.DeleteRequest) (*kmatev1.Response, error) {
	if !h.CanWrite {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("agent is read-only (rbac.write=false)"))
	}
	opts := metav1.DeleteOptions{}
	if d.PropagationPolicy != "" {
		pp := metav1.DeletionPropagation(d.PropagationPolicy)
		opts.PropagationPolicy = &pp
	}
	if d.GracePeriodSeconds > 0 {
		g := d.GracePeriodSeconds
		opts.GracePeriodSeconds = &g
	}
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	ref := d.GetRef()
	if err := dyn.Resource(cache.GVR(ref.GetGvr())).Namespace(ref.GetNamespace()).Delete(ctx, ref.GetName(), opts); err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Delete{Delete: &kmatev1.DeleteResponse{}}}, nil
}

func (h *Handler) scale(ctx context.Context, req *kmatev1.Request, s *kmatev1.ScaleRequest) (*kmatev1.Response, error) {
	if !h.CanWrite {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("agent is read-only (rbac.write=false)"))
	}
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	ref := s.GetRef()
	patch := []byte(fmt.Sprintf(`{"spec":{"replicas":%d}}`, s.Replicas))
	res, err := dyn.Resource(cache.GVR(ref.GetGvr())).Namespace(ref.GetNamespace()).Patch(ctx, ref.GetName(), types.MergePatchType, patch, metav1.PatchOptions{FieldManager: "kmate"}, "scale")
	if err != nil {
		return nil, err
	}
	replicas, _, _ := unstructured.NestedInt64(res.Object, "spec", "replicas")
	return &kmatev1.Response{Kind: &kmatev1.Response_Scale{Scale: &kmatev1.ScaleResponse{Replicas: int32(replicas)}}}, nil
}

func (h *Handler) rolloutRestart(ctx context.Context, req *kmatev1.Request, r *kmatev1.RolloutRestartRequest) (*kmatev1.Response, error) {
	if !h.CanWrite {
		return nil, apierrors.NewForbidden(schema.GroupResource{}, "", errors.New("agent is read-only (rbac.write=false)"))
	}
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	ref := r.GetRef()
	patch := []byte(fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`, time.Now().UTC().Format(time.RFC3339)))
	if _, err := dyn.Resource(cache.GVR(ref.GetGvr())).Namespace(ref.GetNamespace()).Patch(ctx, ref.GetName(), types.StrategicMergePatchType, patch, metav1.PatchOptions{FieldManager: "kmate"}); err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_RolloutRestart{RolloutRestart: &kmatev1.RolloutRestartResponse{}}}, nil
}
