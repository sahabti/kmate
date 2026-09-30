# Phase 4 · Ops features (3 weeks)

- [x] Exec: `/ws/clusters/{id}/exec`, xterm.js, resize, shell picker, mobile keyboard bar
- [x] Port-forward: Hub HTTP proxy `/pf/{cluster}/{ns}/{pod}/{port}/` for web/mobile (cookie via `POST /pf/session`); WebSocket `/ws/clusters/{id}/portforward` verified. Desktop native listener: phase 5 (Tauri)
- [x] Writes backend: server-side apply, scale, rollout restart, delete, cordon/uncordon (cluster-scoped Patch verified). YAML editor + diff preview: UI
- [x] Audit log at Hub for apply/patch/delete/scale/restart/logs/exec/port-forward (+ audit page: UI)
- [x] Helm: list releases, values, manifest, history (read from release Secrets)
- [x] Metrics: metrics-server CPU/mem for pods/nodes (returns `unimplemented` with a clear message when metrics.k8s.io is absent). Prometheus adapter + sparklines: later
- [ ] Node view with pods per node

## Status (2026-09-24, backend)
Verified against kind `kmate-dev` (write+exec) and a GKE cluster (read-only agent): exec over WebSocket (`echo` round trip), port-forward over WebSocket and over the `/pf/` HTTP proxy (bearer and cookie), Helm get (ArgoCD release: values, 26 KB chart defaults, 1.2 MB manifest, 10 revisions), metrics on both clusters, cordon/uncordon via cluster-scoped Patch, audit rows for all of them. Also added: `--identity-file` for out-of-cluster agents (restart without a token verified), finished Jobs no longer degrade service health, GKE/Istio platform namespaces hidden by default.

## Status (2026-09-24, end of day)
Web side complete and verified in Chrome against kind (writes) and GKE (read-only): editable YAML with diff + dry run + server-side apply, exec terminal, port-forward via `/pf/` proxy (new tab) and kubectl command copy, metrics sparklines (pods, nodes, per-container), Helm release sheet (values, manifest, history), node drawer with cordon/uncordon and pods-on-node, audit log page, capability gating (write/exec) everywhere.
Agent cache now resolves arbitrary field-selector paths (`spec.nodeName`, `status.phase`, `involvedObject.name`) instead of only `metadata.*`, so pods-on-node and events queries no longer transfer the whole collection.
Left for later phases: desktop native port-forward listener (Tauri, phase 5), WebSocket passthrough on `/pf/`, drain (only cordon/uncordon shipped).
