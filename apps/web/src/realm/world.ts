/**
 * Pure world builder: Kubernetes objects → Realm scene model (docs/11-realm-view.md §3).
 * No Pixi here; unit-testable. All positions are in tiles (16 px) unless noted.
 */
import type { KObj } from "@/lib/k8s";
import { podStatus } from "@/lib/k8s";

export const TILE = 16;

/** KObj with metadata.name guaranteed (inputs are normalised once in buildWorld). */
type K = Omit<KObj, "metadata"> & { metadata: NonNullable<KObj["metadata"]> & { name: string; namespace: string } };
const norm = (list: KObj[] | undefined): K[] =>
  (list ?? []).filter((o) => !!o.metadata?.name).map((o) => ({ ...o, metadata: { namespace: "", ...o.metadata! } as K["metadata"] }));

export type Health = "ok" | "warn" | "bad" | "off";
export type ActorState = "idle" | "notready" | "pending" | "creating" | "crash" | "oom" | "evicted" | "terminating" | "succeeded" | "unknown";
export type BuildingKind = "Deployment" | "StatefulSet" | "DaemonSet" | "Job" | "CronJob" | "Pod" | "Custom";

export interface Rect { x: number; y: number; w: number; h: number }

export type ActorRole = "villager" | "knight" | "archer" | "miner" | "lumberjack" | "templar" | "angel";

export interface Actor {
  id: string;
  /** pod uid when known (stable identity across renames); falls back to id */
  uid: string;
  name: string;
  namespace: string;
  node: string | null;
  sheet: string;           // manifest id of the character sheet
  role: ActorRole;
  state: ActorState;
  restarts: number;
  x: number;               // px, world
  y: number;               // px, world (feet)
  buildingId: string | null;
  statusText: string;
  /** walkable area (px) for wandering; absent = never wanders */
  bounds?: Rect;
  /** building footprint (px) the actor must not walk through */
  avoid?: Rect;
  /** where a newly seen actor walks in from (plot gate), px */
  spawn?: { x: number; y: number };
  /** where an evicted actor walks off to (island edge), px */
  exit?: { x: number; y: number };
  /** init progress "n/m" while creating, when known */
  initProgress?: string;
  /** last container termination reason (OOMKilled…) */
  lastReason?: string;
}

export interface Prop {
  id: string;
  kind: "chest" | "golden_chest" | "barrel" | "ores" | "gold" | "lantern";
  x: number;
  y: number;
  /** For chests: the ConfigMap / Secret this chest represents (clickable). */
  apiKind?: "ConfigMap" | "Secret";
  name?: string;
  namespace?: string;
  /** For the last chest of a kind: how many more are not drawn. */
  more?: number;
}

/** Max chests drawn per kind per plot; the rest collapse into a "+N" chest. */
export const MAX_CHESTS = 6;

export interface Building {
  id: string;
  kind: BuildingKind;
  apiKind: string;         // "Deployment", "StatefulSet"...
  gvr: { group: string; version: string; resource: string };
  name: string;
  namespace: string;
  sprite: string;          // manifest id
  spriteName?: string;     // named sub-rect
  tier: number;
  cell: Rect;              // tiles, absolute
  x: number;               // px, ground anchor (bottom-center)
  y: number;
  ready: number;
  desired: number;
  health: Health;
  actors: Actor[];
  props: Prop[];
  note?: string;           // e.g. "rollout 2/3"
}

export interface Signpost { id: string; service: string; namespace: string; x: number; y: number; ready: boolean; exposed: boolean; type: string }
export interface Bridge { id: string; service: string; namespace: string; url: string; host: string; tls: boolean; x: number; y: number }

export interface Plot {
  id: string;
  namespace: string;
  island: string;
  system: boolean;
  rect: Rect;              // tiles, absolute (inside island)
  buildings: Building[];
  signposts: Signpost[];
  remote: Actor[];         // pods whose house lives on another island
  props: Prop[];
}

export interface Island {
  id: string;
  node: string;
  rect: Rect;              // tiles, absolute
  ready: boolean;
  cordoned: boolean;
  controlPlane: boolean;
  plots: Plot[];
  bridges: Bridge[];
  tents: Building[];       // DaemonSet tents
  cpu: number;             // allocatable millicores
  memory: number;          // allocatable bytes
}

export interface World {
  islands: Island[];
  shore: Actor[];          // pending pods
  bounds: Rect;            // tiles
  counts: { pods: number; buildings: number; namespaces: number };
}

export interface CatalogLite {
  namespace: string;
  name: string;
  health: number;          // kmate Health enum value
  exposures: Array<{ kind: string; url: string; host: string; tls: boolean }>;
}

export interface WorldInput {
  nodes: KObj[];
  pods: KObj[];
  deployments: KObj[];
  statefulsets: KObj[];
  daemonsets: KObj[];
  jobs: KObj[];
  cronjobs: KObj[];
  services: KObj[];
  pvcs: KObj[];
  configmaps: KObj[];
  secrets: KObj[];
  catalog: CatalogLite[];
  showSystem: boolean;
  systemNamespaces?: string[];
}

export const DEFAULT_SYSTEM_NS = ["kube-system", "kube-public", "kube-node-lease", "kmate-system", "istio-system", "gmp-system", "gmp-public", "gke-gmp-system", "config-management-system", "cert-manager", "ingress-nginx", "local-path-storage"];

// ---------- hashing ----------
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const pick = <T,>(arr: readonly T[], key: string): T => arr[fnv1a(key) % arr.length]!;

// ---------- sprite catalogues ----------
const VILLAGERS = ["npc_farmer_bob", "npc_farmer_buba", "npc_chef_chloe", "npc_bartender_katy", "npc_fisherman_fin"] as const;
const ROOFS = ["blue", "green", "red"] as const;

/** Tier from desired replicas (docs §2.2). */
export function tierFor(replicas: number): 1 | 2 | 3 | 5 | 6 {
  if (replicas <= 1) return 1;
  if (replicas <= 3) return 2;
  if (replicas <= 6) return 3;
  if (replicas <= 12) return 5;
  return 6; // inn
}

/** Sprite footprint (tiles) per manifest id. Height includes a 3-tile yard for actors. */
const FOOTPRINT: Record<string, { w: number; h: number; yard: number }> = {
  house_1: { w: 6, h: 8, yard: 3 },
  house_2: { w: 9, h: 8, yard: 3 },
  house_3: { w: 9, h: 8, yard: 3 },
  house_5: { w: 12, h: 8, yard: 3 },
  inn: { w: 15, h: 12, yard: 3 },
  windmill: { w: 4, h: 7, yard: 3 },
  cave_entrance: { w: 3, h: 3, yard: 2 },
  tent_big: { w: 5, h: 6, yard: 2 },
  tent_small: { w: 3, h: 6, yard: 2 },
  military_tents: { w: 5, h: 6, yard: 2 },
  house_shroom_1: { w: 5, h: 5, yard: 2 },
};
function footprintOf(sprite: string) {
  const base = sprite.replace(/^house_(wood|stone)_(\d)_.*$/, "house_$2");
  return FOOTPRINT[base] ?? { w: 6, h: 8, yard: 3 };
}

function houseSprite(material: "wood" | "stone", tier: number, namespace: string): string {
  if (tier === 6) return "inn";
  const roof = material === "wood" ? pick(ROOFS, namespace) : "blue";
  return `house_${material}_${tier}_${roof}`;
}

// ---------- pod helpers ----------
function ownerOf(pod: K): { kind: string; name: string } | null {
  const o = pod.metadata?.ownerReferences?.[0];
  return o ? { kind: o.kind, name: o.name } : null;
}

export function actorState(pod: K | KObj): { state: ActorState; text: string } {
  const st = podStatus(pod);
  const phase = pod.status?.phase;
  if (pod.metadata?.deletionTimestamp) return { state: "terminating", text: "Terminating" };
  if (phase === "Succeeded") return { state: "succeeded", text: "Completed" };
  if (phase === "Pending" && !pod.spec?.nodeName) return { state: "pending", text: st.text };
  if (st.text === "Evicted" || pod.status?.reason === "Evicted") return { state: "evicted", text: "Evicted" };
  if (/OOMKilled/.test(st.text) || (pod.status?.containerStatuses ?? []).some((c: any) => c.lastState?.terminated?.reason === "OOMKilled" && c.state?.waiting)) return { state: "oom", text: st.text === "Running" ? "OOMKilled (restarting)" : st.text };
  if (/CrashLoopBackOff|Error|ImagePull|ErrImage|CreateContainerConfigError|RunContainerError/.test(st.text)) return { state: "crash", text: st.text };
  if (/ContainerCreating|Init|PodInitializing|Pending/.test(st.text)) return { state: "creating", text: st.text };
  if (st.text === "Running") return { state: st.tone === "ok" ? "idle" : "notready", text: st.tone === "ok" ? "Running" : "Running (not ready)" };
  if (st.text === "Unknown") return { state: "unknown", text: "Unknown" };
  return { state: st.tone === "bad" ? "crash" : "idle", text: st.text };
}

function restartsOf(pod: K): number {
  return (pod.status?.containerStatuses ?? []).reduce((a: number, c: any) => a + (c.restartCount ?? 0), 0);
}

export function roleOfSheet(sheet: string): ActorRole {
  if (sheet === "angel") return "angel";
  if (sheet === "knight_templar") return "templar";
  if (sheet === "knight_archer") return "archer";
  if (sheet.startsWith("knight_")) return "knight";
  if (sheet === "npc_miner_mike") return "miner";
  if (sheet === "npc_lumberjack_jack") return "lumberjack";
  return "villager";
}

function initProgressOf(pod: K): string | undefined {
  const ics: any[] = pod.status?.initContainerStatuses ?? [];
  if (!ics.length) return undefined;
  const sidecars = new Set((pod.spec?.initContainers ?? []).filter((c: any) => c?.restartPolicy === "Always").map((c: any) => c.name));
  const steps = ics.filter((c) => !sidecars.has(c.name));
  if (!steps.length) return undefined;
  const done = steps.filter((c) => c.state?.terminated?.exitCode === 0).length;
  return `${done}/${steps.length}`;
}

function lastReasonOf(pod: K): string | undefined {
  for (const c of pod.status?.containerStatuses ?? []) {
    const r = c.lastState?.terminated?.reason ?? c.state?.terminated?.reason;
    if (r) return r;
  }
  return undefined;
}

function sheetFor(ownerKind: string | null, namespace: string, podName: string, system: boolean, isStatic: boolean): string {
  if (isStatic) return "angel";
  if (system) return "knight_templar";
  switch (ownerKind) {
    case "StatefulSet": return pick(["knight_swordman", "knight_swordman", "knight_archer"], podName);
    case "DaemonSet": return "knight_archer";
    case "Job": return "npc_miner_mike";
    case "CronJob": return "npc_lumberjack_jack";
    default: return pick(VILLAGERS, namespace + "/" + podName.replace(/-[a-z0-9]+-[a-z0-9]{5}$/, ""));
  }
}

// ---------- packing ----------
interface Packed<T> { item: T; x: number; y: number; w: number; h: number }
/** Shelf packing: items sorted by area desc then name; returns placements + total size. */
function shelfPack<T>(items: Array<{ key: string; w: number; h: number; item: T }>, targetW: number, gap: number): { placed: Packed<T>[]; w: number; h: number } {
  const sorted = [...items].sort((a, b) => b.w * b.h - a.w * a.h || (a.key < b.key ? -1 : 1));
  const placed: Packed<T>[] = [];
  let x = 0, y = 0, shelfH = 0, maxW = 0;
  for (const it of sorted) {
    if (x > 0 && x + it.w > targetW) {
      x = 0;
      y += shelfH + gap;
      shelfH = 0;
    }
    placed.push({ item: it.item, x, y, w: it.w, h: it.h });
    x += it.w + gap;
    shelfH = Math.max(shelfH, it.h);
    maxW = Math.max(maxW, x - gap);
  }
  return { placed, w: maxW, h: y + shelfH };
}

/** Square spiral cell order: (0,0),(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1),(0,-1),(1,-1),(2,-1)... */
export function spiral(n: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  let x = 0, y = 0, dx = 1, dy = 0, seg = 1, step = 0, turns = 0;
  for (let i = 0; i < n; i++) {
    out.push({ x, y });
    x += dx; y += dy; step++;
    if (step === seg) {
      step = 0;
      [dx, dy] = [-dy, dx];
      turns++;
      if (turns % 2 === 0) seg++;
    }
  }
  return out;
}

const ACTOR_SLOTS: Array<[number, number]> = [
  [-1.5, 1], [0, 1], [1.5, 1], [-3, 1.5], [3, 1.5], [-1.5, 2.5], [1.5, 2.5], [0, 2.8],
  [-3.5, 2.8], [3.5, 2.8], [-2.2, 0.4], [2.2, 0.4], [-4.5, 1], [4.5, 1], [-4.5, 2.5], [4.5, 2.5],
];

interface Spec { id: string; kind: BuildingKind; apiKind: string; gvr: Building["gvr"]; name: string; namespace: string; sprite: string; spriteName?: string; tier: number; ready: number; desired: number; pods: K[]; note?: string; propKinds: Prop["kind"][] }

// ---------- main ----------
export function buildWorld(input: WorldInput): World {
  const systemNs = new Set(input.systemNamespaces ?? DEFAULT_SYSTEM_NS);
  const isSystem = (ns: string) => systemNs.has(ns) || /^gke-managed-/.test(ns);
  const nodes = norm(input.nodes).sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1));
  const inPods = norm(input.pods), inDeploys = norm(input.deployments), inSts = norm(input.statefulsets), inDs = norm(input.daemonsets);
  const inJobs = norm(input.jobs), inCron = norm(input.cronjobs), inSvcs = norm(input.services), inPvcs = norm(input.pvcs), inCms = norm(input.configmaps), inSecrets = norm(input.secrets);
  const nodeNames = nodes.map((n) => n.metadata.name);
  const firstNode = nodeNames[0] ?? null;

  // pods grouped by owner and node
  const podsByOwner = new Map<string, K[]>(); // `${kind}/${ns}/${name}`
  const bare: K[] = [];
  const shore: K[] = [];
  for (const p of inPods) {
    const ns = p.metadata.namespace;
    if (!input.showSystem && isSystem(ns)) continue;
    const st = actorState(p);
    if (st.state === "pending") { shore.push(p); continue; }
    const o = ownerOf(p);
    if (!o) { bare.push(p); continue; }
    let key = `${o.kind}/${ns}/${o.name}`;
    if (o.kind === "ReplicaSet") {
      // Deployment name = ReplicaSet name minus pod-template-hash suffix
      const dep = o.name.replace(/-[a-z0-9]{5,10}$/, "");
      key = `Deployment/${ns}/${dep}`;
    }
    if (o.kind === "Job") {
      const cj = o.name.match(/^(.*)-\d{8,}$/);
      if (cj && inCron.some((c) => c.metadata.namespace === ns && c.metadata.name === cj[1])) key = `CronJob/${ns}/${cj[1]}`;
    }
    if (!podsByOwner.has(key)) podsByOwner.set(key, []);
    podsByOwner.get(key)!.push(p);
  }

  // workloads → building specs (not yet placed)
  const specs: Spec[] = [];
  const add = (s: Spec) => { if (input.showSystem || !isSystem(s.namespace)) specs.push(s); };

  for (const d of inDeploys) {
    const ns = d.metadata.namespace!, name = d.metadata.name;
    const desired = d.spec?.replicas ?? 1, ready = d.status?.readyReplicas ?? 0;
    const tier = tierFor(desired);
    add({ id: `Deployment/${ns}/${name}`, kind: "Deployment", apiKind: "Deployment", gvr: { group: "apps", version: "v1", resource: "deployments" }, name, namespace: ns, sprite: houseSprite("wood", tier, ns), tier, ready, desired, pods: podsByOwner.get(`Deployment/${ns}/${name}`) ?? [], note: ready < desired && desired > 0 ? `${ready}/${desired}` : undefined, propKinds: [] });
  }
  for (const s of inSts) {
    const ns = s.metadata.namespace!, name = s.metadata.name;
    const desired = s.spec?.replicas ?? 1, ready = s.status?.readyReplicas ?? 0;
    const tier = tierFor(desired);
    const pvcs = inPvcs.filter((p) => p.metadata.namespace === ns && new RegExp(`-${name}-\\d+$`).test(p.metadata.name)).length;
    add({ id: `StatefulSet/${ns}/${name}`, kind: "StatefulSet", apiKind: "StatefulSet", gvr: { group: "apps", version: "v1", resource: "statefulsets" }, name, namespace: ns, sprite: houseSprite("stone", tier, ns), tier, ready, desired, pods: podsByOwner.get(`StatefulSet/${ns}/${name}`) ?? [], note: ready < desired && desired > 0 ? `${ready}/${desired}` : undefined, propKinds: Array(Math.min(pvcs, 4)).fill("barrel") });
  }
  for (const j of inJobs) {
    const ns = j.metadata.namespace!, name = j.metadata.name;
    if (j.metadata.ownerReferences?.some((o: any) => o.kind === "CronJob")) continue; // folded into the windmill
    const succeeded = j.status?.succeeded ?? 0, failed = j.status?.failed ?? 0, active = j.status?.active ?? 0;
    const desired = j.spec?.completions ?? 1;
    add({ id: `Job/${ns}/${name}`, kind: "Job", apiKind: "Job", gvr: { group: "batch", version: "v1", resource: "jobs" }, name, namespace: ns, sprite: "cave_entrance", tier: 1, ready: succeeded, desired, pods: podsByOwner.get(`Job/${ns}/${name}`) ?? [], note: active ? "working" : failed ? "failed" : succeeded >= desired ? "done" : undefined, propKinds: succeeded >= desired ? ["gold"] : failed ? [] : ["ores"] });
  }
  for (const c of inCron) {
    const ns = c.metadata.namespace!, name = c.metadata.name;
    const active = (c.status?.active ?? []).length;
    add({ id: `CronJob/${ns}/${name}`, kind: "CronJob", apiKind: "CronJob", gvr: { group: "batch", version: "v1", resource: "cronjobs" }, name, namespace: ns, sprite: "windmill", spriteName: "base", tier: 1, ready: active, desired: c.spec?.suspend ? 0 : 1, pods: podsByOwner.get(`CronJob/${ns}/${name}`) ?? [], note: c.spec?.suspend ? "suspended" : active ? "running" : undefined, propKinds: [] });
  }
  for (const p of bare) {
    const ns = p.metadata.namespace!, name = p.metadata.name;
    add({ id: `Pod/${ns}/${name}`, kind: "Pod", apiKind: "Pod", gvr: { group: "", version: "v1", resource: "pods" }, name, namespace: ns, sprite: "tent_small", tier: 1, ready: actorState(p).state === "idle" ? 1 : 0, desired: 1, pods: [p], propKinds: [] });
  }
  // pods whose controller object we don't have (unknown CRD owners, bare ReplicaSets,
  // or a workload not yet synced) → mushroom house per owner so no pod is ever lost
  const KNOWN_GVR: Record<string, Building["gvr"]> = {
    Deployment: { group: "apps", version: "v1", resource: "deployments" }, StatefulSet: { group: "apps", version: "v1", resource: "statefulsets" },
    Job: { group: "batch", version: "v1", resource: "jobs" }, CronJob: { group: "batch", version: "v1", resource: "cronjobs" },
  };
  for (const [key, pods] of podsByOwner) {
    const [kind, ns, name] = key.split("/") as [string, string, string];
    if (kind === "DaemonSet" || specs.some((s) => s.id === key)) continue;
    const ready = pods.filter((p) => actorState(p).state === "idle").length;
    add({ id: key, kind: "Custom", apiKind: kind, gvr: KNOWN_GVR[kind] ?? { group: "", version: "", resource: "" }, name, namespace: ns, sprite: "house_shroom_1", tier: 1, ready, desired: pods.length, pods, propKinds: [] });
  }

  // decide the home island for each spec: node with most pods, else first node
  const homeIsland = (s: Spec): string | null => {
    const count = new Map<string, number>();
    for (const p of s.pods) { const n = p.spec?.nodeName; if (n) count.set(n, (count.get(n) ?? 0) + 1); }
    let best: string | null = null, bestN = -1;
    for (const n of nodeNames) { const c = count.get(n) ?? 0; if (c > bestN) { best = n; bestN = c; } }
    return best ?? firstNode;
  };

  // DaemonSets → one tent per island with pods (or on every island when no pods)
  interface TentSpec { ds: K; node: string; pods: K[] }
  const tents: TentSpec[] = [];
  for (const ds of inDs) {
    const ns = ds.metadata.namespace!, name = ds.metadata.name;
    if (!input.showSystem && isSystem(ns)) continue;
    const pods = podsByOwner.get(`DaemonSet/${ns}/${name}`) ?? [];
    const byNode = new Map<string, K[]>();
    for (const p of pods) { const n = p.spec?.nodeName ?? firstNode; if (!n) continue; if (!byNode.has(n)) byNode.set(n, []); byNode.get(n)!.push(p); }
    if (byNode.size === 0 && firstNode) byNode.set(firstNode, []);
    for (const [node, ps] of byNode) tents.push({ ds, node, pods: ps });
  }

  // group specs per (island, namespace)
  const plotSpecs = new Map<string, { island: string; namespace: string; specs: Spec[]; remote: K[] }>();
  const plotKey = (island: string, ns: string) => `${island}|${ns}`;
  const ensurePlot = (island: string, ns: string) => {
    const k = plotKey(island, ns);
    if (!plotSpecs.has(k)) plotSpecs.set(k, { island, namespace: ns, specs: [], remote: [] });
    return plotSpecs.get(k)!;
  };
  for (const s of specs) {
    const home = homeIsland(s);
    if (!home) continue;
    ensurePlot(home, s.namespace).specs.push(s);
    for (const p of s.pods) {
      const n = p.spec?.nodeName;
      if (n && n !== home && nodeNames.includes(n)) ensurePlot(n, s.namespace).remote.push(p);
    }
  }
  for (const t of tents) ensurePlot(t.node, t.ds.metadata.namespace!);

  // build plots per island
  const islands: Island[] = [];
  const perIslandPlots = new Map<string, Plot[]>();
  const perIslandTents = new Map<string, Building[]>();
  const catalogByNs = new Map<string, CatalogLite[]>();
  for (const c of input.catalog) { if (!catalogByNs.has(c.namespace)) catalogByNs.set(c.namespace, []); catalogByNs.get(c.namespace)!.push(c); }

  for (const node of nodeNames) {
    const plots: Plot[] = [];
    const entries = [...plotSpecs.values()].filter((p) => p.island === node).sort((a, b) => (a.namespace < b.namespace ? -1 : 1));
    for (const e of entries) {
      const ns = e.namespace;
      const system = isSystem(ns);
      // building cells
      const cells = e.specs.map((s) => { const f = footprintOf(s.sprite); return { key: s.id, w: f.w + 1, h: f.h + f.yard + 1, item: s }; });
      // remote pods get a strip
      const remoteW = e.remote.length ? Math.min(12, 2 + e.remote.length * 2) : 0;
      if (remoteW) cells.push({ key: `remote/${ns}`, w: remoteW, h: 4, item: null as unknown as Spec });
      const tentsHere = tents.filter((t) => t.node === node && t.ds.metadata.namespace === ns);
      for (const t of tentsHere) cells.push({ key: `tent/${t.ds.metadata.name}`, w: 6, h: 9, item: null as unknown as Spec });
      const area = cells.reduce((a, c) => a + c.w * c.h, 0);
      const targetW = Math.max(12, Math.ceil(Math.sqrt(area) * 1.4));
      const packed = shelfPack(cells, targetW, 1);
      const services = inSvcs.filter((s) => s.metadata.namespace === ns);
      const cmNames = inCms.filter((c) => c.metadata.namespace === ns && !/^kube-root-ca\.crt$/.test(c.metadata.name)).map((c) => c.metadata.name).sort();
      const secNames = inSecrets.filter((c) => c.metadata.namespace === ns && !/^sh\.helm\.release/.test(c.metadata.name)).map((c) => c.metadata.name).sort();
      const chestCount = Math.min(MAX_CHESTS, cmNames.length) + Math.min(MAX_CHESTS, secNames.length);
      // storehouse row: chests sit on the row right of the namespace sign, under the north fence
      const plotW = Math.max(packed.w, services.length * 4, 5 + Math.ceil(chestCount * 1.5)) + 2; // margin 1 each side
      const plotH = packed.h + 4 + (services.length ? 3 : 0);
      plots.push({
        id: `${node}/${ns}`, namespace: ns, island: node, system,
        rect: { x: 0, y: 0, w: plotW, h: plotH },
        buildings: [], signposts: [], remote: [], props: [],
        // temp storage
        ...({ _packed: packed, _specs: e, _services: services, _cms: cmNames, _secrets: secNames, _tents: tentsHere } as object),
      } as Plot);
    }
    // pack plots into the island
    const cells = plots.map((p) => ({ key: p.namespace, w: p.rect.w, h: p.rect.h, item: p }));
    const area = cells.reduce((a, c) => a + c.w * c.h, 0);
    const targetW = Math.max(14, Math.ceil(Math.sqrt(area) * 1.3));
    const packed = shelfPack(cells, targetW, 2);
    const n = nodes.find((x) => x.metadata.name === node)!;
    const cp = !!(n.metadata.labels?.["node-role.kubernetes.io/control-plane"] !== undefined || n.metadata.labels?.["node-role.kubernetes.io/master"] !== undefined);
    const readyCond = (n.status?.conditions ?? []).find((c: any) => c.type === "Ready");
    const w = Math.max(14, packed.w + 4 + (cp ? 6 : 0));
    const h = Math.max(14, packed.h + 6);
    const island: Island = {
      id: node, node, rect: { x: 0, y: 0, w, h }, ready: readyCond?.status === "True", cordoned: !!n.spec?.unschedulable, controlPlane: cp,
      plots, bridges: [], tents: [], cpu: parseCpu(n.status?.allocatable?.cpu), memory: parseMem(n.status?.allocatable?.memory),
    };
    for (const pk of packed.placed) { pk.item.rect = { x: pk.x + 2, y: pk.y + 2, w: pk.w, h: pk.h }; }
    islands.push(island);
    perIslandPlots.set(node, plots);
    perIslandTents.set(node, []);
  }

  // place islands on a spiral
  const cellSize = Math.max(...islands.map((i) => Math.max(i.rect.w, i.rect.h)), 14) + 8;
  const sp = spiral(islands.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  islands.forEach((isl, i) => {
    const c = sp[i]!;
    isl.rect.x = c.x * cellSize;
    isl.rect.y = c.y * cellSize;
  });
  for (const isl of islands) { minX = Math.min(minX, isl.rect.x); minY = Math.min(minY, isl.rect.y); }
  // normalise so the world starts at (4,4) tiles (leave sea margin)
  for (const isl of islands) { isl.rect.x += -minX + 4; isl.rect.y += -minY + 4; maxX = Math.max(maxX, isl.rect.x + isl.rect.w); maxY = Math.max(maxY, isl.rect.y + isl.rect.h); }
  if (!islands.length) { minX = 0; minY = 0; maxX = 40; maxY = 24; }

  // now materialise plots (absolute coords), buildings, actors, props, signposts, bridges
  let podCount = 0, buildingCount = 0;
  const namespaces = new Set<string>();
  for (const isl of islands) {
    for (const plot of isl.plots) {
      namespaces.add(plot.namespace);
      const tmp = plot as unknown as { _packed: ReturnType<typeof shelfPack<Spec>>; _specs: { specs: Spec[]; remote: K[] }; _services: K[]; _cms: string[]; _secrets: string[]; _tents: TentSpec[] };
      const px = isl.rect.x + plot.rect.x, py = isl.rect.y + plot.rect.y;
      plot.rect = { x: px, y: py, w: plot.rect.w, h: plot.rect.h };
      // walkable interior (px): inside the fence, below the sign/storehouse row, above the south path
      const walk: Rect = { x: (px + 1.5) * TILE, y: (py + 3.5) * TILE, w: (plot.rect.w - 3) * TILE, h: (plot.rect.h - 6) * TILE };
      const gate = { x: (px + Math.floor(plot.rect.w / 2)) * TILE, y: (py + plot.rect.h + 0.5) * TILE };
      const exit = { x: (isl.rect.x + isl.rect.w + 1) * TILE, y: 0 };
      for (const pk of tmp._packed.placed) {
        const cellX = px + 1 + pk.x, cellY = py + 3 + pk.y; // 3 = room for the namespace sign
        if (pk.item === null) {
          // remote strip or tent
          const keyIsTent = tmp._tents.find((t) => pk.w === 6 && pk.h === 9 && `tent/${t.ds.metadata.name}` === (pk as unknown as { key?: string }).key);
          void keyIsTent;
          continue;
        }
        const s = pk.item;
        const f = footprintOf(s.sprite);
        const groundX = (cellX + f.w / 2) * TILE;
        const groundY = (cellY + f.h) * TILE;
        const b: Building = {
          id: s.id, kind: s.kind, apiKind: s.apiKind, gvr: s.gvr, name: s.name, namespace: s.namespace, sprite: s.sprite, spriteName: s.spriteName, tier: s.tier,
          cell: { x: cellX, y: cellY, w: f.w, h: f.h + f.yard }, x: groundX, y: groundY, ready: s.ready, desired: s.desired,
          health: healthOf(s), actors: [], props: [], note: s.note,
        };
        // props to the right of the house
        s.propKinds.forEach((k, i) => b.props.push({ id: `${b.id}/prop/${i}`, kind: k, x: (cellX + f.w + 0.5 + (i % 2)) * TILE, y: (cellY + f.h - 1 - Math.floor(i / 2) * 1.5) * TILE }));
        // actors in slots
        const sorted = [...s.pods].sort((a, b2) => (a.metadata.name < b2.metadata.name ? -1 : 1));
        const avoid: Rect = { x: cellX * TILE, y: cellY * TILE, w: f.w * TILE, h: f.h * TILE };
        sorted.forEach((p, i) => {
          const slot = ACTOR_SLOTS[(fnv1a(p.metadata.uid ?? p.metadata.name) + i) % ACTOR_SLOTS.length]!;
          const used = b.actors.some((a) => Math.abs(a.x - (groundX + slot[0] * TILE)) < 4 && Math.abs(a.y - (groundY + slot[1] * TILE)) < 4);
          const alt = used ? ACTOR_SLOTS[(i * 7) % ACTOR_SLOTS.length]! : slot;
          const a = makeActor(p, s, alt, groundX, groundY, isSystem(s.namespace));
          a.bounds = walk; a.avoid = avoid; a.spawn = gate; a.exit = { x: exit.x, y: a.y };
          b.actors.push(a);
        });
        podCount += b.actors.length;
        buildingCount++;
        plot.buildings.push(b);
      }
      // remote pods strip: bottom-left of plot
      tmp._specs.remote.forEach((p, i) => {
        const o = ownerOf(p);
        const sheet = sheetFor(o?.kind ?? null, p.metadata.namespace!, p.metadata.name, isSystem(p.metadata.namespace!), false);
        const ax = (px + 2 + (i % 6) * 2) * TILE, ay = (py + plot.rect.h - 4 - Math.floor(i / 6) * 2) * TILE;
        plot.remote.push({
          id: `pod/${p.metadata.namespace}/${p.metadata.name}`, uid: p.metadata.uid ?? `pod/${p.metadata.namespace}/${p.metadata.name}`, name: p.metadata.name, namespace: p.metadata.namespace!, node: p.spec?.nodeName ?? null,
          sheet, role: roleOfSheet(sheet), state: actorState(p).state, restarts: restartsOf(p),
          x: ax, y: ay, buildingId: null, statusText: actorState(p).text, spawn: gate, exit: { x: exit.x, y: ay }, initProgress: initProgressOf(p), lastReason: lastReasonOf(p),
        });
        podCount++;
      });
      // DaemonSet tents in this plot (packed cells with item null and h 9)
      tmp._packed.placed.filter((pk) => pk.item === null && pk.h === 9).forEach((pk, i) => {
        const t = tmp._tents[i];
        if (!t) return;
        const cellX = px + 1 + pk.x, cellY = py + 3 + pk.y;
        const gx = (cellX + 2.5) * TILE, gy = (cellY + 6) * TILE;
        const ready = t.pods.filter((p) => actorState(p).state === "idle").length;
        const b: Building = {
          id: `DaemonSet/${t.ds.metadata.namespace}/${t.ds.metadata.name}@${isl.node}`, kind: "DaemonSet", apiKind: "DaemonSet", gvr: { group: "apps", version: "v1", resource: "daemonsets" },
          name: t.ds.metadata.name, namespace: t.ds.metadata.namespace!, sprite: "military_tents", spriteName: pick(["beige", "blue", "green", "red"] as const, t.ds.metadata.namespace!), tier: 1,
          cell: { x: cellX, y: cellY, w: 5, h: 8 }, x: gx, y: gy, ready, desired: Math.max(1, t.pods.length), health: t.pods.length === 0 ? "off" : ready === t.pods.length ? "ok" : ready > 0 ? "warn" : "bad", actors: [], props: [],
        };
        t.pods.forEach((p, j) => {
          const a = makeActor(p, { kind: "DaemonSet", namespace: b.namespace } as Spec, ACTOR_SLOTS[j % ACTOR_SLOTS.length]!, gx, gy, isSystem(b.namespace));
          a.spawn = gate; a.exit = { x: exit.x, y: a.y };
          b.actors.push(a);
        });
        podCount += b.actors.length;
        buildingCount++;
        plot.buildings.push(b);
        isl.tents.push(b);
      });
      // signposts along the south edge
      tmp._services.sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1)).forEach((svc, i) => {
        const cat = catalogByNs.get(plot.namespace)?.find((c) => c.name === svc.metadata.name);
        plot.signposts.push({
          id: `Service/${plot.namespace}/${svc.metadata.name}`, service: svc.metadata.name, namespace: plot.namespace,
          x: (px + 2 + i * 4) * TILE, y: (py + plot.rect.h - 1) * TILE, ready: cat ? cat.health === 1 : true, exposed: !!cat?.exposures.length, type: svc.spec?.type ?? "ClusterIP",
        });
      });
      // storehouse row: named, clickable chests right of the namespace sign (ConfigMaps first, then Secrets)
      let pi = 0;
      const chestRowY = (py + 2.75) * TILE;
      const placeChests = (names: string[], kind: "chest" | "golden_chest", apiKind: "ConfigMap" | "Secret") => {
        const shown = names.slice(0, MAX_CHESTS);
        shown.forEach((name, i) => {
          const last = i === shown.length - 1;
          const more = last ? names.length - shown.length : 0;
          plot.props.push({ id: `${apiKind}/${plot.namespace}/${name}`, kind, x: (px + 5 + pi++ * 1.5) * TILE, y: chestRowY, apiKind, name, namespace: plot.namespace, more: more || undefined });
        });
      };
      placeChests(tmp._cms, "chest", "ConfigMap");
      placeChests(tmp._secrets, "golden_chest", "Secret");
      // bridges: exposed services of this namespace on the island's east edge
      const exposed = (catalogByNs.get(plot.namespace) ?? []).filter((c) => c.exposures.length && tmp._services.some((s) => s.metadata.name === c.name));
      for (const c of exposed) {
        const e = c.exposures.find((x) => x.url) ?? c.exposures[0]!;
        isl.bridges.push({ id: `bridge/${c.namespace}/${c.name}`, service: c.name, namespace: c.namespace, url: e.url, host: e.host || e.url, tls: e.tls, x: 0, y: 0 });
      }
      // strip temp fields
      delete (plot as unknown as Record<string, unknown>)._packed;
      delete (plot as unknown as Record<string, unknown>)._specs;
      delete (plot as unknown as Record<string, unknown>)._services;
      delete (plot as unknown as Record<string, unknown>)._cms;
      delete (plot as unknown as Record<string, unknown>)._secrets;
      delete (plot as unknown as Record<string, unknown>)._tents;
    }
    // position bridges along the east edge, spaced 4 tiles, dedupe by service
    const seen = new Set<string>();
    isl.bridges = isl.bridges.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
    isl.bridges.forEach((b, i) => { b.x = (isl.rect.x + isl.rect.w) * TILE; b.y = (isl.rect.y + (isl.controlPlane ? 11 : 4) + i * 5) * TILE; });
  }

  // shore: pending pods lined up below the world
  const shoreActors: Actor[] = shore.sort((a, b) => (`${a.metadata.namespace}/${a.metadata.name}` < `${b.metadata.namespace}/${b.metadata.name}` ? -1 : 1)).map((p, i) => {
    const o = ownerOf(p);
    const st = actorState(p);
    const sheet = sheetFor(o?.kind ?? null, p.metadata.namespace!, p.metadata.name, isSystem(p.metadata.namespace!), false);
    return { id: `pod/${p.metadata.namespace}/${p.metadata.name}`, uid: p.metadata.uid ?? `pod/${p.metadata.namespace}/${p.metadata.name}`, name: p.metadata.name, namespace: p.metadata.namespace!, node: null, sheet, role: roleOfSheet(sheet), state: st.state, restarts: restartsOf(p), x: (6 + i * 2.5) * TILE, y: (maxY + 4) * TILE, buildingId: null, statusText: st.text };
  });
  podCount += shoreActors.length;
  const boundsH = maxY + (shoreActors.length ? 8 : 4);
  return { islands, shore: shoreActors, bounds: { x: 0, y: 0, w: maxX + 8, h: boundsH }, counts: { pods: podCount, buildings: buildingCount, namespaces: namespaces.size } };
}

/** Villager sheets without a `work` row: while a pod is being created, a builder (lumberjack) stands in for them. */
const NO_WORK_ANIM = new Set(["npc_chef_chloe", "npc_bartender_katy"]);

function makeActor(p: K, s: Pick<Spec, "kind" | "namespace"> & Partial<Spec>, slot: [number, number], gx: number, gy: number, system: boolean): Actor {
  const st = actorState(p);
  const isStatic = !!p.metadata.annotations?.["kubernetes.io/config.mirror"] || (p.metadata.ownerReferences?.[0]?.kind === "Node");
  let sheet = sheetFor(s.kind === "Custom" ? null : s.kind, s.namespace, p.metadata.name, system, isStatic);
  if (st.state === "creating" && NO_WORK_ANIM.has(sheet)) sheet = "npc_lumberjack_jack";
  return {
    id: `pod/${p.metadata.namespace}/${p.metadata.name}`, uid: p.metadata.uid ?? `pod/${p.metadata.namespace}/${p.metadata.name}`, name: p.metadata.name, namespace: p.metadata.namespace!, node: p.spec?.nodeName ?? null,
    sheet, role: roleOfSheet(sheet), state: st.state, restarts: restartsOf(p),
    x: Math.round(gx + slot[0] * TILE), y: Math.round(gy + slot[1] * TILE), buildingId: s.id ?? null, statusText: st.text,
    initProgress: initProgressOf(p), lastReason: lastReasonOf(p),
  };
}

function healthOf(s: { ready: number; desired: number; kind: BuildingKind; note?: string }): Health {
  if (s.kind === "Job") return s.note === "failed" ? "bad" : s.note === "done" ? "off" : "ok";
  if (s.kind === "CronJob") return s.desired === 0 ? "off" : "ok";
  if (s.desired === 0) return "off";
  if (s.ready >= s.desired) return "ok";
  if (s.ready > 0) return "warn";
  return "bad";
}

export function parseCpu(v?: string): number {
  if (!v) return 0;
  if (v.endsWith("m")) return parseInt(v, 10);
  return Math.round(parseFloat(v) * 1000);
}
export function parseMem(v?: string): number {
  if (!v) return 0;
  const m = v.match(/^(\d+(?:\.\d+)?)([KMGTPE]i?)?$/);
  if (!m) return parseFloat(v) || 0;
  const n = parseFloat(m[1]!);
  const unit = m[2] ?? "";
  const mult: Record<string, number> = { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return n * (mult[unit] ?? 1);
}
