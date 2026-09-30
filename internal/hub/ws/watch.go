package ws

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/hub/api"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/mux"
)

// Multiplexed resource watches over ONE WebSocket per cluster.
//
// Browsers cap plain-HTTP connections at six per origin and every Connect
// server-stream holds one, so a page with many live tables (or the Realm view)
// starves itself. This endpoint carries any number of watches on a single socket.
//
// Wire format (text frames, JSON):
//
//	client -> hub: {"op":"sub","id":"c1","gvr":{"group":"","version":"v1","resource":"pods"},
//	                "options":{"namespace":"","labelSelector":"","fieldSelector":"","columnsOnly":true}}
//	               {"op":"unsub","id":"c1"}
//	hub -> client: {"id":"c1","type":"SYNC|ADDED|MODIFIED|DELETED|ERROR","synced":bool,"object":{...},"error":{"code":..,"message":".."}}
//	               {"id":"c1","type":"CLOSED","error":{...}}   when the agent-side stream ends
//	               {"id":"c1","type":"ERROR","error":{...}}    when a sub is rejected (cap, bad request)
//
// Two hub-level subscription kinds share the socket so a page needs no other stream:
//
//	client -> hub: {"op":"sub","id":"c2","kind":"catalog"}     Service Catalog of the socket's cluster
//	hub -> client: {"id":"c2","type":"CATALOG","catalog":{...protojson Catalog...}}
//	client -> hub: {"op":"sub","id":"c3","kind":"clusters"}    all clusters on the hub (any cluster id path, e.g. "_hub")
//	hub -> client: {"id":"c3","type":"CLUSTER","event":{"type":"ADDED|MODIFIED|DELETED","cluster":{...protojson Cluster...}}}

const (
	maxSubsPerSocket = 64
	writeBacklog     = 4096
	slowConsumerMax  = 10 * time.Second
	pingInterval     = 20 * time.Second
)

type watchCmd struct {
	Op      string `json:"op"`
	ID      string `json:"id"`
	Kind    string `json:"kind,omitempty"` // "" (resource watch) | "catalog" | "clusters"
	GVR     *gvr   `json:"gvr,omitempty"`
	Options *wopts `json:"options,omitempty"`
}

type gvr struct {
	Group    string `json:"group"`
	Version  string `json:"version"`
	Resource string `json:"resource"`
}

type wopts struct {
	Namespace     string `json:"namespace"`
	LabelSelector string `json:"labelSelector"`
	FieldSelector string `json:"fieldSelector"`
	ColumnsOnly   bool   `json:"columnsOnly"`
	Limit         int32  `json:"limit,omitempty"`
}

type watchMsg struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Synced  bool            `json:"synced,omitempty"`
	Object  json.RawMessage `json:"object,omitempty"`
	Catalog json.RawMessage `json:"catalog,omitempty"`
	Event   json.RawMessage `json:"event,omitempty"`
	Error   *wsError        `json:"error,omitempty"`
}

type wsError struct {
	Code    int32  `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message"`
}

// WatchSockets / WatchSubs are exposed for /metrics.
func (h *Handler) WatchSockets() int64 { return h.watchSockets.Load() }
func (h *Handler) WatchSubs() int64    { return h.watchSubs.Load() }

type watchSession struct {
	h         *Handler
	c         *websocket.Conn
	ctx       context.Context
	cancel    context.CancelFunc
	clusterID string
	out       chan []byte

	mu   sync.Mutex
	subs map[string]context.CancelFunc
}

func (h *Handler) watch(w http.ResponseWriter, r *http.Request) {
	c, p, ok := h.accept(w, r)
	if !ok {
		return
	}
	defer c.CloseNow()
	h.watchSockets.Add(1)
	defer h.watchSockets.Add(-1)

	ctx, cancel := context.WithCancel(auth.WithPrincipal(r.Context(), p))
	defer cancel()
	s := &watchSession{h: h, c: c, ctx: ctx, cancel: cancel, clusterID: r.PathValue("id"), out: make(chan []byte, writeBacklog), subs: map[string]context.CancelFunc{}}
	defer s.closeAll()

	go s.writer()
	go s.pinger()

	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var cmd watchCmd
		if err := json.Unmarshal(data, &cmd); err != nil || cmd.ID == "" {
			s.send(watchMsg{ID: cmd.ID, Type: "ERROR", Error: &wsError{Code: 400, Message: "bad command"}})
			continue
		}
		switch cmd.Op {
		case "sub":
			s.subscribe(cmd)
		case "unsub":
			s.unsubscribe(cmd.ID)
		default:
			s.send(watchMsg{ID: cmd.ID, Type: "ERROR", Error: &wsError{Code: 400, Message: "unknown op " + cmd.Op}})
		}
	}
}

func (s *watchSession) subscribe(cmd watchCmd) {
	switch cmd.Kind {
	case "catalog":
		s.subscribeCatalog(cmd.ID)
		return
	case "clusters":
		s.subscribeClusters(cmd.ID)
		return
	}
	if cmd.GVR == nil || cmd.GVR.Resource == "" {
		s.send(watchMsg{ID: cmd.ID, Type: "ERROR", Error: &wsError{Code: 400, Message: "gvr.resource is required"}})
		return
	}
	s.mu.Lock()
	if _, dup := s.subs[cmd.ID]; dup {
		s.mu.Unlock()
		s.send(watchMsg{ID: cmd.ID, Type: "ERROR", Error: &wsError{Code: 409, Message: "subscription id already in use"}})
		return
	}
	if len(s.subs) >= maxSubsPerSocket {
		s.mu.Unlock()
		s.send(watchMsg{ID: cmd.ID, Type: "ERROR", Error: &wsError{Code: 429, Message: "too many subscriptions on one socket (max 64)"}})
		return
	}
	subCtx, subCancel := context.WithCancel(s.ctx)
	s.subs[cmd.ID] = subCancel
	s.mu.Unlock()
	s.h.watchSubs.Add(1)

	opts := &kmatev1.ListOptions{}
	if o := cmd.Options; o != nil {
		opts = &kmatev1.ListOptions{Namespace: o.Namespace, LabelSelector: o.LabelSelector, FieldSelector: o.FieldSelector, ColumnsOnly: o.ColumnsOnly, Limit: o.Limit}
	}
	req := api.NewRequest(s.ctx)
	req.Kind = &kmatev1.Request_Watch{Watch: &kmatev1.WatchRequest{
		Gvr:     &kmatev1.GVR{Group: cmd.GVR.Group, Version: cmd.GVR.Version, Resource: cmd.GVR.Resource},
		Options: opts,
	}}

	go func() {
		defer s.h.watchSubs.Add(-1)
		defer s.dropSub(cmd.ID)
		st, err := s.h.relay.Stream(subCtx, s.clusterID, req)
		if err != nil {
			s.send(watchMsg{ID: cmd.ID, Type: "CLOSED", Error: toWSError(err)})
			return
		}
		defer st.Close(nil)
		for {
			f, err := st.Recv(subCtx)
			if err != nil {
				if subCtx.Err() == nil {
					s.send(watchMsg{ID: cmd.ID, Type: "CLOSED", Error: toWSError(err)})
				}
				return
			}
			switch p := f.Payload.(type) {
			case *kmatev1.Frame_WatchEvent:
				ev := p.WatchEvent
				m := watchMsg{ID: cmd.ID, Type: eventTypeName(ev.GetType()), Synced: ev.GetSynced()}
				if o := ev.GetObject(); o != nil && len(o.GetJson()) > 0 {
					m.Object = json.RawMessage(o.GetJson())
				}
				if e := ev.GetError(); e != nil {
					m.Error = &wsError{Code: e.GetCode(), Reason: e.GetReason(), Message: e.GetMessage()}
				}
				if !s.send(m) {
					return
				}
			case *kmatev1.Frame_Response:
				if e := p.Response.GetError(); e != nil {
					s.send(watchMsg{ID: cmd.ID, Type: "CLOSED", Error: &wsError{Code: e.GetCode(), Reason: e.GetReason(), Message: e.GetMessage()}})
					return
				}
			case *kmatev1.Frame_Close:
				s.send(watchMsg{ID: cmd.ID, Type: "CLOSED", Error: toWSError(mux.CloseError(f))})
				return
			}
		}
	}()
}

func (s *watchSession) unsubscribe(id string) {
	s.mu.Lock()
	cancel, ok := s.subs[id]
	delete(s.subs, id)
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

func (s *watchSession) dropSub(id string) {
	s.mu.Lock()
	if cancel, ok := s.subs[id]; ok {
		delete(s.subs, id)
		cancel()
	}
	s.mu.Unlock()
}

func (s *watchSession) closeAll() {
	s.mu.Lock()
	for id, cancel := range s.subs {
		cancel()
		delete(s.subs, id)
	}
	s.mu.Unlock()
}

// send queues a message; returns false if the session is gone or the client is too slow.
func (s *watchSession) send(m watchMsg) bool {
	b, err := json.Marshal(m)
	if err != nil {
		return true
	}
	select {
	case s.out <- b:
		return true
	case <-s.ctx.Done():
		return false
	default:
	}
	t := time.NewTimer(slowConsumerMax)
	defer t.Stop()
	select {
	case s.out <- b:
		return true
	case <-s.ctx.Done():
		return false
	case <-t.C:
		s.h.log.Warn("watch websocket: slow consumer, closing", "cluster", s.clusterID)
		_ = s.c.Close(websocket.StatusPolicyViolation, "slow consumer: 10s backlog")
		s.cancel()
		return false
	}
}

func (s *watchSession) writer() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case b := <-s.out:
			wctx, wcancel := context.WithTimeout(s.ctx, slowConsumerMax)
			err := s.c.Write(wctx, websocket.MessageText, b)
			wcancel()
			if err != nil {
				s.cancel()
				return
			}
		}
	}
}

func (s *watchSession) pinger() {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			pctx, pcancel := context.WithTimeout(s.ctx, slowConsumerMax)
			err := s.c.Ping(pctx)
			pcancel()
			if err != nil {
				s.cancel()
				return
			}
		}
	}
}

func eventTypeName(t kmatev1.EventType) string {
	switch t {
	case kmatev1.EventType_EVENT_TYPE_SYNC:
		return "SYNC"
	case kmatev1.EventType_EVENT_TYPE_ADDED:
		return "ADDED"
	case kmatev1.EventType_EVENT_TYPE_MODIFIED:
		return "MODIFIED"
	case kmatev1.EventType_EVENT_TYPE_DELETED:
		return "DELETED"
	case kmatev1.EventType_EVENT_TYPE_ERROR:
		return "ERROR"
	}
	return "UNKNOWN"
}

func toWSError(err error) *wsError {
	if err == nil {
		return nil
	}
	if re, ok := err.(*mux.RemoteError); ok {
		return &wsError{Code: re.Code, Reason: re.Reason, Message: re.Message}
	}
	err = relay.TranslateErr(err)
	return &wsError{Message: err.Error()}
}

// reserve registers a cancel func for a hub-level subscription; false when rejected.
func (s *watchSession) reserve(id string) (context.Context, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.subs[id]; dup {
		s.send(watchMsg{ID: id, Type: "ERROR", Error: &wsError{Code: 409, Message: "subscription id already in use"}})
		return nil, false
	}
	if len(s.subs) >= maxSubsPerSocket {
		s.send(watchMsg{ID: id, Type: "ERROR", Error: &wsError{Code: 429, Message: "too many subscriptions on one socket (max 64)"}})
		return nil, false
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.subs[id] = cancel
	s.h.watchSubs.Add(1)
	return ctx, true
}

// subscribeCatalog streams the cluster's Service Catalog: stored snapshot (or a live
// fetch when the agent is online and nothing is stored), then every update.
func (s *watchSession) subscribeCatalog(id string) {
	ctx, ok := s.reserve(id)
	if !ok {
		return
	}
	reg := s.h.relay.Registry()
	go func() {
		defer s.h.watchSubs.Add(-1)
		defer s.dropSub(id)
		sub := reg.Catalog(s.clusterID).Subscribe(ctx)
		cat, err := s.h.store.GetCatalog(ctx, s.clusterID)
		if err != nil && errors.Is(err, store.ErrNotFound) {
			if _, online := reg.Get(s.clusterID); online {
				req := api.NewRequest(s.ctx)
				req.Kind = &kmatev1.Request_Catalog{Catalog: &kmatev1.CatalogRequest{}}
				if resp, rerr := s.h.relay.Unary(ctx, s.clusterID, req); rerr == nil {
					cat = resp.GetCatalog().GetCatalog()
					if cat != nil {
						_ = s.h.store.SaveCatalog(ctx, s.clusterID, cat)
					}
				}
			}
			err = nil
		}
		if err != nil {
			s.send(watchMsg{ID: id, Type: "CLOSED", Error: toWSError(err)})
			return
		}
		if cat == nil {
			cat = &kmatev1.Catalog{}
		}
		if !s.sendCatalog(id, cat) {
			return
		}
		for {
			select {
			case c := <-sub:
				if !s.sendCatalog(id, c) {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *watchSession) sendCatalog(id string, c *kmatev1.Catalog) bool {
	b, err := protojson.Marshal(c)
	if err != nil {
		return true
	}
	return s.send(watchMsg{ID: id, Type: "CATALOG", Catalog: json.RawMessage(b)})
}

// subscribeClusters streams every cluster (ADDED for the current set, then changes).
func (s *watchSession) subscribeClusters(id string) {
	ctx, ok := s.reserve(id)
	if !ok {
		return
	}
	reg := s.h.relay.Registry()
	go func() {
		defer s.h.watchSubs.Add(-1)
		defer s.dropSub(id)
		sub := reg.ClusterEvents().Subscribe(ctx)
		cs, err := s.h.store.ListClusters(ctx)
		if err != nil {
			s.send(watchMsg{ID: id, Type: "CLOSED", Error: toWSError(err)})
			return
		}
		for _, c := range cs {
			p := c.Proto()
			if conn, online := reg.Get(c.ID); online {
				p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_ONLINE
				if info := conn.Info(); info != nil {
					p.Info = info
				}
			} else if p.Status == kmatev1.ClusterStatus_CLUSTER_STATUS_ONLINE {
				p.Status = kmatev1.ClusterStatus_CLUSTER_STATUS_OFFLINE
			}
			if !s.sendClusterEvent(id, &kmatev1.ClusterEvent{Type: "ADDED", Cluster: p}) {
				return
			}
		}
		for {
			select {
			case ev := <-sub:
				if !s.sendClusterEvent(id, ev) {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (s *watchSession) sendClusterEvent(id string, ev *kmatev1.ClusterEvent) bool {
	b, err := protojson.Marshal(ev)
	if err != nil {
		return true
	}
	return s.send(watchMsg{ID: id, Type: "CLUSTER", Event: json.RawMessage(b)})
}
