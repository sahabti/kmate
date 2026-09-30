package discovery

import (
	"strings"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
)

// Istio support: VirtualService + Gateway (networking.istio.io) are resolved
// into Exposures the same way Ingress and Gateway API routes are.
//
//	VirtualService.spec.http[].route[].destination.host  → the Service
//	VirtualService.spec.hosts                            → public hostnames
//	VirtualService.spec.gateways                         → Gateway (ns/name)
//	Gateway.spec.servers[] {port, hosts, tls}            → scheme + port
//	Gateway.spec.selector → ingress pods → LoadBalancer Service → addresses

const istioGroup = "networking.istio.io"

// detectIstio returns the API version serving virtualservices, or "".
func detectIstio(disc discovery.DiscoveryInterface) string {
	if disc == nil {
		return ""
	}
	for _, v := range []string{"v1", "v1beta1"} {
		res, err := disc.ServerResourcesForGroupVersion(istioGroup + "/" + v)
		if err != nil {
			continue
		}
		for _, r := range res.APIResources {
			if r.Name == "virtualservices" {
				return v
			}
		}
	}
	return ""
}

func istioGVRs(version string) (vs, gw schema.GroupVersionResource) {
	return schema.GroupVersionResource{Group: istioGroup, Version: version, Resource: "virtualservices"},
		schema.GroupVersionResource{Group: istioGroup, Version: version, Resource: "gateways"}
}

// istioIndex is built once per rebuild pass: service key → VirtualServices routing to it.
type istioIndex struct {
	byService map[string][]*unstructured.Unstructured // "ns/name" → VS list
	gwAddrs   map[string][]string                     // "ns/name" gateway → LB addresses
}

func (b *Builder) buildIstioIndex() *istioIndex {
	idx := &istioIndex{byService: map[string][]*unstructured.Unstructured{}, gwAddrs: map[string][]string{}}
	if !b.istioEnabled() {
		return idx
	}
	for _, inf := range b.vservices {
		for _, o := range inf.GetStore().List() {
			vs, ok := o.(*unstructured.Unstructured)
			if !ok {
				continue
			}
			seen := map[string]bool{}
			for _, key := range vsDestinations(vs) {
				if !seen[key] {
					seen[key] = true
					idx.byService[key] = append(idx.byService[key], vs)
				}
			}
		}
	}
	return idx
}

func (b *Builder) istioEnabled() bool { return b.istioVersion != "" }

// vsDestinations lists "ns/name" service keys referenced by a VirtualService's
// http/tcp/tls routes. Hosts may be short ("svc"), "svc.ns", "svc.ns.svc" or FQDN.
func vsDestinations(vs *unstructured.Unstructured) []string {
	var out []string
	for _, section := range []string{"http", "tcp", "tls"} {
		rules, _, _ := unstructured.NestedSlice(vs.Object, "spec", section)
		for _, r := range rules {
			rm, _ := r.(map[string]interface{})
			routes, _, _ := unstructured.NestedSlice(rm, "route")
			for _, rt := range routes {
				rtm, _ := rt.(map[string]interface{})
				host, _, _ := unstructured.NestedString(rtm, "destination", "host")
				if key := resolveServiceHost(host, vs.GetNamespace()); key != "" {
					out = append(out, key)
				}
			}
		}
	}
	return out
}

// resolveServiceHost turns an Istio destination host into "ns/name".
// External hosts (contain a dot but are not *.svc*) return "".
func resolveServiceHost(host, defaultNS string) string {
	host = strings.TrimSuffix(host, ".")
	if host == "" || host == "*" {
		return ""
	}
	parts := strings.Split(host, ".")
	switch {
	case len(parts) == 1:
		return defaultNS + "/" + parts[0]
	case len(parts) >= 3 && parts[2] == "svc":
		return parts[1] + "/" + parts[0]
	case len(parts) == 2:
		// "svc.ns" shorthand
		return parts[1] + "/" + parts[0]
	}
	return ""
}

// istioExposures resolves VirtualServices routing to svc into Exposures.
func (b *Builder) istioExposures(svc *corev1.Service, idx *istioIndex) []*kmatev1.Exposure {
	var out []*kmatev1.Exposure
	key := svc.Namespace + "/" + svc.Name
	for _, vs := range idx.byService[key] {
		paths := vsPathsFor(vs, key)
		if len(paths) == 0 {
			continue
		}
		hosts, _, _ := unstructured.NestedStringSlice(vs.Object, "spec", "hosts")
		gateways, _, _ := unstructured.NestedStringSlice(vs.Object, "spec", "gateways")
		for _, gref := range gateways {
			if gref == "mesh" {
				continue // mesh-internal only
			}
			gwNS, gwName := parseGatewayRef(gref, vs.GetNamespace())
			gw := b.findIstioGateway(gwNS, gwName)
			if gw == nil {
				continue
			}
			addrs := b.istioGatewayAddresses(gw, idx)
			for _, h := range hosts {
				if h == "*" || h == "" || resolveServiceHost(h, "") != "" && !strings.Contains(h, ".") {
					continue // wildcard-all or mesh-internal short name
				}
				if resolveServiceHost(h, vs.GetNamespace()) != "" && (strings.HasSuffix(h, ".svc.cluster.local") || strings.Contains(h, ".svc")) {
					continue // internal FQDN
				}
				servers := matchingServers(gw, h)
				if len(servers) == 0 {
					continue
				}
				// prefer TLS server if present, else first plain one
				chosen := servers[0]
				for _, s := range servers {
					if s.tls {
						chosen = s
						break
					}
				}
				for _, p := range paths {
					x := &kmatev1.Exposure{
						Kind:      "VirtualService",
						Name:      vs.GetName(),
						Class:     gwNS + "/" + gwName,
						Host:      h,
						Path:      p.path,
						PathType:  p.kind,
						Tls:       chosen.tls,
						Addresses: addrs,
						Port:      chosen.port,
					}
					x.Url = buildURL(chosen.tls, h, addrs, p.path, chosen.port)
					out = append(out, x)
				}
			}
		}
	}
	return out
}

type vsPath struct{ path, kind string }

// vsPathsFor returns the URI matches of http rules that route to the service key.
func vsPathsFor(vs *unstructured.Unstructured, key string) []vsPath {
	var out []vsPath
	seen := map[string]bool{}
	add := func(p, kind string) {
		if p == "" {
			p = "/"
		}
		if !seen[kind+p] {
			seen[kind+p] = true
			out = append(out, vsPath{p, kind})
		}
	}
	rules, _, _ := unstructured.NestedSlice(vs.Object, "spec", "http")
	for _, r := range rules {
		rm, _ := r.(map[string]interface{})
		routes, _, _ := unstructured.NestedSlice(rm, "route")
		hit := false
		for _, rt := range routes {
			rtm, _ := rt.(map[string]interface{})
			host, _, _ := unstructured.NestedString(rtm, "destination", "host")
			if resolveServiceHost(host, vs.GetNamespace()) == key {
				hit = true
			}
		}
		if !hit {
			continue
		}
		matches, _, _ := unstructured.NestedSlice(rm, "match")
		if len(matches) == 0 {
			add("/", "Prefix")
		}
		for _, m := range matches {
			mm, _ := m.(map[string]interface{})
			if p, ok, _ := unstructured.NestedString(mm, "uri", "prefix"); ok {
				add(p, "Prefix")
			} else if p, ok, _ := unstructured.NestedString(mm, "uri", "exact"); ok {
				add(p, "Exact")
			} else if _, ok, _ := unstructured.NestedString(mm, "uri", "regex"); ok {
				add("/", "Regex")
			} else {
				add("/", "Prefix")
			}
		}
	}
	// tcp/tls routes expose the root
	for _, section := range []string{"tcp", "tls"} {
		rules, _, _ := unstructured.NestedSlice(vs.Object, "spec", section)
		for _, r := range rules {
			rm, _ := r.(map[string]interface{})
			routes, _, _ := unstructured.NestedSlice(rm, "route")
			for _, rt := range routes {
				rtm, _ := rt.(map[string]interface{})
				host, _, _ := unstructured.NestedString(rtm, "destination", "host")
				if resolveServiceHost(host, vs.GetNamespace()) == key {
					add("/", "Prefix")
				}
			}
		}
	}
	return out
}

// parseGatewayRef handles "name", "ns/name" and "name.ns.svc.cluster.local".
func parseGatewayRef(ref, defaultNS string) (ns, name string) {
	if i := strings.Index(ref, "/"); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	if parts := strings.Split(ref, "."); len(parts) >= 2 {
		return parts[1], parts[0]
	}
	return defaultNS, ref
}

func (b *Builder) findIstioGateway(ns, name string) *unstructured.Unstructured {
	for _, inf := range b.istioGateways {
		if o, ok, _ := inf.GetStore().GetByKey(ns + "/" + name); ok {
			return o.(*unstructured.Unstructured)
		}
	}
	return nil
}

type gwServer struct {
	port int32
	tls  bool
}

// matchingServers returns gateway servers whose hosts cover the given hostname.
func matchingServers(gw *unstructured.Unstructured, host string) []gwServer {
	var out []gwServer
	servers, _, _ := unstructured.NestedSlice(gw.Object, "spec", "servers")
	for _, s := range servers {
		sm, _ := s.(map[string]interface{})
		hosts, _, _ := unstructured.NestedStringSlice(sm, "hosts")
		matched := len(hosts) == 0
		for _, gh := range hosts {
			// hosts may be "ns/host"; strip the namespace qualifier
			if i := strings.Index(gh, "/"); i >= 0 {
				gh = gh[i+1:]
			}
			if hostMatches(gh, host) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		portNum, _, _ := unstructured.NestedInt64(sm, "port", "number")
		proto, _, _ := unstructured.NestedString(sm, "port", "protocol")
		_, hasTLS, _ := unstructured.NestedMap(sm, "tls")
		proto = strings.ToUpper(proto)
		tls := hasTLS || proto == "HTTPS" || proto == "TLS"
		if proto == "HTTP" && hasTLS {
			// HTTP server with tls block (httpsRedirect) is still plaintext
			tls = false
		}
		out = append(out, gwServer{port: int32(portNum), tls: tls})
	}
	return out
}

// hostMatches implements Istio's wildcard host matching ("*", "*.example.com").
func hostMatches(pattern, host string) bool {
	if pattern == "*" || pattern == host {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		suffix := pattern[1:] // ".example.com"
		return strings.HasSuffix(host, suffix) && len(host) > len(suffix)
	}
	return false
}

// istioGatewayAddresses finds the external addresses of the ingress pods a
// Gateway selects: pods matching spec.selector → LoadBalancer Services
// selecting those pods → status.loadBalancer.ingress.
func (b *Builder) istioGatewayAddresses(gw *unstructured.Unstructured, idx *istioIndex) []string {
	key := gw.GetNamespace() + "/" + gw.GetName()
	if a, ok := idx.gwAddrs[key]; ok {
		return a
	}
	selector, _, _ := unstructured.NestedStringMap(gw.Object, "spec", "selector")
	var addrs []string
	if len(selector) > 0 {
		gwSel := labels.SelectorFromSet(selector)
		// Ingress gateway pods normally live in the gateway's namespace, but
		// Istio allows any namespace; scan all pods (cheap: label match only).
		var matched []*corev1.Pod
		for _, inf := range b.pods {
			for _, o := range inf.GetStore().List() {
				if p, ok := o.(*corev1.Pod); ok && gwSel.Matches(labels.Set(p.Labels)) {
					matched = append(matched, p)
				}
			}
		}
		seen := map[string]bool{}
		for _, inf := range b.services {
			for _, o := range inf.GetStore().List() {
				svc, ok := o.(*corev1.Service)
				if !ok || svc.Spec.Type != corev1.ServiceTypeLoadBalancer || len(svc.Spec.Selector) == 0 {
					continue
				}
				sel := labels.SelectorFromSet(svc.Spec.Selector)
				hit := false
				for _, p := range matched {
					if p.Namespace == svc.Namespace && sel.Matches(labels.Set(p.Labels)) {
						hit = true
						break
					}
				}
				if !hit {
					continue
				}
				for _, ing := range svc.Status.LoadBalancer.Ingress {
					v := ing.IP
					if v == "" {
						v = ing.Hostname
					}
					if v != "" && !seen[v] {
						seen[v] = true
						addrs = append(addrs, v)
					}
				}
			}
		}
	}
	idx.gwAddrs[key] = addrs
	return addrs
}
