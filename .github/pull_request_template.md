<!--
Thanks for contributing. CONTRIBUTING.md has the development loop and the
conventions; the checklist below is only the part reviewers trip over most.
-->

## What this changes

<!-- And why. The "why" is the part a reviewer cannot reconstruct from the diff. -->

## How you tested it

<!--
"Ran against a 3-node EKS cluster, 40 namespaces" tells a reviewer far more
than "works". Say which Kubernetes distribution, and whether a mesh was in play.
-->

## Checklist

- [ ] `go build ./... && go vet ./... && go test ./...` passes
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` passes in `apps/web` (UI changes)
- [ ] If `proto/` changed: ran `make proto` and updated the agent, the hub **and** the UI
- [ ] If a new endpoint touches a cluster: it has a KMate grant check **and** flows through the agent's impersonation identity
- [ ] UI changes follow [`apps/web/AGENTS.md`](../apps/web/AGENTS.md) and were checked in light and dark theme at a narrow width
- [ ] A design decision worth arguing about has an ADR in `docs/adr/`
