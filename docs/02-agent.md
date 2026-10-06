# 02 · KMate Agent

## Responsibilities

1. Maintain a live cache of cluster resources (informers).
2. Keep one outbound tunnel to the Hub and service requests on it.
3. Build and publish the Service Catalog.
4. Proxy logs / exec / attach / port-forward to the API server.
5. Read Helm release metadata.
6. Optionally scrape metrics-server / Prometheus for resource graphs.
7. Enforce user identity via impersonation and SubjectAccessReview.

## Deployment

Installed by Helm chart `deploy/helm/kmate-agent`.

```
Namespace: kmate-system
Deployment: kmate-agent (1 replica, requests 100m/128Mi, limits 1/1Gi default)
ServiceAccount: kmate-agent
ClusterRole: kmate-agent-reader (read verbs on everything, incl. CRDs, non-resource /metrics, /healthz)
ClusterRole: kmate-agent-writer (optional, values.rbac.write=true)
ClusterRole: kmate-agent-impersonator (optional, values.rbac.impersonate=true)
ClusterRole: kmate-agent-exec (optional, pods/exec, pods/portforward, pods/attach)
Secret: kmate-agent-enrollment (hub URL + enrollment token; replaced by issued cert after first connect)
NetworkPolicy: egress-only to hub (optional)
```

Configuration is via env / flags (no ConfigMap required):

| Env | Meaning |
|-----|---------|
| `KMATE_HUB_ADDR` | `hub.example.com:9090` |
| `KMATE_ENROLLMENT_TOKEN` | one-time token from the Hub UI (`kmt_enr_...`) |
| `KMATE_CLUSTER_NAME` | display name; default from kube-system UID |
| `KMATE_NAMESPACES` | comma list to scope informers (default: all) |
| `KMATE_INSECURE_HUB` | dev only: plaintext gRPC |
| `KMATE_LOG_LEVEL` | debug / info / warn |

For local development the agent can run **outside** the cluster with `--kubeconfig`
(and `--context`). Pass `--identity-file <path>` so the enrolled identity survives
restarts (0600 JSON; `make agent-local` uses `./.kmate-agent-identity.json`). In-cluster
the equivalent is `--identity-secret`. If the hub rejects the stored identity the file /
Secret is deleted and the agent re-enrolls when an enrollment token is present.

`KMATE_CATALOG_HIDE_NAMESPACES` accepts a trailing `*` for prefixes (default includes
`gke-managed-*`, `istio-system`, `gmp-*`, `cert-manager`, `ingress-nginx`).

## Internal structure

```
cmd/kmate-agent/main.go          flags, wiring, signal handling
internal/agent/
  tunnel/        gRPC tunnel client: connect, enroll, heartbeat, reconnect, frame mux
  cache/         shared informer factory (typed + dynamic), GVR discovery, RESTMapper
  handlers/      one handler per request kind (list, get, watch, apply, patch, delete, scale, restart, logs, exec, pf, helm list/get, metrics, catalog)
  discovery/     Service Catalog builder (see 05)
  rbac/          impersonation helpers, SubjectAccessReview cache
  metrics/       metrics-server + Prometheus adapters
internal/proto/  generated code (via gen/)
```

## Tunnel protocol (agent side)

- On start: `Enroll(EnrollRequest{token, cluster_info})` → `EnrollResponse{agent_id, cert, key, ca}`.
  Stored in the Secret (agent has `update` on its own Secret) so restarts don't
  need the enrollment token again. If the Secret can't be written, the agent keeps
  the cert in memory and re-enrolls on restart (tokens can be multi-use with expiry).
- Then `Tunnel()` bidi stream. First message is `Hello{agent_id, version, capabilities}`.
- Heartbeat every 15 s carrying cluster summary (node count, pod count, k8s version,
  catalog version). Hub marks agent offline after 3 missed beats.
- All other messages are `Frame{stream_id, payload}`. Even `stream_id`s are opened
  by the Hub, odd by the Agent (agent-initiated streams are used for catalog push
  and alerts).
- Flow control: per-stream credit-based window (`WindowUpdate` frames) so one
  chatty log stream cannot starve watches. Initial window 256 KiB.

## Watch semantics

- `WatchRequest{gvr, namespace, label_selector, field_selector, resource_version}`.
- Agent replies with a synthetic `SYNC` batch (current cache contents) then live
  `ADDED/MODIFIED/DELETED` events, each carrying the full object (JSON), or a
  server-side-trimmed "summary" projection if the client asks for `columns_only`
  (table view mode, dramatically smaller for big clusters).
- Object payloads strip `managedFields` unless explicitly requested.
- Unknown GVRs (CRDs) are served via the dynamic informer, created lazily on first
  watch and torn down after 10 min without watchers.

## Writes

`Apply` (server-side apply, field manager `kmate`), `Patch`, `Delete`, `Scale`,
`RolloutRestart`, `Cordon/Drain` (drain phase 4). Every write goes through
impersonation and is audit-logged with the Hub-supplied user, request id, and diff
summary.

## Exec / logs / port-forward

- Logs: `pods/log` with follow, tail, since, timestamps, previous, container.
  Streamed as `Data` frames. Multi-container "all containers" mode merges with prefix.
- Exec: `remotecommand` executor (WebSocket transport, SPDY fallback). TTY resize
  frames. Frames are opaque bytes; the agent does no interpretation.
- Port-forward: `PortForwardOpen{pod, port}` opens a stream; subsequent `Data`
  frames are raw TCP bytes. The **client** listens on a local port (desktop/CLI)
  or the Hub exposes an authenticated HTTP proxy for web/mobile (phase 4).

## Helm

Releases are read from `helm.sh/release.v1` Secrets (base64 → gzip → JSON); no Helm
SDK. `helm_list` returns the latest revision per release; `helm_get` returns one
revision (default latest) with user values, chart default values, rendered manifest,
notes and the full revision history.

## Service Catalog health and Jobs

Pods owned by a Job that has finished (`Succeeded`/`Failed`) are ignored; running Job
pods are listed as workloads but never affect health, so a completed migration hook
does not mark a service Degraded.

## Sizing and memory

The agent keeps informer caches in memory, so its footprint tracks **how many
objects the cluster holds**, not how many people are looking at it. Idle does not
mean cheap.

This matters more here than for a conventional dashboard. KMate routes every
request for a cluster through its one agent, so an OOMKill does not degrade a
view, it takes the whole cluster offline until the pod is rescheduled. Size for
the peak, not the average, and alert before the limit.

| Cluster | Pods | Namespaces | Suggested limit |
|---|---|---|---|
| Development / kind | < 100 | < 20 | 256Mi |
| Small production | < 1 000 | < 50 | 512Mi |
| Medium | < 5 000 | < 200 | 1Gi |
| Large | < 20 000 | < 500 | 2Gi (chart default) |
| Very large | 20 000+ | 500+ | 4Gi, or scope `namespaces` |

These are starting points. Measure with `kmate_agent_memory_bytes` under real
load and set the limit near twice the observed peak, which leaves room for the
resync spikes that happen when the agent reconnects and refills its caches.

Two levers reduce the footprint directly:

- **Scope the namespaces.** `--set namespaces={team-a,team-b}` builds informers
  for those namespaces only. On a large multi-tenant cluster this is the single
  biggest saving, and it pairs naturally with per-namespace grants.
- **Leave CRDs alone.** Custom resource informers are created lazily on first
  watch and torn down after ten minutes idle, so nobody pays for CRDs they never
  open.

A `PodDisruptionBudget` ships enabled by default, because a node drain that
evicts the agent blanks the cluster in the UI until it comes back.

## Failure behaviour

| Failure | Behaviour |
|---------|-----------|
| Hub unreachable | backoff 1s→60s with jitter, keep informers warm, buffer nothing |
| API server slow | informers handle it; requests have 30 s deadline, streams don't |
| Agent OOM | Namespace scoping recommended; agent exposes `/metrics` with cache sizes |
| Cert expired | re-enroll if token still valid, else log loud error + `CrashLoopBackOff`-visible reason |

## Observability

- `/healthz`, `/readyz` (ready = tunnel connected + informers synced)
- `/metrics` Prometheus:

  | Metric | Why you care |
  |---|---|
  | `kmate_agent_memory_bytes` | Go heap in use. Alert at ~70% of the limit. |
  | `kmate_agent_memory_sys_bytes` | Memory taken from the OS, closer to what the kernel counts. |
  | `kmate_agent_cache_objects{gvr=...}` | Objects per informer. Finds the resource behind a jump. |
  | `kmate_agent_cache_objects_total` | Everything cached, the number that tracks memory. |
  | `kmate_agent_cache_informers` | Active informers, including lazily created CRD ones. |
  | `kmate_agent_goroutines` | A climbing count suggests leaked streams. |
  | `kmate_agent_tunnel_connected` | 0 means the cluster is dark in the UI. |
  | `kmate_agent_catalog_entries` | Service Catalog size. |

  A reasonable starting alert, assuming a 2Gi limit:

  ```
  kmate_agent_memory_bytes > 1.4e9          # 70% of the limit, for 10m
  kmate_agent_tunnel_connected == 0         # for 5m
  ```
- Structured JSON logs (slog)
