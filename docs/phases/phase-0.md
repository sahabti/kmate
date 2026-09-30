# Phase 0 · Foundation (1 week)

## Deliverables
- [x] Monorepo layout (`cmd/`, `internal/`, `proto/`, `apps/`, `deploy/`, `docs/`)
- [x] Design docs + ADRs
- [x] `proto/kmate/v1/*.proto` with `buf.yaml`, `buf.gen.yaml` → Go + Connect-Go + Connect-ES
- [x] Go module, `Makefile` targets: `proto`, `build`, `test`, `lint`, `hub`, `agent-local`, `web`, `kind-up`, `demo-app`
- [x] `apps/web` scaffold (Vite + React + TS + Tailwind)
- [x] GitHub Actions CI: buf lint/breaking, go test, web build
- [x] `hack/kind-up.sh` creating cluster `kmate-dev` with ingress-nginx and a demo app (2 services, 1 ingress)

## Decisions locked
See ADRs 0001–0006.
