# 11 · Realm View — the cluster as a living fantasy world

> "Every cluster is a realm. Nodes are islands, namespaces are villages, workloads
> are houses, and pods are the villagers who live in them. When something breaks,
> monsters show up."

Realm View is an alternative, fully live visualisation of a cluster rendered with the
**Cute Fantasy** pixel-art packs (Kenmi, itch.io) that live in `assets/`. It sits next
to the tables and the Service Catalog as a third way to look at the same data; every
sprite is clickable and opens the same drawers, logs and terminals as the normal UI.

It is not a game. Nothing in the realm changes the cluster unless you use the same
actions the tables already expose. It is a **spatial, at-a-glance health map** that
also happens to be delightful.

---

## 1. Why

- Ops people build a mental map of "where things live" anyway; a literal map with
  stable positions makes that map shared and visible.
- Health states are far faster to read as *monsters attacking a house* than as a
  `CrashLoopBackOff` string in a column of 400 rows.
- Mobile: a pannable map with big tappable buildings works better on a phone than a
  17-column table.
- It's a differentiator no other Kubernetes tool has, and the assets are already
  licensed for commercial use.

## 2. The mapping (canonical)

Everything below is deterministic: the same cluster always renders the same world.

### 2.1 Terrain

| Kubernetes | Realm | Sprites | Rules |
|---|---|---|---|
| Cluster | **Realm** (one map) | biome tileset | Biome per cluster (user setting, default *Meadow*): Meadow (Cute_Fantasy grass), Desert, Shroomlands, Volcano, Dungeon; seasonal packs (Halloween, Christmas) as overlays. |
| Node | **Island** — a cliff-edged plateau in the sea | `Tiles/Grass/Grass_Tiles_*`, `Tiles/Cliff/Stone_Cliff_*`, `Tiles/Water/*` | Area ∝ allocatable CPU+memory (min 14×14 tiles). Sorted by name, placed on a spiral so new nodes appear at the edge. |
| Node Ready | normal island | | |
| Node NotReady / unknown | island turns to **volcano** tiles, lava bubbles, `Flying_Skull` circling | `Cute_Fantasy_Volcano/*` | |
| Node cordoned | **palisade** around the island, gate closed | `MilitaryCamp/Palisade*.png`, `Palisade_Gate_Anim` | Gate opens on uncordon. |
| Control-plane node | island has a **lookout tower** with the realm flag | `MilitaryCamp/Lookout_Towers.png`, `Flags_Anim.png` | label `node-role.kubernetes.io/control-plane`. |
| Node pressure conditions (Memory/Disk/PID) | **weather** over the island | `Weather effects/Clouds.png`, `Rain_Drop*`, `Wind_Anim` | Also driven by metrics: CPU > 80 % → wind + clouds; memory > 80 % → rain; both → storm (dark overlay). |
| Namespace | **Village plot** — fenced area with a signpost carrying the name | `Outdoor decoration/Fences.png`, `Signs.png` | A namespace with pods on several nodes gets a plot on each island; same fence style, same banner colour (hash of name). System namespaces (`kube-system`, `istio-system`, …) are a **military camp** plot on each island (tents, spikes) and are collapsed by default. |

### 2.2 Workloads → buildings

| Kubernetes | Realm | Sprites | Size / variant rules |
|---|---|---|---|
| Deployment | **Wooden house** | `Buildings/Houses/Wood/House_{1..5}_Wood_*` | Tier by `spec.replicas`: 1 → House_1, 2–3 → House_2, 4–6 → House_3, 7–12 → House_5, > 12 → `Inn`. Roof colour = hash(namespace) ∈ {Base, Green, Red} × door {Black, Blue, Red}. |
| StatefulSet | **Stone house** (it persists) + **barrels/silo** for each PVC | `Houses/Stone/*`, `Silo.png`, `barrels.png` | same tiers |
| DaemonSet | **Military tent** on *every* island | `Tent_Big.png` / `Military_Tents.png` | one per island where a pod runs |
| Job | **Mine entrance with ores**; miner works while running, **gold pile** when complete, **collapsed** (rocks) when failed | `Cave_Entrance`, `Ores.png`, `Gold_Piles.png` | |
| CronJob | **Windmill**; blades spin when a job is active; sleeping (no spin) when suspended | `Windmill/*` | |
| Bare pod (no controller) | **Small tent** | `Tent_Small.png` | |
| ReplicaSet (old, 0 replicas) | *not drawn* | | only the live one matters |
| HPA | **Well** next to the house; bucket rises with current/desired ratio | `Well.png` | |
| CRD-backed workload (unknown kind) | **Mushroom house** | `ShroomLands/Houses/*` | e.g. Argo Rollouts, CNPG clusters |

Building **health tint** (applied as an overlay ring on the ground, not by recolouring the art):
green = all replicas ready, amber = partially ready, red = 0 ready with desired > 0,
grey = scaled to 0. A **progress ribbon** (UI_Ribbons) above the house shows `ready/desired`
while a rollout is in progress.

### 2.3 Pods → villagers

Each pod is an animated **character** standing or wandering inside its plot, near its house.

| Pod owner | Character sheet |
|---|---|
| Deployment | villagers: `NPCs (Premade)/Farmer_Bob`, `Farmer_Buba`, `Chef_Chloe`, `Bartender_*`, `Fisherman_Fin` (hash of pod name picks one) |
| StatefulSet | **Knights** (`Characters/Knights/Swordman`, `Spearman`) — they guard the stone house |
| DaemonSet | **Archers** (`Characters/Knights/Archer`) — one on watch per island |
| Job / CronJob | **Miner_Mike** (`Lumberjack_Jack` for CronJob) |
| System namespaces | **Templar** |
| Static pods (kube-apiserver…) | **Angel** (they are above mortal concerns) |

Pod state → animation / companions:

| Pod state | What you see |
|---|---|
| Running & Ready | idle or slow random walk inside the plot |
| Running, not Ready (readiness failing) | character stands still with a `?` bubble (UI_Icons) |
| Pending (unschedulable) | character stands on the **shore of the sea** (no island accepted it) with a hourglass bubble |
| ContainerCreating / Init | character hammering (`Lumberjack` chop anim) next to the house, `Init:n/m` ribbon |
| CrashLoopBackOff / Error | a **red slime** (`Slime_Medium_Red`) attacks the character, who plays the *hurt* animation; each restart adds a slime, capped at 3 |
| OOMKilled (last state) | **Bombschroom** explodes at the house, toxic cloud VFX |
| Evicted | character replaced by a **skeleton** walking off the island |
| Terminating | *death* animation, then fades out over 2 s |
| Succeeded (Job) | character sits by the gold pile |
| Unknown | character in grey silhouette |
| restarts > 0 | small `!` ribbon with the count above the character |

### 2.4 Networking → roads, gates and bridges

| Kubernetes | Realm |
|---|---|
| Service (ClusterIP) | **signpost** at the plot edge pointing at the house(s) it selects; a **market stall** if it fronts more than one workload |
| Service with no ready endpoints | signpost broken (`Sign_*_Anim` break frames) |
| Ingress / HTTPRoute / Istio VirtualService / LoadBalancer (any exposure in the Service Catalog) | **stone bridge** from the island to the **outer sea** with a **gate** (`Palisade_Gate`); hovering shows the URL; clicking opens it. TLS → gate has a blue banner, plain HTTP → red banner |
| NetworkPolicy | **hedge** (`Hedge_Tiles`) around the plot |
| EndpointSlice ready count | number of lanterns lit on the signpost |

### 2.5 Config & storage → chests and props

| Kubernetes | Realm |
|---|---|
| ConfigMap | **wooden chest** in the plot's *storehouse row* (right of the namespace sign); hover shows the name, click opens the drawer. Up to 6 per kind, then a `+N` chest that opens the list |
| Secret | **golden locked chest** in the same row; the drawer keeps values masked |
| PVC Bound | **barrel**; Pending → empty barrel outline; Lost → broken barrel |
| PV | **well** at the island edge |
| StorageClass | *not drawn* |

### 2.6 Events and time

- Warning events → a **smoke puff** at the object and a `!` popup for 10 s; clicking opens the Events tab.
- Realm clock: real time. Night mode (dark overlay + lantern glow) when the user's clock says so; storms override.
- Cluster offline (agent disconnected) → the realm freezes, desaturates, and a "fog" rolls in.

## 3. Layout algorithm

Goal: stable, deterministic, readable positions that change only where the cluster changed.

```
World
 └─ Island[node]           placed on a square spiral, gap = 6 sea tiles
     ├─ size = ceil(sqrt(sum(plot areas) * 1.6)) clamped [14, 96] tiles
     ├─ Plot[namespace]    shelf-packed inside the island (sorted by area desc, then name)
     │    ├─ area = buildings on 3×3 tile cells + 1-tile paths, + margin 1
     │    ├─ Building[workload]   row-major on the cell grid, sorted by name
     │    └─ Actor[pod]           slot ring around its building (8 slots), overflow ring 2
     ├─ Signpost[service]  on the plot's south edge
     └─ Bridge[exposure]   on the island's edge facing the outer sea
 └─ Shore                  pending pods stand here, sorted by namespace/name
```

- All hashes are `fnv1a(name)`; sprite variant, roof colour, character and wander seed
  come from hashes, never from array order.
- Diffing: the world builder is a pure function `build(objects) → World`; the renderer
  keeps a map `id → sprite` and tweens position changes over 300 ms; unchanged ids keep
  their sprites (and animation phase).
- Re-layout of an island is triggered only when a plot's cell count changes
  (new workload, tier change), not per pod.

## 4. Rendering

- **PixiJS v8** (WebGL2, WebGPU when available), nearest-neighbour texture scaling (also for render textures), canvas at the device pixel ratio with pixel rounding,
  integer zoom levels ×1 ×2 ×3 ×4 (×2 default), camera pan by drag/wheel/touch, pinch zoom.
- Text: labels and tooltips use **Pixelify Sans** (OFL, bundled via @fontsource) rasterised at renderer resolution × zoom; the pack's own 5×9 font is kept only as a fallback because it is hard to read at UI sizes.
- Layers: sea (animated water tiles) → islands (autotiled grass + cliffs) → plots (fences,
  paths) → props (chests, barrels, signs) → buildings → actors (y-sorted) → weather → UI.
- Sprite atlas per pack generated at build time (see §6). Animations via
  `AnimatedSprite`; all actors share a global ticker with staggered phase so 3 000 pods
  don't step in sync.
- LOD: villagers are visible at every zoom level. Only realms with more than 1 500 pods
  hide them at ×1 and show a `ready/desired` badge on each house instead (user request:
  the default overview must show the villagers). Off-screen islands are culled.
- Budget: 60 fps with 2 000 visible actors on a 2021 MacBook Air; 30 fps target on a
  mid-range Android. Measured in R3.

## 5. Interaction

- Hover → wooden tooltip (UI_Frames) with kind, name, namespace, status line.
- Click → existing **resource drawer** (Summary / YAML / Events / Logs / Terminal).
- Click a bridge → opens the exposure URL. Click a signpost → Service drawer.
- Namespace selector in the top bar dims every other plot.
- Search box: matches highlight with a bouncing arrow; Enter flies the camera to the first.
- Legend panel (collapsible) explains the mapping; toggle "show system camps".
- Keyboard: WASD/arrows pan, `+`/`-` zoom, `F` follow selected pod, `Esc` deselect.
- Mobile: bottom sheet instead of drawer, touch pan/pinch, tap = click.

## 6. Asset pipeline & licensing (important)

Licences (verified in `assets/*/read_me.txt`):

| Pack | Licence | Use in KMate |
|---|---|---|
| Cute_Fantasy (premium), Characters, Desert, Dungeons, UI, Volcano, MilitaryCamp, ShroomLands, Halloween, Christmas | commercial OK, modify OK, **no redistribution** | **used** |
| Cute_Fantasy_Free | non-commercial only | **excluded** (the premium pack contains everything in it) |
| forest-monster (.blend, CC0) | CC0 | not used (3D) |

"No redistribution" means the raw sprites cannot be committed to a public repository or
shipped in a public npm package. Therefore:

1. `assets/` is **git-ignored**. The repo contains only `apps/web/realm/manifest.json`
   (a list of *which* files we use, their frame grids and animations) — no art.
2. `pnpm realm:assets` copies the referenced files from `KMATE_ASSETS_DIR` (default
   `../../assets`) into `apps/web/public/realm/` (also git-ignored) and writes
   `public/realm/index.json`. If the directory is missing the build still succeeds and
   the Realm route shows an "assets not installed" placeholder.
3. Container images built from a machine with the assets include them; those images
   must stay in a **private registry** (your Artifact Registry is fine). A public
   community image would ship without the art and with the placeholder.
4. Attribution "Art: Cute Fantasy by Kenmi" in the legend panel.

## 7. Data flow

```
watch store (zustand, already live)  ──▶  worldBuilder.ts (pure)  ──▶  RealmRenderer (Pixi)
   pods, nodes, deployments,               World { islands, plots,       sprites, tweens,
   statefulsets, daemonsets, jobs,          buildings, actors, props,      culling, ticker
   cronjobs, services, ingresses,           bridges, shore }
   endpointslices, pvcs, configmaps,
   secrets(names only), events
catalog store (exposures, health)   ──▶
metrics store (cpu/mem per node)    ──▶  weather
```

Everything the realm needs is already streamed for the tables; opening the realm adds
watches only for kinds not yet open. All watches share one multiplexed WebSocket per
cluster (`/ws/clusters/{id}/watch`), so the eleven kinds cost one connection. Secrets are watched with `columns_only` (names
only, never data).

## 8. Delivery plan

| Step | Scope | Exit criteria |
|---|---|---|
| **R0 · Foundations** ✅ 2026-09-29 | design (this doc), ADR, asset manifest + copy script + licence guard, Pixi integration in the React app, a `/c/:id/realm/gallery` dev page that renders every referenced sheet with its frame grid and animations | gallery shows villagers walking, a house, tiles; build passes with and without assets |
| **R1 · Static realm** ✅ 2026-09-29 | world builder (islands, plots, buildings, signposts, bridges, shore) from the live watch store; renderer with pan/zoom, hover tooltip, click → drawer; namespace dimming; legend | kind cluster renders 1 island with `shop` plot: 3 houses, signposts, a bridge to the outer sea; clicking a house opens the Deployment drawer |
| **R2 · Life** ✅ (2026-09-29) | pods as animated villagers with all state rules of §2.3; slimes for CrashLoop; job miners; terminating fade; live diff/tween; DaemonSet tents; chests/barrels | kill a pod in kind → villager dies, a new one walks in; scale to 0 → house greys; readiness probe failure → `?` bubble |
| **R3 · Weather & polish** | metrics-driven weather, warning-event puffs, night mode, minimap, search fly-to, mobile touch, performance pass with 2 000 actors, LOD | GKE dev cluster (190 pods) at 60 fps on the laptop, usable on a phone |
| **R4 · Biomes & seasons** | Desert / Shroomlands / Volcano / Dungeon biomes as per-cluster setting, Halloween/Christmas overlays by date, sound toggle (optional) | switch biome live without reload |

Each step ends with screenshots checked in a real browser against the kind cluster,
and R3 against GKE.

## 9. Open questions

- Should namespaces be the primary grouping instead of nodes (villages on a continent)?
  Decision for R1: nodes as islands, because pods physically live on nodes and node
  health is what breaks realms. A "by namespace" continent mode is a candidate for R4.
- Sound: off by default; would need extra assets (none in the packs).
- Very large clusters (5 000+ pods): show actors only for the selected namespace.

## 10. Implementation notes (R0/R1, 2026-09-29)

Code: `apps/web/src/realm/` — `assets.ts` (loader), `camera.ts`, `PixiCanvas.tsx`, `world.ts` (+ `world.test.ts`),
`renderer.ts`, `RealmView.tsx`, `Gallery.tsx` (dev page at `/c/:id/realm/gallery?filter=<ids>&zoom=<1-4>`).
Manifest: `apps/web/realm/manifest.json` (69 entries); copy script `apps/web/scripts/realm-assets.mjs`
(runs in `predev`/`prebuild`, honours `KMATE_ASSETS_DIR`, refuses `Cute_Fantasy_Free`).

Verified frame grids (by rendering every sheet in the gallery):

| Sheet | Frame | Rows |
|---|---|---|
| NPCs (Premade)/* , Angels | 64×64, 6 cols (Angel 8) | 0–2 idle down/side/up · 3–5 walk · 6 death (4 f) · 7+ tool/work rows (down/side/up) |
| Characters/Knights/* | 48×48, 6 cols | 0–2 idle · 3–5 walk · 6–8 attack · 9 death (4 f) · 10–12 hurt (2 f each) |
| Enemies/Skeleton | 32×32, 6 cols | 0–2 idle · 3–5 walk · 6 death · 7–9 attack |
| Enemies/Slime_Medium | 32×32, 8 cols | 0 idle (4) · 1 jump (8) · 2 hurt (4) · 3 death (4) |
| Water_Middle_Anim_1 | 16×16 | 8 frames |
| Flags_Anim | 24×24, 4 cols | rows: beige, blue, red, orange (rows 4+ other pole) |
| Windmill_Sail_Anim | 64×80 | 4 frames; base = Windmill.png rect (0,0,64,112) |
| Lookout_Towers | rects 72×128 | (0,0) roof, (72,0) open |
| Military_Tents | rects 80×96 | rows = beige/blue/green/red/yellow; small tent at x=240 (64 wide) |
| Stone_Cliff_1_Tile | 16px, 14×6 | plateau block cols 1–3: rows 0–2 grass top, 3–4 wall, 5 foot — used for islands |
| Grass_Tiles_1 | 16px, 16×10 | cols 0–2 grass patch blob; 4–6 dirt patch; 7–9 grass over brown cliff; 10–12 over stone cliff (not used yet) |
| Fences / Hedge_Tiles | 16px, 4×4 | col 0 vertical posts; row 0 horizontals; cols 1–3 rows 1–3 closed loop corners |
| Signs | rects | tall signposts at y=152, 3 × (32×48) |
| UI_Icons | 16px | `!` at (192,32), `?` at (224,32) |

Deviations from the design:
- ~~Only pods were a live watch; other kinds were polled~~ **fixed**: all eleven kinds are live
  through the multiplexed WebSocket (`/ws/clusters/{id}/watch`, see docs/03-hub.md). Browsers
  allow six HTTP/1.1 connections per origin and each Connect server-stream held one; now one
  socket carries every watch, and three KMate tabs plus the realm load in ~7 s with no starvation.
- Islands are drawn from the cliff sheet (grass plateau over a stone wall) rather than the grass autotile.
- Tooltip is a drawn parchment box, not a UI_Frames nine-slice (no verified frame region yet).
- Pods are static idle frames (per §2.3 character choice); animation, slimes and death fades are R2.
- Building sprites are much larger than a 3×3 cell (House_2 = 9×8 tiles), so cells are sized from the
  sprite footprint plus a 3-tile yard; islands and plots grow accordingly.

### R2 · Life — implementation notes (2026-09-29)

**Actor system** (`apps/web/src/realm/actors.ts`): one `AnimatedSprite` per pod with a
state machine `idle ⇄ wander · walkin · walk · work · hurt · dying → fading · leaving · gone`.
All actors are advanced from one ticker call; off-screen actors (viewport + 96 px margin)
are hidden and skipped; animation phase is offset by `fnv1a(uid)` so villagers never step
in sync.

| Pod state (`world.ts actorState`) | Visual |
|---|---|
| Running & Ready | idle, then a random walk inside the plot (12 px/s, idle 2–8 s between walks, radius 5 tiles, never through a building footprint) |
| Running, not Ready | stands still, `?` bubble bobbing |
| Pending (no node) | stands on the shore with an hourglass bubble; when scheduled it enters through the plot gate and walks to its house |
| ContainerCreating / Init | `work` animation + `Init:n/m` ribbon (sidecar init containers excluded from n/m); villagers without a work row (chef, bartender) are stood in for by the lumberjack builder until Running |
| CrashLoopBackOff / Error / image errors | one red slime per restart (cap 3) orbiting the villager, `hurt` (or a red flash) every 3 s, `!N` restarts ribbon |
| OOMKilled | Bombschroom walks up, fuse → explode, toxic gas puff, permanent scorch mark under the villager, `!` bubble |
| Evicted | body swapped to the skeleton sheet, walks to the island edge, fades |
| Terminating | `death` animation, 2 s fade, sprite removed; pods that vanish without a Terminating phase fade in 0.9 s |
| Succeeded (Job) | star bubble, sits by the mine's gold pile |
| Unknown | grey tint |

Character choice: Deployment pods → villagers (Farmer_Bob, Farmer_Buba, Chef_Chloe,
Bartender_Katy, Fisherman_Fin by hash of the ReplicaSet-less pod name), StatefulSet →
Swordman/Archer, DaemonSet → Archer (no wander), Job → Miner_Mike (`work` while running),
CronJob → Lumberjack_Jack, system namespaces → Templar, static/mirror pods → Angel (bobs).

Animation rows used (6 columns per row): humanoid 13-row sheets — idle down/side/up = rows
0–2, walk down/side/up = rows 3–5, death = row 6 (4 frames, no loop), work = row 7;
knights (48 px) add hurt = row 9; skeleton (32 px) and slimes (`jump`/`hurt`/`death`),
Bombschroom (`fuse`, `explode`), toxic gas (`puff`) as listed in `realm/manifest.json`.

**Live diff**: actors are keyed by pod uid; new pods after the first sync spawn at the
plot's south gate and walk in; a rollout restart reads as old villagers dying while new
ones walk in.

**LOD**: zoom ×1 hides the actor layer and shows a `ready/desired` badge on each house;
×2+ shows actors. Measured on a 14" M-series MacBook, Chrome, 161 actors (150 pause pods +
demo): 60 fps at ×1, ×2 and ×3 (rAF-capped).

**Streams**: all resource watches plus the Service Catalog and the clusters list ride the
WebSocket mux (`/ws/clusters/{id}/watch`, kinds `catalog` and `clusters`; the clusters list
uses the pseudo cluster id `_hub`). A realm tab holds two sockets and no HTTP streams.

Verified scenarios on kind `kmate-dev` (screenshots in the session scratchpad `pw/r2-*.png`):
pod deletion → death + walk-in; scale 0 → grey ring, no villagers; CrashLoopBackOff →
slimes; init container → `Init:0/1` + work; Job → miner then gold pile; OOMKilled →
explosion + scorch; 150-pod stress at 60 fps; 3-tab load in 0.6 s.

Not done in R2: Evicted was implemented but not exercised live (kind does not evict easily);
weather, events, night, minimap, search fly-to and mobile touch polish are R3.
