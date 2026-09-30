package handlers

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/yaml"
)

type helmRelease struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Version   int    `json:"version"`
	Info      struct {
		Status       string `json:"status"`
		LastDeployed string `json:"last_deployed"`
		Description  string `json:"description"`
		Notes        string `json:"notes"`
	} `json:"info"`
	Chart struct {
		Metadata struct {
			Name       string `json:"name"`
			Version    string `json:"version"`
			AppVersion string `json:"appVersion"`
		} `json:"metadata"`
		Values map[string]interface{} `json:"values"`
	} `json:"chart"`
	Config   map[string]interface{} `json:"config"`
	Manifest string                 `json:"manifest"`
}

func (r *helmRelease) proto() *kmatev1.HelmRelease {
	return &kmatev1.HelmRelease{
		Name: r.Name, Namespace: r.Namespace, Revision: int32(r.Version),
		Status: r.Info.Status, Chart: r.Chart.Metadata.Name, ChartVersion: r.Chart.Metadata.Version,
		AppVersion: r.Chart.Metadata.AppVersion, Updated: r.Info.LastDeployed,
	}
}

// helmGet returns one release with values, manifest, notes and history.
func (h *Handler) helmGet(ctx context.Context, req *kmatev1.Request, hg *kmatev1.HelmGetRequest) (*kmatev1.Response, error) {
	if hg.GetName() == "" {
		return nil, apierrors.NewBadRequest("release name is required")
	}
	_, cs := h.Clients.ForIdentity(req.Identity)
	secrets, err := cs.CoreV1().Secrets(hg.Namespace).List(ctx, metav1.ListOptions{
		FieldSelector: "type=helm.sh/release.v1",
		LabelSelector: "owner=helm,name=" + hg.Name,
	})
	if err != nil {
		return nil, err
	}
	var revs []*helmRelease
	for _, s := range secrets.Items {
		raw, ok := s.Data["release"]
		if !ok {
			continue
		}
		rel, err := decodeHelmRelease(raw)
		if err != nil || rel.Name != hg.Name {
			continue
		}
		revs = append(revs, rel)
	}
	if len(revs) == 0 {
		return nil, apierrors.NewNotFound(schema.GroupResource{Group: "helm.sh", Resource: "releases"}, hg.Namespace+"/"+hg.Name)
	}
	sort.Slice(revs, func(i, j int) bool { return revs[i].Version > revs[j].Version })
	chosen := revs[0]
	if hg.Revision > 0 {
		chosen = nil
		for _, r := range revs {
			if int32(r.Version) == hg.Revision {
				chosen = r
			}
		}
		if chosen == nil {
			return nil, apierrors.NewNotFound(schema.GroupResource{Group: "helm.sh", Resource: "releases"}, fmt.Sprintf("%s/%s revision %d", hg.Namespace, hg.Name, hg.Revision))
		}
	}
	out := &kmatev1.HelmGetResponse{
		Release:     chosen.proto(),
		Manifest:    chosen.Manifest,
		Notes:       chosen.Info.Notes,
		Description: chosen.Info.Description,
	}
	if len(chosen.Config) > 0 {
		if y, err := yaml.Marshal(chosen.Config); err == nil {
			out.ValuesYaml = string(y)
		}
	}
	if len(chosen.Chart.Values) > 0 {
		if y, err := yaml.Marshal(chosen.Chart.Values); err == nil {
			out.ChartValuesYaml = string(y)
		}
	}
	for _, r := range revs {
		out.History = append(out.History, r.proto())
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_HelmGet{HelmGet: out}}, nil
}

func (h *Handler) helmList(ctx context.Context, req *kmatev1.Request, hl *kmatev1.HelmListRequest) (*kmatev1.Response, error) {
	_, cs := h.Clients.ForIdentity(req.Identity)
	secrets, err := cs.CoreV1().Secrets(hl.Namespace).List(ctx, metav1.ListOptions{FieldSelector: "type=helm.sh/release.v1"})
	if err != nil {
		return nil, err
	}
	latest := map[string]*kmatev1.HelmRelease{}
	for _, s := range secrets.Items {
		raw, ok := s.Data["release"]
		if !ok {
			continue
		}
		rel, err := decodeHelmRelease(raw)
		if err != nil {
			continue
		}
		key := rel.Namespace + "/" + rel.Name
		if cur, ok := latest[key]; ok && int(cur.Revision) >= rel.Version {
			continue
		}
		latest[key] = rel.proto()
	}
	out := &kmatev1.HelmListResponse{}
	for _, r := range latest {
		out.Releases = append(out.Releases, r)
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_HelmList{HelmList: out}}, nil
}

func decodeHelmRelease(raw []byte) (*helmRelease, error) {
	// Secret data is already base64-decoded by the client; the release payload is
	// base64(gzip(json)).
	b := make([]byte, base64.StdEncoding.DecodedLen(len(raw)))
	n, err := base64.StdEncoding.Decode(b, raw)
	if err != nil {
		return nil, err
	}
	b = b[:n]
	if len(b) > 3 && b[0] == 0x1f && b[1] == 0x8b {
		gr, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			return nil, err
		}
		defer gr.Close()
		b, err = io.ReadAll(gr)
		if err != nil {
			return nil, err
		}
	}
	var rel helmRelease
	if err := json.Unmarshal(b, &rel); err != nil {
		return nil, err
	}
	return &rel, nil
}

func (h *Handler) metrics(ctx context.Context, req *kmatev1.Request, m *kmatev1.MetricsRequest) (*kmatev1.Response, error) {
	dyn, _ := h.Clients.ForIdentity(req.Identity)
	kind := m.Kind
	if kind == "" {
		kind = "pods"
	}
	gvr := schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: kind}
	var list *unstructured.UnstructuredList
	var err error
	if kind == "pods" {
		list, err = dyn.Resource(gvr).Namespace(m.Namespace).List(ctx, metav1.ListOptions{})
	} else {
		list, err = dyn.Resource(gvr).List(ctx, metav1.ListOptions{})
	}
	if err != nil {
		if apierrors.IsNotFound(err) || meta.IsNoMatchError(err) || strings.Contains(err.Error(), "could not find the requested resource") {
			// 501 → connect.CodeUnimplemented at the hub
			return nil, &apierrors.StatusError{ErrStatus: metav1.Status{
				Code: 501, Reason: "MetricsUnavailable",
				Message: "metrics.k8s.io is not available on this cluster; install metrics-server to enable resource metrics",
			}}
		}
		return nil, fmt.Errorf("metrics-server unavailable: %w", err)
	}
	out := &kmatev1.MetricsResponse{}
	for _, item := range list.Items {
		if kind == "nodes" {
			cpu, mem := usage(item.Object["usage"])
			out.Samples = append(out.Samples, &kmatev1.MetricSample{Name: item.GetName(), CpuMillicores: cpu, MemoryBytes: mem})
			continue
		}
		containers, _, _ := unstructured.NestedSlice(item.Object, "containers")
		for _, c := range containers {
			cm, _ := c.(map[string]interface{})
			name, _ := cm["name"].(string)
			cpu, mem := usage(cm["usage"])
			out.Samples = append(out.Samples, &kmatev1.MetricSample{Namespace: item.GetNamespace(), Name: item.GetName(), Container: name, CpuMillicores: cpu, MemoryBytes: mem})
		}
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Metrics{Metrics: out}}, nil
}

func usage(v interface{}) (int64, int64) {
	m, _ := v.(map[string]interface{})
	var cpu, mem int64
	if s, ok := m["cpu"].(string); ok {
		if q, err := resource.ParseQuantity(s); err == nil {
			cpu = q.MilliValue()
		}
	}
	if s, ok := m["memory"].(string); ok {
		if q, err := resource.ParseQuantity(s); err == nil {
			mem = q.Value()
		}
	}
	return cpu, mem
}

var _ = strconv.Itoa
