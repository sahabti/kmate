# KMate

**A Kubernetes IDE where the cluster comes to you.**

KMate gives you the Lens-style experience (multi-cluster browsing, live workloads,
logs, exec, port-forward, Helm, metrics) in your **browser**, without putting a
kubeconfig on any client or exposing your API server.

A small **agent** runs inside each cluster and dials *out* to a **hub** over one
long-lived stream. Clients talk only to the hub. No inbound firewall rules, no VPN,
no cluster credentials on laptops or phones.

```
┌────────────┐   ┌────────────┐   ┌────────────┐
│    Web     │   │  Desktop   │   │   Mobile   │     ← one React UI
└─────┬──────┘   └─────┬──────┘   └─────┬──────┘        (desktop/mobile planned)
      └────────────────┴────────┬───────┘
                                │  Connect-RPC + WebSocket (TLS)
                         ┌──────▼──────┐
                         │  KMate Hub  │   auth · routing · stream multiplexing
                         └──────▲──────┘
                                │  gRPC bidi stream — the agent dials OUT
          ┌─────────────────────┼─────────────────────┐
   ┌──────┴──────┐       ┌──────┴──────┐       ┌──────┴──────┐
   │    Agent    │       │    Agent    │       │    Agent    │
   │  cluster A  │       │  cluster B  │       │  cluster C  │
   └─────────────┘       └─────────────┘       └─────────────┘
```

## Why

Every other Kubernetes console needs credentials and a network path to the API
server on each client. That breaks for private clusters, edge clusters, phones and
"let me glance at prod from the sofa" moments. KMate inverts the direction: the
cluster connects to you.

A stolen laptop leaks nothing. The hub itself holds no cluster credentials, so the
worst a compromised hub can do is ask an agent to act within its own ServiceAccount,
which ships **read-only by default**.

## Features

| Area | What you get |
|------|--------------|
| **Agent-based access** | One `helm install` per cluster. Outbound only. No kubeconfig on any client. |
| **Service Catalog** | Auto-discovers every Service, its backing workloads, health, and how it is exposed — Ingress, Gateway API **and Istio VirtualService** — with clickable URLs. |
| **Live everything** | Informer-backed watches streamed over a single multiplexed WebSocket. No polling. |
| **Ops** | Logs, exec terminal, port-forward through the hub, server-side apply with diff preview, scale, restart, cordon. |
| **Helm & metrics** | Release values, manifests and history. CPU/memory sparklines from metrics-server. |
| **Realm View** | Your cluster as a living pixel-art world: nodes are islands, workloads are houses, pods are villagers, crashes summon monsters. See [docs/11-realm-view.md](docs/11-realm-view.md). |
| **Audit** | Every write, exec and port-forward recorded with the user who did it. |

## Status

**Early. Version 0.1.0, pre-release.** Phases 0 to 4 are built and running against
real clusters. It is genuinely useful today for browsing and operating clusters,
and it is not yet ready to be exposed to an untrusted network.

Working now: agent enrolment, live resources, Service Catalog with Istio and Ingress
discovery, logs, exec, port-forward, YAML apply, Helm, metrics, audit log, Realm View.

Not done yet, tracked in [docs/08-roadmap.md](docs/08-roadmap.md):

- **Security hardening (phase 5).** Single local admin account today. No OIDC, no
  per-user Kubernetes RBAC via impersonation, and the agent authenticates to the hub
  with a bearer token rather than mTLS. **Deploy it on a private network for now.**
- Desktop and mobile shells. The UI is responsive and the architecture is ready,
  but the Tauri shells are not built.
- Postgres and a multi-replica hub. SQLite and a single replica today.

## Quick start

Requirements: Go 1.26+, Node 22+ with pnpm, Docker, kind, kubectl, helm and
[buf](https://buf.build).

```bash
make kind-up        # local cluster + ingress-nginx + a demo app
make hub            # terminal 1 — hub on :8080 (clients) and :9090 (agents)
make web            # terminal 2 — UI on http://localhost:5173
```

Sign in with `admin@kmate.local` / `admin`, click **Add cluster**, copy the
enrollment token, then connect an agent using your current kubeconfig:

```bash
KMATE_ENROLLMENT_TOKEN=kmt_enr_... make agent-local
```

The cluster turns Online within seconds and the Overview shows the demo app's
services with their ingress URLs.

To run the agent properly, inside the cluster:

```bash
make images
kind load docker-image kmate/agent:dev --name kmate-dev
helm upgrade --install kmate-agent deploy/helm/kmate-agent -n kmate-system --create-namespace \
  --set image.tag=dev --set hub.addr=host.docker.internal:9090 --set hub.insecure=true \
  --set enrollment.token=kmt_enr_...
```

For a real deployment on GKE behind a private gateway, see
[docs/10-deploy-gke.md](docs/10-deploy-gke.md).

### Realm View

The pixel-art cluster map is rendered from commercial art packs that cannot be
redistributed, so they are not in this repository. Point `KMATE_ASSETS_DIR` at your
own copy of the [Cute Fantasy](https://kenmi-art.itch.io/cute-fantasy-rpg) packs and
run `pnpm realm:assets`. Without them the rest of KMate works normally and the Realm
route shows a placeholder.

## Security

- The agent's ClusterRole is **read-only** unless you opt in with `rbac.write`,
  `rbac.exec` or `rbac.impersonate`.
- The hub never stores kubeconfigs or cluster credentials.
- Agents open outbound connections only. No inbound port on the cluster.
- Secret values are masked in the UI.
- See [docs/06-security.md](docs/06-security.md) for the full threat model, and the
  Status section above for what is still missing.

Found a vulnerability? Please open a private security advisory rather than a public
issue.

## Documentation

Start with [docs/01-architecture.md](docs/01-architecture.md). The
[design decisions](docs/adr/) explain why the pieces are the way they are, and
[docs/09-development.md](docs/09-development.md) covers the local workflow.

## Repository layout

```
kmate/
├── docs/                 Design docs, ADRs, phase plans, roadmap (start here)
├── proto/                Protobuf contracts (agent↔hub, client↔hub)
├── gen/                  Generated Go and TypeScript (buf)
├── cmd/
│   ├── kmate-agent/      In-cluster agent
│   └── kmate-hub/        Hub: control plane and relay
├── internal/             Go packages for the agent and the hub
├── apps/web/             React + Vite UI, served by the hub
├── deploy/
│   ├── helm/             Charts for the agent and the hub
│   └── docker/           Dockerfiles
└── hack/                 Local cluster setup
```

## Contributing

Issues and pull requests are welcome. Please run `make test` and, for UI changes,
`pnpm typecheck && pnpm test && pnpm build` in `apps/web` before opening a PR.
The protobuf files are the contract between components: change `proto/`, run
`make proto`, then update both sides.

## Licence

[Apache 2.0](LICENSE). Copyright 2026 Sahabti.
