# Phase 2 · Service Catalog (2 weeks)

- [x] Informers: Services, EndpointSlices, Pods, ReplicaSets, Deployments, StatefulSets, DaemonSets, Ingresses, IngressClasses, Gateway API (if CRDs present), Helm release Secrets
- [x] Indexes: pods by namespace+labels; ingress by backend service; httproute by backend service
- [x] Incremental catalog builder with per-service recompute; debounce 500 ms; monotonically increasing `version`
- [x] `kmate.io/*` annotation support; system namespace hiding
- [x] Agent-initiated `CatalogSnapshot` frames; Hub stores latest snapshot per cluster (offline view)
- [x] `ClusterService.GetCatalog` / `WatchCatalog`
- [x] Optional reachability probe (`--catalog-probe`)
- [x] Unit tests with fake clientset against fixtures: plain ClusterIP, LB, NodePort, Ingress with TLS, Ingress default backend, HTTPRoute, ExternalName, headless, no-selector

## Exit test
Demo app in kind: `GetCatalog` shows `shop-frontend` Healthy with `https://shop.127.0.0.1.nip.io/` and `shop-api` Degraded when one replica is killed.

## Status (2026-09-24, later)
Istio VirtualService + Gateway exposure added (`internal/agent/discovery/istio.go`) after running against a real GKE cluster that publishes everything through Istio: 31 of 109 services now resolve to public URLs, versus 2 before. Verified with unit tests and against the live cluster.
