// Package kube builds Kubernetes clients for the agent, in-cluster or from a kubeconfig.
package kube

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/version"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/discovery/cached/memory"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/restmapper"
	"k8s.io/client-go/tools/clientcmd"
)

// Clients bundles every client the agent needs.
type Clients struct {
	Config    *rest.Config
	Clientset kubernetes.Interface
	Dynamic   dynamic.Interface
	Discovery discovery.DiscoveryInterface
	Mapper    meta.ResettableRESTMapper

	CanImpersonate bool
	ClusterName    string
	// PodCount, when set, supplies the cluster pod count cheaply (from informers).
	PodCount func() int32

	mu           sync.Mutex
	impersonated map[string]*impersonatedClients
	clusterUID   string
}

type impersonatedClients struct {
	dyn     dynamic.Interface
	cs      kubernetes.Interface
	created time.Time
}

// Options for building clients.
type Options struct {
	Kubeconfig     string
	Context        string
	CanImpersonate bool
	ClusterName    string
	// PodCount, when set, supplies the cluster pod count cheaply (from informers).
	PodCount func() int32
}

// New builds clients. If Kubeconfig is empty, in-cluster config is used.
func New(opts Options) (*Clients, error) {
	var cfg *rest.Config
	var err error
	if opts.Kubeconfig != "" {
		rules := &clientcmd.ClientConfigLoadingRules{ExplicitPath: opts.Kubeconfig}
		overrides := &clientcmd.ConfigOverrides{CurrentContext: opts.Context}
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides).ClientConfig()
	} else {
		cfg, err = rest.InClusterConfig()
	}
	if err != nil {
		return nil, fmt.Errorf("kube config: %w", err)
	}
	cfg.UserAgent = "kmate-agent/" + version.Version
	cfg.QPS = 50
	cfg.Burst = 100
	return FromConfig(cfg, opts)
}

// FromConfig builds clients from an explicit rest.Config.
func FromConfig(cfg *rest.Config, opts Options) (*Clients, error) {
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	disc, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	cached := memory.NewMemCacheClient(disc)
	mapper := restmapper.NewDeferredDiscoveryRESTMapper(cached)
	return &Clients{
		Config:         cfg,
		Clientset:      cs,
		Dynamic:        dyn,
		Discovery:      cached,
		Mapper:         mapper,
		CanImpersonate: opts.CanImpersonate,
		ClusterName:    opts.ClusterName,
		impersonated:   map[string]*impersonatedClients{},
	}, nil
}

// RefreshDiscovery invalidates the discovery cache and RESTMapper.
func (c *Clients) RefreshDiscovery() {
	if inv, ok := c.Discovery.(discovery.CachedDiscoveryInterface); ok {
		inv.Invalidate()
	}
	c.Mapper.Reset()
}

// ForIdentity returns clients acting as the given identity when impersonation is
// enabled; otherwise the agent's own clients.
func (c *Clients) ForIdentity(id *kmatev1.Identity) (dynamic.Interface, kubernetes.Interface) {
	if !c.CanImpersonate || id == nil || id.User == "" {
		return c.Dynamic, c.Clientset
	}
	key := id.User + "|" + strings.Join(id.Groups, ",")
	c.mu.Lock()
	defer c.mu.Unlock()
	if ic, ok := c.impersonated[key]; ok && time.Since(ic.created) < 5*time.Minute {
		return ic.dyn, ic.cs
	}
	cfg := rest.CopyConfig(c.Config)
	cfg.Impersonate = rest.ImpersonationConfig{UserName: id.User, Groups: id.Groups}
	if len(id.Extra) > 0 {
		cfg.Impersonate.Extra = map[string][]string{}
		for k, v := range id.Extra {
			cfg.Impersonate.Extra[k] = []string{v}
		}
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		return c.Dynamic, c.Clientset
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return c.Dynamic, c.Clientset
	}
	// bounded cache
	if len(c.impersonated) > 256 {
		c.impersonated = map[string]*impersonatedClients{}
	}
	c.impersonated[key] = &impersonatedClients{dyn: dyn, cs: cs, created: time.Now()}
	return dyn, cs
}

// ConfigForIdentity returns a rest.Config with impersonation applied (for exec/logs/port-forward).
func (c *Clients) ConfigForIdentity(id *kmatev1.Identity) *rest.Config {
	cfg := rest.CopyConfig(c.Config)
	if c.CanImpersonate && id != nil && id.User != "" {
		cfg.Impersonate = rest.ImpersonationConfig{UserName: id.User, Groups: id.Groups}
	}
	return cfg
}

// ClusterUID returns the kube-system namespace UID (cached).
func (c *Clients) ClusterUID(ctx context.Context) string {
	c.mu.Lock()
	uid := c.clusterUID
	c.mu.Unlock()
	if uid != "" {
		return uid
	}
	ns, err := c.Clientset.CoreV1().Namespaces().Get(ctx, "kube-system", metav1.GetOptions{})
	if err != nil {
		return ""
	}
	c.mu.Lock()
	c.clusterUID = string(ns.UID)
	c.mu.Unlock()
	return c.clusterUID
}

// ClusterInfo gathers a summary of the cluster (cheap calls only).
func (c *Clients) ClusterInfo(ctx context.Context, catalogVersion int64) *kmatev1.ClusterInfo {
	info := &kmatev1.ClusterInfo{
		Name:           c.ClusterName,
		AgentVersion:   version.Version,
		CatalogVersion: catalogVersion,
		ClusterUid:     c.ClusterUID(ctx),
	}
	if info.Name == "" {
		if h, _ := os.Hostname(); h != "" {
			info.Name = "cluster-" + shortUID(info.ClusterUid)
		}
	}
	if v, err := c.Discovery.ServerVersion(); err == nil {
		info.KubernetesVersion = v.GitVersion
		info.Platform = detectPlatform(v.GitVersion)
	}
	if nodes, err := c.Clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil {
		info.NodeCount = int32(len(nodes.Items))
		if info.Platform == "unknown" || info.Platform == "" {
			for _, n := range nodes.Items {
				info.Platform = platformFromNode(n.Spec.ProviderID, n.Labels)
				break
			}
		}
	}
	if nss, err := c.Clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{}); err == nil {
		info.NamespaceCount = int32(len(nss.Items))
	}
	if c.PodCount != nil {
		info.PodCount = c.PodCount()
	}
	return info
}

func shortUID(uid string) string {
	if len(uid) > 8 {
		return uid[:8]
	}
	return uid
}

func detectPlatform(gitVersion string) string {
	switch {
	case strings.Contains(gitVersion, "gke"):
		return "gke"
	case strings.Contains(gitVersion, "eks"):
		return "eks"
	case strings.Contains(gitVersion, "k3s"):
		return "k3s"
	}
	return "unknown"
}

func platformFromNode(providerID string, labels map[string]string) string {
	switch {
	case strings.HasPrefix(providerID, "kind://"):
		return "kind"
	case strings.HasPrefix(providerID, "gce://"):
		return "gke"
	case strings.HasPrefix(providerID, "aws://"):
		return "eks"
	case strings.HasPrefix(providerID, "azure://"):
		return "aks"
	case strings.HasPrefix(providerID, "k3s://"):
		return "k3s"
	}
	if _, ok := labels["minikube.k8s.io/version"]; ok {
		return "minikube"
	}
	return "unknown"
}
