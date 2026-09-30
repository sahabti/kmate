package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/gen/go/kmate/v1/kmatev1connect"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

// ClusterService relays cluster operations to agents.
type ClusterService struct {
	kmatev1connect.UnimplementedClusterServiceHandler
	store *store.Store
	reg   *registry.Registry
	relay *relay.Relay
	log   *slog.Logger
}

// NewClusterService creates the handler.
func NewClusterService(st *store.Store, reg *registry.Registry, rl *relay.Relay, log *slog.Logger) *ClusterService {
	return &ClusterService{store: st, reg: reg, relay: rl, log: log}
}

// NewRequest builds an agent Request carrying the caller's identity.
func NewRequest(ctx context.Context) *kmatev1.Request {
	p := auth.FromContext(ctx)
	r := &kmatev1.Request{RequestId: uuid.NewString()}
	if p != nil {
		r.Identity = &kmatev1.Identity{User: p.Email, Groups: p.Groups()}
	}
	return r
}

func (c *ClusterService) audit(ctx context.Context, clusterID, action, target string, err error) {
	p := auth.FromContext(ctx)
	user := ""
	if p != nil {
		user = p.Email
	}
	res := "ok"
	if err != nil {
		res = "error: " + err.Error()
	}
	_ = c.store.Audit(ctx, store.AuditEvent{User: user, ClusterID: clusterID, Action: action, Target: target, Result: res})
}

func refString(r *kmatev1.ObjectRef) string {
	if r == nil {
		return ""
	}
	g := r.GetGvr()
	return fmt.Sprintf("%s/%s/%s %s/%s", g.GetGroup(), g.GetVersion(), g.GetResource(), r.GetNamespace(), r.GetName())
}

// Discover lists API resources.
func (c *ClusterService) Discover(ctx context.Context, req *connect.Request[kmatev1.ClusterDiscoverRequest]) (*connect.Response[kmatev1.DiscoverResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Discover{Discover: &kmatev1.DiscoverRequest{}}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetDiscover())), nil
}

// List lists objects.
func (c *ClusterService) List(ctx context.Context, req *connect.Request[kmatev1.ClusterListRequest]) (*connect.Response[kmatev1.ListResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_List{List: &kmatev1.ListRequest{Gvr: req.Msg.GetGvr(), Options: req.Msg.GetOptions()}}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetList())), nil
}

// Get fetches one object.
func (c *ClusterService) Get(ctx context.Context, req *connect.Request[kmatev1.ClusterGetRequest]) (*connect.Response[kmatev1.GetResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Get{Get: &kmatev1.GetRequest{Ref: req.Msg.GetRef()}}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetGet())), nil
}

// Watch streams watch events.
func (c *ClusterService) Watch(ctx context.Context, req *connect.Request[kmatev1.ClusterWatchRequest], stream *connect.ServerStream[kmatev1.WatchEvent]) error {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Watch{Watch: &kmatev1.WatchRequest{Gvr: req.Msg.GetGvr(), Options: req.Msg.GetOptions()}}
	st, err := c.relay.Stream(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return err
	}
	defer st.Close(nil)
	for {
		f, err := st.Recv(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return relay.TranslateErr(err)
		}
		switch p := f.Payload.(type) {
		case *kmatev1.Frame_WatchEvent:
			if err := stream.Send(p.WatchEvent); err != nil {
				return err
			}
		case *kmatev1.Frame_Response:
			if e := p.Response.GetError(); e != nil {
				return relay.ErrorFromProto(e)
			}
		case *kmatev1.Frame_Close:
			if e := mux.CloseError(f); e != nil {
				return relay.TranslateErr(e)
			}
			return nil
		}
	}
}

// Apply performs a server-side apply.
func (c *ClusterService) Apply(ctx context.Context, req *connect.Request[kmatev1.ClusterApplyRequest]) (*connect.Response[kmatev1.ApplyResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Apply{Apply: req.Msg.GetApply()}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	o := req.Msg.GetApply().GetObject()
	c.audit(ctx, req.Msg.GetClusterId(), "apply", fmt.Sprintf("%s %s/%s", o.GetKind(), o.GetNamespace(), o.GetName()), err)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetApply())), nil
}

// Patch patches an object.
func (c *ClusterService) Patch(ctx context.Context, req *connect.Request[kmatev1.ClusterPatchRequest]) (*connect.Response[kmatev1.PatchResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Patch{Patch: req.Msg.GetPatch()}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	c.audit(ctx, req.Msg.GetClusterId(), "patch", refString(req.Msg.GetPatch().GetRef()), err)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetPatch())), nil
}

// Delete deletes an object.
func (c *ClusterService) Delete(ctx context.Context, req *connect.Request[kmatev1.ClusterDeleteRequest]) (*connect.Response[kmatev1.DeleteResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Delete{Delete: req.Msg.GetDelete()}
	_, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	c.audit(ctx, req.Msg.GetClusterId(), "delete", refString(req.Msg.GetDelete().GetRef()), err)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&kmatev1.DeleteResponse{}), nil
}

// Scale changes replicas.
func (c *ClusterService) Scale(ctx context.Context, req *connect.Request[kmatev1.ClusterScaleRequest]) (*connect.Response[kmatev1.ScaleResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Scale{Scale: req.Msg.GetScale()}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	c.audit(ctx, req.Msg.GetClusterId(), "scale", fmt.Sprintf("%s -> %d", refString(req.Msg.GetScale().GetRef()), req.Msg.GetScale().GetReplicas()), err)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetScale())), nil
}

// RolloutRestart restarts a workload.
func (c *ClusterService) RolloutRestart(ctx context.Context, req *connect.Request[kmatev1.ClusterRolloutRestartRequest]) (*connect.Response[kmatev1.RolloutRestartResponse], error) {
	if err := auth.RequireWrite(ctx); err != nil {
		return nil, err
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_RolloutRestart{RolloutRestart: req.Msg.GetRestart()}
	_, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	c.audit(ctx, req.Msg.GetClusterId(), "rollout-restart", refString(req.Msg.GetRestart().GetRef()), err)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&kmatev1.RolloutRestartResponse{}), nil
}

// Logs streams pod logs.
func (c *ClusterService) Logs(ctx context.Context, req *connect.Request[kmatev1.ClusterLogsRequest], stream *connect.ServerStream[kmatev1.Data]) error {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Logs{Logs: req.Msg.GetLogs()}
	l := req.Msg.GetLogs()
	c.audit(ctx, req.Msg.GetClusterId(), "logs", fmt.Sprintf("%s/%s[%s]", l.GetNamespace(), l.GetPod(), l.GetContainer()), nil)
	st, err := c.relay.Stream(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return err
	}
	defer st.Close(nil)
	for {
		f, err := st.Recv(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return relay.TranslateErr(err)
		}
		switch p := f.Payload.(type) {
		case *kmatev1.Frame_Data:
			if err := stream.Send(p.Data); err != nil {
				return err
			}
			if p.Data.GetEof() {
				return nil
			}
		case *kmatev1.Frame_Response:
			if e := p.Response.GetError(); e != nil {
				return relay.ErrorFromProto(e)
			}
		case *kmatev1.Frame_Close:
			if e := mux.CloseError(f); e != nil {
				return relay.TranslateErr(e)
			}
			return nil
		}
	}
}

// GetCatalog returns the latest service catalog.
func (c *ClusterService) GetCatalog(ctx context.Context, req *connect.Request[kmatev1.ClusterCatalogRequest]) (*connect.Response[kmatev1.CatalogResponse], error) {
	id := req.Msg.GetClusterId()
	cat, err := c.store.GetCatalog(ctx, id)
	if err == nil {
		return connect.NewResponse(&kmatev1.CatalogResponse{Catalog: cat}), nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if _, online := c.reg.Get(id); !online {
		return connect.NewResponse(&kmatev1.CatalogResponse{Catalog: &kmatev1.Catalog{}}), nil
	}
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Catalog{Catalog: &kmatev1.CatalogRequest{}}
	resp, err := c.relay.Unary(ctx, id, r)
	if err != nil {
		return nil, err
	}
	if cat := resp.GetCatalog().GetCatalog(); cat != nil {
		_ = c.store.SaveCatalog(ctx, id, cat)
	}
	return connect.NewResponse(orEmpty(resp.GetCatalog())), nil
}

// WatchCatalog streams catalog updates.
func (c *ClusterService) WatchCatalog(ctx context.Context, req *connect.Request[kmatev1.ClusterCatalogRequest], stream *connect.ServerStream[kmatev1.Catalog]) error {
	id := req.Msg.GetClusterId()
	sub := c.reg.Catalog(id).Subscribe(ctx)
	first, err := c.GetCatalog(ctx, req)
	if err != nil {
		return err
	}
	if cat := first.Msg.GetCatalog(); cat != nil {
		if err := stream.Send(cat); err != nil {
			return err
		}
	}
	for {
		select {
		case cat := <-sub:
			if err := stream.Send(cat); err != nil {
				return err
			}
		case <-ctx.Done():
			return nil
		}
	}
}

// ListHelmReleases lists Helm releases.
func (c *ClusterService) ListHelmReleases(ctx context.Context, req *connect.Request[kmatev1.ClusterHelmListRequest]) (*connect.Response[kmatev1.HelmListResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_HelmList{HelmList: &kmatev1.HelmListRequest{Namespace: req.Msg.GetNamespace()}}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetHelmList())), nil
}

// GetHelmRelease returns one release with values, manifest and history.
func (c *ClusterService) GetHelmRelease(ctx context.Context, req *connect.Request[kmatev1.ClusterHelmGetRequest]) (*connect.Response[kmatev1.HelmGetResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_HelmGet{HelmGet: orEmpty(req.Msg.GetHelm())}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetHelmGet())), nil
}

// GetMetrics returns resource metrics.
func (c *ClusterService) GetMetrics(ctx context.Context, req *connect.Request[kmatev1.ClusterMetricsRequest]) (*connect.Response[kmatev1.MetricsResponse], error) {
	r := NewRequest(ctx)
	r.Kind = &kmatev1.Request_Metrics{Metrics: req.Msg.GetMetrics()}
	resp, err := c.relay.Unary(ctx, req.Msg.GetClusterId(), r)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(orEmpty(resp.GetMetrics())), nil
}

func orEmpty[T any, PT interface{ *T }](v PT) PT {
	if v == nil {
		return PT(new(T))
	}
	return v
}
