# 08 · Roadmap & Phases

Seven phases. Each phase ends with something runnable and demoable. Dates assume a
small team (2–3 engineers) starting 2026-09-24; adjust to headcount.

```mermaid
gantt
    title KMate delivery plan
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Phase 0 · Foundation
    Repo, proto contracts, CI, Makefile, dev cluster    :p0, 2026-09-24, 7d

    section Phase 1 · Agent + Hub core
    Tunnel, enrollment, heartbeat                       :p1a, after p0, 10d
    Informer cache, discover/list/get/watch             :p1b, after p0, 12d
    Hub relay, registry, SQLite store, local auth        :p1c, after p0, 12d
    Helm chart for agent                                :p1d, after p1a, 4d

    section Phase 2 · Service Catalog
    Catalog builder (svc, endpoints, workloads)         :p2a, after p1b, 8d
    Ingress + Gateway API exposure                      :p2b, after p2a, 6d
    Catalog push + Hub snapshot                         :p2c, after p2a, 4d

    section Phase 3 · Web UI MVP
    App shell, auth, cluster picker                     :p3a, after p1c, 7d
    Service Catalog dashboard                           :p3b, after p2c, 8d
    Resource tables + detail drawer + YAML              :p3c, after p3a, 12d
    Logs viewer                                         :p3d, after p3c, 5d

    section Phase 4 · Ops features
    Exec terminal (WebSocket)                           :p4a, after p3d, 7d
    Port-forward (desktop native + hub proxy)           :p4b, after p4a, 7d
    Writes: apply/scale/restart/delete + audit          :p4c, after p3c, 8d
    Helm releases, metrics-server charts                :p4d, after p4c, 8d

    section Phase 5 · Desktop + hardening
    Tauri desktop (Win/Mac/Linux), keychain, updater    :p5a, after p4b, 12d
    OIDC, impersonation, RBAC roles                     :p5b, after p4c, 10d
    Hub multi-replica, Postgres, TLS/mTLS polish        :p5c, after p5b, 10d

    section Phase 6 · Mobile
    Tauri mobile Android/iOS, responsive pass           :p6a, after p5a, 15d
    Push notifications (APNs/FCM), biometric gate       :p6b, after p6a, 10d

    section Phase 7 · v1.0
    Docs, signed releases, SBOM, load testing           :p7, after p6b, 10d
```

## Phase summaries

| Phase | Goal | Exit criteria | Doc |
|-------|------|---------------|-----|
| 0 | Foundation | `make proto && make build` green; kind cluster script | [phases/phase-0.md](phases/phase-0.md) |
| 1 | Agent + Hub core | Agent enrolls into Hub, `kmate get pods` via Hub works, live watch works — **done** | [phases/phase-1.md](phases/phase-1.md) |
| 2 | Service Catalog | Catalog JSON for a demo app shows ingress URLs and health — **done, incl. Istio** | [phases/phase-2.md](phases/phase-2.md) |
| 3 | Web UI MVP | Login → cluster → dashboard → pods → logs in browser — **done** | [phases/phase-3.md](phases/phase-3.md) |
| 4 | Ops features | exec, port-forward, edits, Helm, metrics — **done 2026-09-24** | [phases/phase-4.md](phases/phase-4.md) |
| 5 | Desktop + hardening | signed desktop builds; OIDC; multi-replica hub — in-cluster deployment on GKE done 2026-09-28, see [10-deploy-gke.md](10-deploy-gke.md) | [phases/phase-5.md](phases/phase-5.md) |
| 6 | Mobile | TestFlight + Play internal track builds; push notifications | [phases/phase-6.md](phases/phase-6.md) |
| 7 | v1.0 | public release | [phases/phase-7.md](phases/phase-7.md) |

## Realm View (parallel track, started 2026-09-29)

A fantasy-map visualisation of the cluster using the Cute Fantasy pixel-art packs.
Design and delivery steps R0–R4 live in [11-realm-view.md](11-realm-view.md); decision in
[ADR 0008](adr/0008-realm-view-pixijs.md). It runs alongside phase 5 and does not block it.

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Tauri mobile maturity | Mobile phase slips | Fallback: Capacitor wrapping the same SPA. Decide at start of phase 6. |
| Large clusters blow agent memory | Adoption on big prod clusters | Namespace scoping, `columns_only` projections, lazy CRD informers, memory metrics from day 1. |
| Corporate proxies block HTTP/2 / gRPC | Agent can't reach Hub | Agent supports gRPC-over-WebSocket fallback (phase 5). |
| Impersonation not granted | Coarse authz only | UI shows "shared identity" badge; docs push `rbac.impersonate=true`. |
| Scope creep toward "Lens parity" | Never ships | Phases are strict; extras go to backlog in `docs/backlog.md`. |
