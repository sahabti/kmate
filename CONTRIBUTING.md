# Contributing to KMate

Thanks for considering a contribution. KMate is early and the surface area is
large, so help is genuinely useful — including help that is not code.

By contributing you agree that your work is licensed under the
[Apache License 2.0](LICENSE), and you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Try it against a real cluster and tell us what broke.** This is the most
  valuable thing right now. Clusters differ wildly; ours are GKE with Istio and
  kind. Bug reports from EKS, AKS, OpenShift, k3s or on-prem are gold.
- **Pick up something from [docs/backlog.md](docs/backlog.md)** or an issue
  labelled `good first issue`.
- **Improve the docs.** `docs/` is the design record, and the gap between what it
  says and what the code does is the easiest kind of bug to fix.
- **Realm View themes.** The theme contract in
  [docs/11-realm-view.md](docs/11-realm-view.md) lets you map a sprite pack onto
  the 50 render roles without touching Go. CC0 or permissively licensed art only.

## Before you write code

Open an issue first for anything that changes the proto contract, the
authorization model, or the shape of a page. For a bug fix or a self-contained
improvement, just send the pull request.

If you are unsure whether an idea fits, ask in a GitHub discussion. A rejected
pull request after a week of work is a bad outcome for everyone and it is easy to
avoid.

## Development setup

| Tool | Version | Used for |
|------|---------|----------|
| Go | 1.26+ | agent and hub |
| Node + pnpm | Node 22+, pnpm 10+ | web UI |
| buf | 1.50+ | proto codegen (uses remote plugins, needs network) |
| Docker + kind | any recent | local cluster |
| kubectl, helm | any recent | deployment |

```bash
git clone https://github.com/sahabti/kmate.git
cd kmate
make kind-up                 # cluster "kmate-dev", ingress-nginx, demo app in ns "shop"
make hub                     # terminal 1 → http://localhost:8080  (admin@kmate.local / admin)
make web                     # terminal 2 → http://localhost:5173
```

Then in the UI choose **Add cluster**, copy the enrolment token, and run the agent
against your kubeconfig:

```bash
KMATE_ENROLLMENT_TOKEN=kmt_enr_... make agent-local
```

The cluster flips to ONLINE and the Overview page fills in. More detail, including
running the agent in-cluster, is in [docs/09-development.md](docs/09-development.md).

Realm View needs a sprite pack. The bundled `tiny` theme is CC0 and works out of
the box; the premium packs are not redistributable, so point
`KMATE_ASSETS_DIR` at your own copy and run `pnpm realm:assets`. Builds succeed
without any art.

## Checks your pull request must pass

CI runs exactly these. Run them locally first:

```bash
make proto                              # only if you touched proto/ — then commit the generated code
go build ./... && go vet ./... && go test ./...
cd apps/web && pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build
helm lint deploy/helm/kmate-agent --set hub.addr=hub:9090
helm lint deploy/helm/kmate-hub
```

`make test` runs the Go side on its own.

**Web changes have their own rules.** [`apps/web/AGENTS.md`](apps/web/AGENTS.md) is
binding for anything under `apps/web`: where a file goes, named arrow exports, the
type scale, and the rule that server data goes through TanStack Query or the shared
watch store rather than `useState` + `useEffect` + `fetch`. ESLint enforces the
mechanical parts, so `pnpm lint` will tell you if you broke one. Check your change
in light and dark theme and at a narrow width before calling it done.

## Conventions

- **`proto/` is the contract.** Change it, run `make proto`, then fix the agent,
  the hub and the UI in the same pull request. Never hand-edit `gen/`.
- `cmd/*` holds thin mains; all logic lives in `internal/*`. Only `internal/mux`
  and `gen/` are shared between agent and hub.
- Every agent request kind has exactly one handler in `internal/agent/handlers`.
- **Authorization is two layers and both must be fed.** Any new endpoint that
  touches a cluster needs a KMate grant check *and* must flow through the agent's
  impersonation identity. See [docs/06-security.md](docs/06-security.md).
- Any design decision worth arguing about gets an ADR in `docs/adr/`. Copy the
  shape of an existing one.
- Go: standard `gofmt`. TypeScript: match the file you are editing; there is no
  formatter in CI yet, so do not reformat files you are not changing.

## Commits and pull requests

- Write commit subjects in the imperative mood, under about 72 characters, and
  explain *why* in the body. Follow the existing `git log`.
- Keep one logical change per pull request. Mechanical changes (a rename, a
  dependency bump) go in their own commit so reviewers can skip them.
- Describe how you tested it. "Ran against a 3-node EKS cluster, 40 namespaces"
  tells a reviewer far more than "works".
- A maintainer will review. Expect questions about the security model on anything
  that touches the agent's permissions — that scrutiny is the point, not
  obstruction.

## Reporting bugs

Open an issue with:

- What you expected and what happened.
- Your Kubernetes distribution and version, and whether a service mesh is in play.
- Whether the agent runs in-cluster or out, and the hub's version.
- Relevant agent and hub logs. The agent logs the request kind and stream id, so
  include the lines around the failure, not just the error.

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
