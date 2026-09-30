# Phase 3 · Web UI MVP (3 weeks)

- [x] App shell: sidebar / bottom tabs, theme, command palette (⌘K)
- [x] Auth: login page, session refresh, logout
- [x] Cluster picker with online/offline, "Add cluster" modal that shows the `helm install` command with the enrollment token
- [x] Service Catalog dashboard: card grid, grouping, filters, URL buttons, health
- [x] Generic resource table driven by `Discover` (dynamic columns from Table API / server-side printing) + virtualized rows + live watch
- [x] Detail drawer: summary, YAML (Monaco, read-only this phase), events
- [x] Logs viewer: follow, tail, container picker, search, download
- [x] Namespace selector, global search
- [x] Hub serves the built SPA from `embed.FS`

## Exit test
Login → pick cluster → dashboard shows demo app URLs → click card → pods → logs stream live.

## Status (2026-09-24)
Verified in headless Chrome: login → cluster picker → overview dashboard with ingress URLs → pods table → drawer → live logs; mobile layout with bottom tabs. Left for phase 4: YAML editing (editor is read-only), port-forward, Discover-driven dynamic columns, metrics charts. Monaco loads from a CDN by default (switch to the npm package for air-gapped hubs).
