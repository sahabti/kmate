# 09 · Development Guide

## Prerequisites

| Tool | Version | Used for |
|------|---------|----------|
| Go | 1.26+ | agent, hub |
| Node + pnpm | Node 22+, pnpm 10+ | web UI |
| buf | 1.50+ | proto codegen (remote plugins, needs network) |
| Docker + kind | any recent | local cluster |
| kubectl, helm | any recent | |
| Rust (cargo) | stable | Tauri desktop/mobile shells (phase 5+) |

## Local loop

```bash
make kind-up                 # cluster "kmate-dev" + ingress-nginx + demo app in ns "shop"
make hub                     # terminal 1 → http://localhost:8080 (admin@kmate.local / admin)
make web                     # terminal 2 → http://localhost:5173 (proxies API to :8080)
# in the UI: Add cluster → copy the enrollment token, then:
KMATE_ENROLLMENT_TOKEN=kmt_enr_... make agent-local   # terminal 3, agent runs out-of-cluster
```

The agent enrolls, opens its tunnel, and the cluster flips to ONLINE. The Overview
page shows the demo app's Service Catalog with `http://shop.127.0.0.1.nip.io:8081/`.

## Running the agent in-cluster (kind)

```bash
make images
kind load docker-image kmate/agent:dev --name kmate-dev
helm upgrade --install kmate-agent deploy/helm/kmate-agent -n kmate-system --create-namespace \
  --set image.tag=dev --set hub.addr=host.docker.internal:9090 --set hub.insecure=true \
  --set enrollment.token=kmt_enr_...
```

## Layout conventions

- `cmd/*`: thin mains. `internal/*`: all logic. Nothing outside `internal/mux` and
  `gen/` is shared between agent and hub.
- Proto is the contract. Change `proto/`, run `make proto`, then fix both sides.
- Every request kind has exactly one handler function in `internal/agent/handlers`.
- Tests: `go test ./...`, `cd apps/web && pnpm test` (when added).

## Container images

`make images` builds `kmate/agent` and `kmate/hub` locally. Publishing is done by
CI (`.github/workflows/release.yml`), not by hand: every push to `main` and every
`v*` tag builds both images and pushes them to the registry named by the
`REGISTRY_URL` repository secret, authenticated with `REGISTRY_USERNAME` and
`REGISTRY_PASSWORD`. Pull requests do not publish, since a fork cannot read
secrets.

> **Do not push a locally built hub image.** `hub.Dockerfile` copies `assets*`
> into the build context, so a hub image built on a machine that has the Cute
> Fantasy packs contains art that may not be redistributed. CI clones have no
> `assets/` directory, so images it builds are clean. See
> [11-realm-view.md](11-realm-view.md).

The same workflow packages `deploy/helm/kmate-hub` and `deploy/helm/kmate-agent`
and pushes them to `oci://$REGISTRY_URL/charts`. Charts are versioned from the git
ref, not from `Chart.yaml`: a tag `v1.2.3` publishes `1.2.3`, while a push to main
publishes `<chart version>-main.<short sha>`, a semver prerelease that sorts below
any real release so `helm upgrade` will not pick it up by accident.

```bash
helm pull oci://<registry>/charts/kmate-hub --version 1.2.3
```

## Debugging

- `go run ./cmd/kmate-agent --kubeconfig ~/.kube/config --dump-catalog` prints the
  Service Catalog for the current context and exits.
- Hub: `curl -s -X POST localhost:8080/kmate.v1.HubService/Login -H 'content-type: application/json' -d '{"email":"admin@kmate.local","password":"admin"}'`.
- Agent metrics: `curl localhost:8082/metrics`. Hub metrics: `curl localhost:9091/metrics`.
