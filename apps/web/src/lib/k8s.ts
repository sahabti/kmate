/** Helpers for working with raw Kubernetes objects (parsed JSON). */

export interface OwnerReference {
  kind: string;
  name: string;
}

export interface KMetadata {
  name?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: OwnerReference[];
  deletionTimestamp?: string;
  managedFields?: unknown[];
}

/*
 * One shape for every kind, so spec/status/data stay open: views read
 * kind-specific paths (spec.replicas, status.phase, data[key]) on whatever the
 * watch returns, and no per-kind schema is generated for the web client.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface KObj {
  apiVersion?: string;
  kind?: string;
  metadata?: KMetadata;
  spec?: any;
  status?: any;
  data?: any;
  [k: string]: any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface GVRKey {
  group: string;
  version: string;
  resource: string;
}

export const gvrKey = (g: GVRKey): string => `${g.group || "core"}/${g.version}/${g.resource}`;

export const gvrFromApiVersion = (apiVersion: string, resource: string): GVRKey => {
  const [a, b] = apiVersion.split("/");

  return b ? { group: a, version: b, resource } : { group: "", version: a, resource };
};

export const decodeObject = (json: Uint8Array): KObj => JSON.parse(new TextDecoder().decode(json)) as KObj;

export const age = (ts?: string): string => {
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
};

export const relTime = (date?: Date | string | null): string => {
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
};

/* The slices of pod, node, service and ingress JSON the helpers below read. */

interface ContainerSpec {
  name: string;
  restartPolicy?: string;
}

interface ContainerStateWaiting {
  reason?: string;
}

interface ContainerStateTerminated {
  exitCode?: number;
  reason?: string;
  signal?: number;
}

interface ContainerState {
  waiting?: ContainerStateWaiting;
  terminated?: ContainerStateTerminated;
}

interface ContainerStatus {
  name: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  state?: ContainerState;
}

interface PodStatusFields {
  phase?: string;
  reason?: string;
  containerStatuses?: ContainerStatus[];
  initContainerStatuses?: ContainerStatus[];
}

interface NodeCondition {
  type: string;
  status: string;
}

interface ServicePort {
  port: number;
  nodePort?: number;
  protocol?: string;
}

interface IngressRule {
  host?: string;
}

interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

export type PodTone = "ok" | "warn" | "bad" | "muted";

export interface PodStatusDisplay {
  text: string;
  tone: PodTone;
}

/** Names of native sidecar containers: init containers with restartPolicy: Always. */
const sidecarNames = (pod: KObj): Set<string> => {
  const out = new Set<string>();
  const inits: ContainerSpec[] = pod.spec?.initContainers ?? [];
  for (const c of inits) if (c?.restartPolicy === "Always") out.add(c.name);

  return out;
};

/** Pod status string similar to kubectl (incl. native sidecar handling). */
export const podStatus = (pod: KObj): PodStatusDisplay => {
  const st: PodStatusFields = pod.status ?? {};
  if (pod.metadata?.deletionTimestamp) return { text: "Terminating", tone: "muted" };
  const cs = st.containerStatuses ?? [];
  const ics = st.initContainerStatuses ?? [];
  const sidecars = sidecarNames(pod);
  const initTotal = ics.length;
  for (let i = 0; i < ics.length; i++) {
    const c = ics[i]!;
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
      const r = c.state.waiting.reason;

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
};

/** "ready/total" like kubectl: regular containers plus native sidecars. */
export const podReady = (pod: KObj): string => {
  const st: PodStatusFields = pod.status ?? {};
  const cs = st.containerStatuses ?? [];
  const sidecars = sidecarNames(pod);
  const sc = (st.initContainerStatuses ?? []).filter((c) => sidecars.has(c.name));
  const total = (pod.spec?.containers?.length ?? cs.length) + sidecars.size;
  const ready = cs.filter((c) => c.ready).length + sc.filter((c) => c.ready).length;

  return `${ready}/${total}`;
};

export const podRestarts = (pod: KObj): number => {
  const st: PodStatusFields = pod.status ?? {};
  const sidecars = sidecarNames(pod);
  const sc = (st.initContainerStatuses ?? []).filter((c) => sidecars.has(c.name));

  return [...(st.containerStatuses ?? []), ...sc].reduce((a, c) => a + (c.restartCount ?? 0), 0);
};

export const nodeStatus = (node: KObj): string => {
  const conds: NodeCondition[] = node.status?.conditions ?? [];
  const ready = conds.find((c) => c.type === "Ready");
  let s = ready?.status === "True" ? "Ready" : "NotReady";
  if (node.spec?.unschedulable) s += ",SchedulingDisabled";

  return s;
};

export const nodeRoles = (node: KObj): string => {
  const labels = node.metadata?.labels ?? {};
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith("node-role.kubernetes.io/"))
    .map((k) => k.replace("node-role.kubernetes.io/", ""));

  return roles.length ? roles.join(",") : "<none>";
};

export const servicePorts = (svc: KObj): string => {
  const ports: ServicePort[] = svc.spec?.ports ?? [];

  return ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(", ");
};

export const ingressHosts = (ing: KObj): string => {
  const rules: IngressRule[] = ing.spec?.rules ?? [];
  const hosts = rules.map((r) => r.host).filter(Boolean);

  return hosts.length ? hosts.join(", ") : "*";
};

export const ingressAddress = (ing: KObj): string => {
  const ingress: LoadBalancerIngress[] = ing.status?.loadBalancer?.ingress ?? [];

  return ingress.map((i) => i.ip ?? i.hostname).join(", ");
};

export const containersOf = (pod: KObj): string[] => {
  const containers: ContainerSpec[] = pod.spec?.containers ?? [];
  const inits: ContainerSpec[] = pod.spec?.initContainers ?? [];

  return [...containers, ...inits].map((c) => c.name);
};

export const stripManaged = (obj: KObj): KObj => {
  if (obj.metadata?.managedFields) {
    const { managedFields: _mf, ...rest } = obj.metadata;

    return { ...obj, metadata: rest };
  }

  return obj;
};

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

export const isNamespaced = (resource: string): boolean => !CLUSTER_SCOPED.has(resource);
