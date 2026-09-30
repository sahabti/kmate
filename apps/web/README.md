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

## Structure

```
src/
  main.tsx              entry; providers
  router.tsx            routes (code-based TanStack Router)
  index.css             Tailwind + theme tokens (dark default, .dark class strategy)
  api/
    client.ts           Connect transport, auth interceptor (Bearer), 401 -> /login, wsUrl()
    hooks.ts            useWatch (shared live streams), useCatalog, useClusters, useObject, useEventsFor
  gen/kmate/v1/         generated protobuf-es code (do not edit; `make proto` at repo root)
  platform/index.ts     Platform interface (openExternal, token storage, hub URL); web impl; Tauri swaps it
  store/
    session.ts          token + user (persisted: kmate.session)
    theme.ts            dark/light (persisted)
    ui.ts               namespace selector, search, sidebar state
    watch.ts            normalized Map<uid, object> per (cluster, gvr, namespace)
    drawer.ts           currently opened resource
  components/
    ui.tsx              Button, Input, Select, Badge, Dot, Card, Modal, Drawer, Tabs, KV, Chips, EmptyState, Spinner
    Table.tsx           VirtualTable (TanStack Virtual) + SimpleTable
  pages/
    Login.tsx, Clusters.tsx (picker + Add cluster modal), Settings.tsx
  cluster/
    Layout.tsx          sidebar (desktop) / bottom tabs (mobile), top bar with namespace + filter
    nav.ts              sidebar resource groups and route helpers
    columns.tsx         per-kind table columns (pods, deployments, services, ingresses, nodes, ...)
    catalog.tsx         Service Catalog dashboard (cards) + dense table
    ResourceList.tsx    generic live list for any GVR (/c/:id/r/:group/:version/:resource, group "core" for "")
    ResourceDrawer.tsx  Summary / YAML / Events / Logs / Terminal + Scale / Restart / Delete actions
    Logs.tsx            ClusterService.Logs stream viewer
    Terminal.tsx        xterm over /ws/clusters/:id/exec (binary framing, see file header)
    YamlView.tsx        Monaco read-only YAML
    Helm.tsx, CRDs.tsx
```

## Conventions

- Kubernetes objects are handled as raw JSON (`KObj`), decoded from `KubeObject.json`.
- One watch stream per (cluster, gvr, namespace, selector) is shared between components via `useWatch`.
- Route param `group` uses `core` for the empty core group.
- All external links go through `platform.openExternal`.

## UI stack

The UI is built on **shadcn/ui** (Radix primitives, `radix-nova` preset) plus components from the
**[Hirael](https://hirael.com)** shadcn registry. Both are installed as source under `src/components`
and owned by this repo (nothing to upgrade in `node_modules`).

| Where | Components |
|-------|------------|
| `src/components/ui/*` | shadcn: button, badge, card, dialog, sheet, tabs, input, input-group, select, table, command, tooltip, dropdown-menu, sidebar, separator, scroll-area, skeleton, switch, alert-dialog, sonner, label, popover, toggle-group, avatar, breadcrumb, checkbox, empty, field, collapsible |
| `src/components/*.tsx` (Hirael) | `combobox` (namespace picker), `stat-card` (catalog tiles), `relative-time` (ages, heartbeats), `copy-button`, `code-block` (helm command), `kbd` (shortcut hints, mobile terminal keys), `callout` (errors, tips), `spinner`, `timeline` (events), `password-input` (login) |
| `src/components/tone.tsx` | KMate-specific `Dot`, `ToneBadge`, `Chips` built on shadcn `Badge` |
| `src/components/Table.tsx` | Virtualized + simple tables using shadcn table styling |
| `src/components/status.tsx` | `ErrorCallout`, `Loading`, `EmptyState` wrappers |

Add more from either registry with the shadcn CLI, e.g.:

```bash
pnpm dlx shadcn@latest add @hirael/data-table
pnpm dlx shadcn@latest add popover
```

Theme tokens live in `src/index.css` (`:root` light, `.dark` dark; deep slate + cyan accent).


## Phase 4 features (ops)

| Feature | Where | Notes |
|---|---|---|
| YAML editing + server-side apply | Resource drawer → YAML | Monaco editor, Diff dialog (Monaco DiffEditor), Dry run toggle, Force toggle after a field conflict, Reset. Field manager `kmate`. Status/uid/resourceVersion are stripped from the apply body. |
| Exec terminal | Pod drawer → Terminal | `/ws/clusters/{id}/exec?cmd=…` with the byte-channel framing (`0x00` stdin, `0xFF` resize; `0x01/0x02` out/err, `0x03` error). Shell picker + custom command, reconnect, copy/paste (Ctrl/⌘+Shift+C/V), mobile key bar with Ctrl modifier. |
| Port-forward | Pod / Service drawer → Actions → Port-forward… | `POST /pf/session` (bearer → cookie) then opens `/pf/{cluster}/{ns}/{pod}/{port}/` in a new tab. Services resolve a ready backing pod and the target port. "Copy kubectl port-forward" included. |
| Metrics | Pods and Nodes tables, pod/node drawer | `ClusterService.GetMetrics` polled every 15 s while a table is visible (`src/api/metrics.ts`), last 20 samples kept in `src/store/metrics.ts`, inline SVG sparklines (`src/components/Sparkline.tsx`). Stops per cluster when metrics-server is unavailable. |
| Helm details | Helm page → row | Sheet with Overview / Values (user vs chart defaults) / Manifest / History (click a revision). |
| Nodes | Nodes → row | Capacity/allocatable/usage table, taints, pods on this node, Cordon/Uncordon (merge patch on `spec.unschedulable`). |
| Audit log | Sidebar → Audit log (`/c/:id/audit`) | `HubService.ListAuditEvents`, filtered by the top-bar search. |
| Capability gating | everywhere | Write actions and the YAML editor are read-only unless the agent advertises `write`; Terminal needs `exec`. Disabled items carry a tooltip explaining the Helm/env flag to enable. |

Dev server proxies `/kmate.v1.`, `/ws` and `/pf` to the hub on `127.0.0.1:8080` (`vite.config.ts`).

## Realm View (pixel-art map)

`src/realm/` renders the cluster as a fantasy world with PixiJS. The Cute Fantasy art is
**not** in the repo (licence forbids redistribution): put the packs in `../../assets` (or set
`KMATE_ASSETS_DIR`) and run `pnpm realm:assets` — `pnpm dev`/`pnpm build` do it automatically.
Without the packs the route shows a placeholder. Dev gallery: `/c/<id>/realm/gallery`.
See `docs/11-realm-view.md`.
