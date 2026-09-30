# Phase 1 · Agent + Hub core (2 weeks)

## Agent
- [x] `tunnel`: Enroll → Tunnel; Hello; heartbeat 15 s; reconnect with backoff; frame mux with stream ids and credit windows
- [x] `cache`: dynamic shared informer factory; RESTMapper refresh every 5 min; discovery cache
- [x] handlers: `Discover`, `List`, `Get`, `Watch` (SYNC + live events, `columns_only` projection)
- [x] `--kubeconfig` local mode + in-cluster mode
- [x] `/healthz`, `/readyz`, `/metrics`

## Hub
- [x] gRPC agent listener (plaintext in dev, mTLS behind flag)
- [x] Enrollment tokens (`kmt_enr_`), internal CA, cert issuance
- [x] Registry: in-memory tunnel table; SQLite store for clusters/users/tokens (sqlc)
- [x] Relay: OpenStream, frame pump, backpressure
- [x] Connect handlers: `HubService.{Login,Me,ListClusters,CreateCluster}`, `ClusterService.{Discover,List,Get,Watch}`
- [x] Local user auth (bcrypt) + JWT sessions; bootstrap admin from env

## Helm chart
- [x] `deploy/helm/kmate-agent` with RBAC toggles, Secret for enrollment, resources, NetworkPolicy option

## Exit test
```
make hub &            # :8080 / :9090
make agent-local &    # against kind kmate-dev
curl -X POST localhost:8080/kmate.v1.ClusterService/List -d '{"clusterId":"...","gvr":{"version":"v1","resource":"pods"}}'
```
returns pods; a `Watch` call streams changes when you `kubectl scale`.

## Status (2026-09-24)
Done and verified end to end against kind `kmate-dev`: agent enrolls, tunnel up, List/Watch/Get/Logs relayed. Not yet done: mTLS (enrollment issues a bearer `kmt_agt_` token instead of a cert; phase 5), frame-level credit flow control (mux uses per-stream buffers + slow-consumer close instead).
Enrollment tokens are reusable until their 24 h expiry so an agent that lost its identity Secret can re-enroll.
For local development the helm command shown in the UI can be replaced by `deploy/helm/kmate-agent` (chart path) or `make agent-local`.
