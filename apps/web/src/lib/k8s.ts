/** Helpers for working with raw Kubernetes objects (parsed JSON). */

export type KObj = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string }[];
    deletionTimestamp?: string;
    managedFields?: unknown[];
  };
  spec?: any;
  status?: any;
  data?: any;
  [k: string]: any;
};

export interface GVRKey {
  group: string;
  version: string;
  resource: string;
}

export function gvrKey(g: GVRKey): string {
  return `${g.group || "core"}/${g.version}/${g.resource}`;
}

export function gvrFromApiVersion(apiVersion: string, resource: string): GVRKey {
  const [a, b] = apiVersion.split("/");
  return b ? { group: a, version: b, resource } : { group: "", version: a, resource };
}

export function decodeObject(json: Uint8Array): KObj {
  return JSON.parse(new TextDecoder().decode(json)) as KObj;
}

export function age(ts?: string): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 365) return `${d}d`;
  return `${Math.floor(d / 365)}y`;
}

export function relTime(date?: Date | string | null): string {
  if (!date) return "never";
  const d = typeof date === "string" ? new Date(date) : date;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Names of native sidecar containers: init containers with restartPolicy: Always. */
function sidecarNames(pod: KObj): Set<string> {
  const out = new Set<string>();
  for (const c of pod.spec?.initContainers ?? []) if (c?.restartPolicy === "Always") out.add(c.name);
  return out;
}

/** Pod status string similar to kubectl (incl. native sidecar handling). */
export function podStatus(pod: KObj): { text: string; tone: "ok" | "warn" | "bad" | "muted" } {
  const st = pod.status ?? {};
  if (pod.metadata?.deletionTimestamp) return { text: "Terminating", tone: "muted" };
  const cs: any[] = st.containerStatuses ?? [];
  const ics: any[] = st.initContainerStatuses ?? [];
  const sidecars = sidecarNames(pod);
  const initTotal = ics.length;
  for (let i = 0; i < ics.length; i++) {
    const c = ics[i];
    const isSidecar = sidecars.has(c.name);
    if (c.state?.terminated) {
      if (c.state.terminated.exitCode === 0) continue; // finished init step
      const r = c.state.terminated.reason || (c.state.terminated.signal ? `Signal:${c.state.terminated.signal}` : `ExitCode:${c.state.terminated.exitCode}`);
      return { text: `Init:${r}`, tone: "bad" };
    }
    if (isSidecar && c.started) continue; // sidecar is up: not "initializing"
    if (c.state?.waiting?.reason && c.state.waiting.reason !== "PodInitializing")
      return { text: `Init:${c.state.waiting.reason}`, tone: "bad" };
    return { text: `Init:${i}/${initTotal}`, tone: "warn" };
  }
  for (const c of cs) {
    if (c.state?.waiting?.reason) {
      const r = c.state.waiting.reason as string;
      return { text: r, tone: r === "ContainerCreating" ? "warn" : "bad" };
    }
    if (c.state?.terminated?.reason && st.phase !== "Succeeded")
      return { text: c.state.terminated.reason, tone: "bad" };
  }
  const phase = st.phase ?? "Unknown";
  if (phase === "Running") {
    const sidecarReady = ics.filter((c) => sidecars.has(c.name)).every((c) => c.ready);
    const allReady = cs.length > 0 && cs.every((c) => c.ready) && sidecarReady;
    return { text: "Running", tone: allReady ? "ok" : "warn" };
  }
  if (phase === "Succeeded") return { text: "Completed", tone: "muted" };
  if (phase === "Pending") return { text: st.reason ?? "Pending", tone: "warn" };
  if (phase === "Failed") return { text: st.reason ?? "Failed", tone: "bad" };
  return { text: phase, tone: "muted" };
}

/** "ready/total" like kubectl: regular containers plus native sidecars. */
export function podReady(pod: KObj): string {
  const cs: any[] = pod.status?.containerStatuses ?? [];
  const sidecars = sidecarNames(pod);
  const sc: any[] = (pod.status?.initContainerStatuses ?? []).filter((c: any) => sidecars.has(c.name));
  const total = (pod.spec?.containers?.length ?? cs.length) + sidecars.size;
  const ready = cs.filter((c) => c.ready).length + sc.filter((c) => c.ready).length;
  return `${ready}/${total}`;
}

export function podRestarts(pod: KObj): number {
  const sidecars = sidecarNames(pod);
  const sc: any[] = (pod.status?.initContainerStatuses ?? []).filter((c: any) => sidecars.has(c.name));
  return [...(pod.status?.containerStatuses ?? []), ...sc].reduce((a: number, c: any) => a + (c.restartCount ?? 0), 0);
}

export function nodeStatus(node: KObj): string {
  const conds: any[] = node.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === "Ready");
  let s = ready?.status === "True" ? "Ready" : "NotReady";
  if (node.spec?.unschedulable) s += ",SchedulingDisabled";
  return s;
}

export function nodeRoles(node: KObj): string {
  const labels = node.metadata?.labels ?? {};
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.replace("node-role.kubernetes.io/", ""));
  return roles.length ? roles.join(",") : "<none>";
}

export function servicePorts(svc: KObj): string {
  return (svc.spec?.ports ?? [])
    .map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`)
    .join(", ");
}

export function ingressHosts(ing: KObj): string {
  const hosts = (ing.spec?.rules ?? []).map((r: any) => r.host).filter(Boolean);
  return hosts.length ? hosts.join(", ") : "*";
}

export function ingressAddress(ing: KObj): string {
  return (ing.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(", ");
}

export function containersOf(pod: KObj): string[] {
  const c = (pod.spec?.containers ?? []).map((c: any) => c.name as string);
  const ic = (pod.spec?.initContainers ?? []).map((c: any) => c.name as string);
  return [...c, ...ic];
}

export function stripManaged(obj: KObj): KObj {
  if (obj.metadata?.managedFields) {
    const { managedFields: _mf, ...rest } = obj.metadata as any;
    return { ...obj, metadata: rest };
  }
  return obj;
}

export function isNamespaced(resource: string): boolean {
  return !CLUSTER_SCOPED.has(resource);
}
const CLUSTER_SCOPED = new Set([
  "nodes",
  "namespaces",
  "persistentvolumes",
  "storageclasses",
  "clusterroles",
  "clusterrolebindings",
  "customresourcedefinitions",
  "ingressclasses",
  "priorityclasses",
  "csidrivers",
  "csinodes",
  "volumeattachments",
  "runtimeclasses",
  "apiservices",
  "mutatingwebhookconfigurations",
  "validatingwebhookconfigurations",
]);
