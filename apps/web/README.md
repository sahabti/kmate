# KMate Web UI

The single React/TypeScript UI for KMate. It is served by the Hub at `/` and is
the same bundle that the Tauri desktop and mobile shells load.

## Run

```bash
pnpm install
pnpm dev          # http://localhost:5173, proxies /kmate.v1.* and /ws to http://localhost:8080
pnpm build        # -> dist/ (embedded by the hub)
pnpm typecheck    # tsc --noEmit
```

Dev login defaults: `admin@kmate.local` / `admin` (from `make hub`).

## Stack

React 19 · TypeScript · Vite 7 · Tailwind CSS 4 · TanStack Router / Query / Virtual ·
Zustand · Connect-ES v2 (`@connectrpc/connect-web`) with generated clients from
`src/gen` · Monaco (YAML, lazy) · xterm.js (terminal, lazy) · lucide-react.

## Structure and conventions

Folder layout, code conventions, design-system rules and UI patterns are in
[AGENTS.md](AGENTS.md). Theme tokens live in `src/index.css` (`:root` light, `.dark` dark).

UI primitives come from **shadcn/ui** (Radix, `radix-nova`) and the **[Hirael](https://hirael.com)**
registry, installed as source under `src/components`:

```bash
pnpm dlx shadcn@latest add popover
pnpm dlx shadcn@latest add @hirael/data-table
```

Kubernetes objects are handled as raw JSON (`KObj`), decoded from `KubeObject.json`. One watch
stream per (cluster, gvr, namespace, selector) is shared between components via `useWatch`. Route
param `group` uses `core` for the empty core group.

## Phase 4 features (ops)

| Feature | Where | Notes |
|---|---|---|
| YAML editing + server-side apply | Resource drawer → YAML | Monaco editor, Diff dialog (Monaco DiffEditor), Dry run toggle, Force toggle after a field conflict, Reset. Field manager `kmate`. Status/uid/resourceVersion are stripped from the apply body. |
| Exec terminal | Pod drawer → Terminal | `/ws/clusters/{id}/exec?cmd=…` with the byte-channel framing (`0x00` stdin, `0xFF` resize; `0x01/0x02` out/err, `0x03` error). Shell picker + custom command, reconnect, copy/paste (Ctrl/⌘+Shift+C/V), mobile key bar with Ctrl modifier. |
| Port-forward | Pod / Service drawer → Actions → Port-forward… | `POST /pf/session` (bearer → cookie) then opens `/pf/{cluster}/{ns}/{pod}/{port}/` in a new tab. Services resolve a ready backing pod and the target port. "Copy kubectl port-forward" included. |
| Metrics | Pods and Nodes tables, pod/node drawer | `ClusterService.GetMetrics` polled every 15 s while a table is visible (`src/features/explorer/hooks/use-metrics-poll.ts`), last 20 samples kept in `src/stores/metrics.ts`, inline SVG sparklines (`src/components/sparkline.tsx`). Stops per cluster when metrics-server is unavailable. |
| Helm details | Helm page → row | Sheet with Overview / Values (user vs chart defaults) / Manifest / History (click a revision). |
| Nodes | Nodes → row | Capacity/allocatable/usage table, taints, pods on this node, Cordon/Uncordon (merge patch on `spec.unschedulable`). |
| Audit log | Sidebar → Audit log (`/c/:id/audit`) | `HubService.ListAuditEvents`, filtered by the top-bar search. |
| Capability gating | everywhere | Write actions and the YAML editor are read-only unless the agent advertises `write`; Terminal needs `exec`. Disabled items carry a tooltip explaining the Helm/env flag to enable. |

Dev server proxies `/kmate.v1.`, `/ws` and `/pf` to the hub on `127.0.0.1:8080` (`vite.config.ts`).

## Realm View (pixel-art map)

`src/features/realm/` renders the cluster as a fantasy world with PixiJS. The Cute Fantasy art is
**not** in the repo (licence forbids redistribution): put the packs in `../../assets` (or set
`KMATE_ASSETS_DIR`) and run `pnpm realm:assets` — `pnpm dev`/`pnpm build` do it automatically.
Without the packs the route shows a placeholder. Dev gallery: `/c/<id>/realm/gallery`.
See `docs/11-realm-view.md`.
