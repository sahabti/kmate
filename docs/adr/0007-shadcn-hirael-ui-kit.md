# ADR 0007 · shadcn/ui + Hirael as the UI kit
**Status**: accepted · 2026-09-24

## Context
The first UI pass used hand-rolled primitives (Button, Modal, Drawer, Tabs…). Maintaining a private component set across web, desktop and mobile shells is wasted effort, and accessibility (focus traps, keyboard nav, ARIA) is easy to get wrong.

## Decision
Use **shadcn/ui** (Radix primitives, Tailwind v4, CSS-variable theming, "nova" preset) as the base component layer and **Hirael** (https://hirael.com, MIT, `@hirael/*` in the shadcn registry index) for higher-level components and blocks. Both are installed with the shadcn CLI, which copies source into `apps/web/src/components`, so there is no runtime package to upgrade and every component is ours to edit.

Installed (initial set):
- shadcn: button, badge, card, dialog, sheet, tabs, input, select, table, command, tooltip, dropdown-menu, sidebar, separator, scroll-area, skeleton, switch, alert-dialog, sonner, label, popover, toggle-group, avatar, breadcrumb, checkbox, empty, field, collapsible.
- Hirael: combobox (namespace picker), stat-card (dashboard tiles), relative-time (ages, heartbeats), copy-button, code-block (helm/enrollment commands), kbd (shortcut hints), callout (errors/notes), spinner, timeline (events), tree-view, animated-number, password-input; blocks `login-01` and `app-shell-01` used as the starting point for the login page and cluster shell.

Adding more: `cd apps/web && pnpm dlx shadcn@latest add @hirael/<name>` or `pnpm dlx shadcn@latest add <shadcn-name>`.

## Consequences
+ Accessible, themeable, RTL-ready components with light/dark from one token set.
+ Same components render inside Tauri webviews unchanged.
− Vendored source means upstream fixes are pulled manually (`--overwrite`).
− Base UI variant of Hirael is not used; we standardise on Radix.
