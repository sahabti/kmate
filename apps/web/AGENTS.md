# KMate web: rules for people and agents

The web UI follows the **pxkit conventions** (the `pxkit-conventions` skill) for code, and the
design-system rules below for UI. When this file and pxkit disagree, this file wins for KMate.

## Gate

Run from `apps/web` before calling anything done. CI runs the same steps.

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Then check the change in the browser: light and dark theme, and a narrow (mobile) width. The same
bundle runs in Tauri webviews (ADR 0004/0005).

## Structure

```
src/
  main.tsx, router.tsx, index.css
  features/<name>/          one business area; owns its components/, hooks/, lib/, stores/
    auth/  clusters/  users/  settings/  explorer/  realm/
  components/               app components shared by 2+ features (app-shell, data-table, confirm, status, …)
  components/ui/            shadcn primitives, verbatim (see "shadcn" below)
  hooks/                    hooks shared by 2+ features, one per file (use-watch.ts, use-clusters.ts, …)
  services/                 transport: api-client.ts (Connect + auth), watch-mux.ts (multiplexed watches)
  stores/                   zustand stores shared across features
  lib/                      pure helpers shared by 2+ files, with colocated *.test.ts
  constants/                constants shared by 2+ files
  platform/                 web / Tauri platform abstraction
  gen/                      generated protobuf-es code; never edit (`make proto`)
```

- **Where a file goes:** a thing used by one feature lives in that feature. It moves to a shared
  folder the moment a second feature imports it, not before.
- **Dependency direction:** features import shared code; shared code never imports a feature, and
  features never import each other. Something two features need is shared, so it moves up.
- **Files:** kebab-case, named after the main export (`resource-drawer.tsx` → `ResourceDrawer`).
  `.tsx` only when the file has JSX. One concept per file, including everything private to it.
- **Imports:** always the defining file via `@/…`. No barrel `index.ts`, no re-export middlemen,
  no relative `../` paths.

## Code

pxkit in short; ESLint enforces the mechanical parts.

- Named exports only (no `export default`). `React.lazy` uses
  `lazy(() => import("@/…").then((m) => ({ default: m.Name })))`.
- Components and functions are arrow `const`s. Props are a declared `interface FooProps`, never an
  inline type literal. No `any`, no `enum`.
- Server data goes through TanStack Query or the shared watch store (`useWatch`), never
  `useState` + `useEffect` + `fetch`.
- Comments explain why, never restate the code.
- Error keys (`Result<T, K>` + `ErrorKey`) are **not adopted yet**: services still throw and the UI
  shows `errorMessage(e)`. Don't add a second error style; the migration is a planned follow-up.

## shadcn and styling

- `components/ui/*` mirrors shadcn (`radix-nova`) verbatim. Add or refresh primitives with
  `pnpm dlx shadcn@latest add <name>`; don't hand-edit them. Hirael registry items come in the same
  way (`@hirael/<name>`).
- **Don't restyle a primitive.** `className` on a shadcn component carries layout only (width,
  margin, grid placement, flex). Climb this ladder and stop at the first step that works:
  existing variant → layout `className` → theme token → new variant in a KMate component
  (`components/*`, never `ui/`) → wrapper element. `shadcn/no-restyle` is an error; never disable
  it inline. Allowed spacing slots live in `LAYOUT_SLOTS` in `eslint.config.mjs`.
- Components vendored from Hirael (`callout`, `code-block`, `sparkline`, … listed in
  `eslint.config.mjs`) are design-system source and exempt, as in Hirael itself.
- Colours come from tokens only (`bg-muted`, `text-success`, `border-warning/30`), never raw palette
  classes or hex. Status pills go through `ToneBadge` / `Dot` / `Chips` (`components/tone.tsx`),
  KMate's own pill components rather than restyled `Badge`s.
- `gap-*` over `space-*`, `size-*` over `w-`/`h-` pairs, `cn()` for class merging.

## Type scale

Body text is 14px (`text-sm`, set on `body`). Use only these sizes; lint rejects arbitrary
`text-[Npx]` values.

| Role | Class |
|---|---|
| Page title (`PageHeader`) | `text-2xl font-semibold` |
| Section title | `text-base font-medium` |
| Body, table cells, controls, descriptions | `text-sm` (the default; usually no class) |
| Secondary line, caption, hint, meta | `text-xs text-muted-foreground`; 12px is the floor |

Monospace values (names, IPs, versions) take the size of the text around them; don't shrink
them. Uppercase eyebrow labels are `text-xs font-medium`.

## App shell

Two levels, like Cloudflare's account and zone dashboards, both in `components/app-shell.tsx`:

| | Hub level (Clusters, Users, Settings) | Cluster level (`/c/:id/…`) |
|---|---|---|
| Sidebar header | KMate brand | "All clusters" link + cluster switcher |
| Sidebar | Hub links | Overview, Resources, Cluster sections |
| Top bar | sidebar toggle, breadcrumb, account menu | same, plus namespace picker and filter |
| Body | centred, `max-w-6xl`, `px-4 py-6 md:px-8` | full width, `px-4 py-6 md:px-8` |

- The account menu (settings, theme, sign out) lives only in the top bar avatar.
- Controls in a bar use the **default size** (`h-8`): buttons, inputs, input groups, pickers.
  Don't mix `size="sm"` controls into a bar.
- Every hub page starts with `PageHeader` (title, one-line description, primary action on the right).
- Sidebar menus use `gap-1` between links.

## Patterns

- **Lists:** `DataTable` (`components/data-table.tsx`) for every list. It owns the table look
  (card surface, tinted header with muted labels, 16px cell padding, 45px rows); don't style
  tables per page. It grows with its rows,
  scrolls with the page, and virtualizes past 100 rows. Give each column a `value` (sorting, and the
  hover text of a truncated cell), `numeric` for quantities (tabular figures; every cell stays start-aligned so rows read evenly), and `title` when the hover text
  differs from the sort key (absolute time behind an age). Clickable rows need `rowLabel`. Per-row
  actions are a `…` menu in the last column that stops click propagation; dialogs it opens render
  outside the table.
- **Loading:** `loading` on `DataTable` shows skeleton rows on first load. Live lists show
  `LiveStatus` ("Live", "Syncing", "Reconnecting · showing data from 12s ago"). Never blank a list
  that has data: on reconnect rows stay and are marked stale.
- **Empty:** an icon, a title and a hint (`emptyIcon`, `emptyTitle`, `emptyHint`). Distinguish
  first use, filtered to zero ("No pods match …" + clear), unreachable cluster, and denied
  (`DeniedState`, naming the missing verb and resource).
- **Errors:** inline where the user is looking. Errors from a dialog or form show inside it and the
  dialog stays open; never a toast behind a modal. `ErrorCallout` for panels.
- **Toasts:** only to confirm an action the user started, naming the object
  ("Deleted pod api-7f9"). Errors that need action never go in an auto-dismissing toast.
- **Destructive actions** go through `useConfirm` (`components/confirm.tsx`):
  1. routine (restart, scale, cordon): short confirm, button names the outcome ("Cordon node");
  2. delete a resource: dialog names kind, name, namespace; `tone: "destructive"`;
  3. severe and irreversible (delete namespace or node, remove cluster): add `typeToConfirm`.
  Menu items that open a dialog end with "…". Never "OK" or "Confirm" as a button label.
- **Forms:** `FieldGroup` → `Field` → `FieldLabel htmlFor` + control. `<form noValidate>` so Enter
  submits; errors appear after the first submit, then update live, with `aria-invalid` and focus
  on the first invalid field. Keep submit enabled except while pending, and show a spinner then.
- **Menus:** `DropdownMenuContent` gets an explicit width (`w-52`–`w-64`); radix-nova otherwise
  sizes it to the trigger.
- **Copy:** sentence case everywhere, verb-first buttons, "…" as the real ellipsis character.
- **Accessibility:** icon-only buttons need `aria-label`; status is never colour alone; respect
  `prefers-reduced-motion` (`motion-reduce:`); hit targets at least 24px.
