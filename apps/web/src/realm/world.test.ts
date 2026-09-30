import { describe, expect, it } from "vitest";
import { buildWorld, fnv1a, spiral, tierFor, type WorldInput } from "./world";

const node = (name: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name, uid: `n-${name}`, labels: {} },
  status: { conditions: [{ type: "Ready", status: "True" }], allocatable: { cpu: "4", memory: "8Gi" } },
  spec: {},
  ...extra,
});
const dep = (ns: string, name: string, replicas: number, ready: number) => ({
  metadata: { name, namespace: ns, uid: `d-${ns}-${name}` },
  spec: { replicas },
  status: { readyReplicas: ready },
});
const pod = (ns: string, name: string, rs: string, nodeName: string | null, ready = true, phase = "Running") => ({
  metadata: { name, namespace: ns, uid: `p-${ns}-${name}`, ownerReferences: [{ kind: "ReplicaSet", name: rs }] },
  spec: nodeName ? { nodeName, containers: [{ name: "c" }] } : { containers: [{ name: "c" }] },
  status: { phase, containerStatuses: nodeName ? [{ name: "c", ready, restartCount: 0, state: { running: {} } }] : [] },
});
const base = (over: Partial<WorldInput> = {}): WorldInput => ({
  nodes: [node("a")], pods: [], deployments: [], statefulsets: [], daemonsets: [], jobs: [], cronjobs: [], services: [], pvcs: [], configmaps: [], secrets: [], catalog: [], showSystem: false, ...over,
});

describe("hash + helpers", () => {
  it("fnv1a is stable", () => {
    expect(fnv1a("shop")).toBe(fnv1a("shop"));
    expect(fnv1a("shop")).not.toBe(fnv1a("shop2"));
  });
  it("tiers follow the doc", () => {
    expect([0, 1, 2, 3, 4, 6, 7, 12, 13].map(tierFor)).toEqual([1, 1, 2, 2, 3, 3, 5, 5, 6]);
  });
  it("spiral starts at origin and has unique cells", () => {
    const s = spiral(25);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(new Set(s.map((c) => `${c.x},${c.y}`)).size).toBe(25);
  });
});

describe("buildWorld", () => {
  const input = base({
    deployments: [dep("shop", "api", 3, 3), dep("shop", "web", 2, 1), dep("shop", "worker", 1, 0)],
    pods: [pod("shop", "api-abc12-x1", "api-abc12", "a"), pod("shop", "api-abc12-x2", "api-abc12", "a"), pod("shop", "api-abc12-x3", "api-abc12", "a"),
      pod("shop", "web-def34-y1", "web-def34", "a"), pod("shop", "web-def34-y2", "web-def34", "a", false),
      pod("shop", "worker-ghi56-z1", "worker-ghi56", null, false, "Pending"),
      pod("kube-system", "coredns-1", "coredns-1", "a")],
    services: [{ metadata: { name: "api", namespace: "shop" }, spec: { type: "ClusterIP" } }],
    catalog: [{ namespace: "shop", name: "api", health: 1, exposures: [{ kind: "Ingress", url: "https://api.example.com/", host: "api.example.com", tls: true }] }],
  });

  it("is deterministic", () => {
    const a = JSON.stringify(buildWorld(input));
    const b = JSON.stringify(buildWorld(input));
    expect(a).toBe(b);
  });

  it("places one island with a shop plot, tiered houses and health", () => {
    const w = buildWorld(input);
    expect(w.islands).toHaveLength(1);
    const isl = w.islands[0]!;
    expect(isl.rect.w).toBeGreaterThanOrEqual(14);
    expect(isl.rect.h).toBeGreaterThanOrEqual(14);
    const plot = isl.plots.find((p) => p.namespace === "shop")!;
    expect(plot).toBeTruthy();
    expect(isl.plots.some((p) => p.namespace === "kube-system")).toBe(false); // hidden by default
    const byName = Object.fromEntries(plot.buildings.map((b) => [b.name, b]));
    expect(byName.api!.tier).toBe(2);
    expect(byName.api!.sprite).toMatch(/^house_wood_2_/);
    expect(byName.api!.health).toBe("ok");
    expect(byName.web!.health).toBe("warn");
    expect(byName.worker!.health).toBe("bad");
    expect(byName.api!.actors).toHaveLength(3);
    // all buildings inside the plot, all plots inside the island
    for (const b of plot.buildings) {
      expect(b.cell.x).toBeGreaterThanOrEqual(plot.rect.x);
      expect(b.cell.x + b.cell.w).toBeLessThanOrEqual(plot.rect.x + plot.rect.w);
      expect(b.cell.y + b.cell.h).toBeLessThanOrEqual(plot.rect.y + plot.rect.h);
    }
    for (const p of isl.plots) {
      expect(p.rect.x).toBeGreaterThanOrEqual(isl.rect.x);
      expect(p.rect.x + p.rect.w).toBeLessThanOrEqual(isl.rect.x + isl.rect.w);
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(isl.rect.y + isl.rect.h);
    }
  });

  it("puts pending pods on the shore and exposed services on bridges", () => {
    const w = buildWorld(input);
    expect(w.shore.map((a) => a.name)).toEqual(["worker-ghi56-z1"]);
    expect(w.shore[0]!.state).toBe("pending");
    const isl = w.islands[0]!;
    expect(isl.bridges).toHaveLength(1);
    expect(isl.bridges[0]!.tls).toBe(true);
    expect(isl.plots[0]!.signposts).toHaveLength(1);
    expect(isl.plots[0]!.signposts[0]!.exposed).toBe(true);
  });

  it("shows system namespaces as system plots when enabled", () => {
    const w = buildWorld({ ...input, showSystem: true });
    const ks = w.islands[0]!.plots.find((p) => p.namespace === "kube-system")!;
    expect(ks.system).toBe(true);
  });

  it("uses a spiral for many nodes and does not overlap islands", () => {
    const nodes = Array.from({ length: 7 }, (_, i) => node(`n${i}`));
    const w = buildWorld(base({ nodes }));
    expect(w.islands).toHaveLength(7);
    for (let i = 0; i < 7; i++)
      for (let j = i + 1; j < 7; j++) {
        const a = w.islands[i]!.rect, b = w.islands[j]!.rect;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
  });
});
