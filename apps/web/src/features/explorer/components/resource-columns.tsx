import type { Column } from "@/components/data-table";
import { Sparkline } from "@/components/sparkline";
import { ToneBadge } from "@/components/tone";
import { age, ingressAddress, ingressHosts, nodeRoles, nodeStatus, podReady, podRestarts, podStatus, servicePorts, type KObj } from "@/lib/k8s";
import { formatBytes, formatCpu, metricKey, useMetricsStore } from "@/stores/metrics";

type MetricField = "cpu" | "mem";
type MetricsKind = "pods" | "nodes";

interface MetricCellProps {
  k: string;
  field: MetricField;
}

/** CPU / memory cell fed by the metrics store (sparkline of the last samples + current value). */
const MetricCell = ({ k, field }: MetricCellProps) => {
  const series = useMetricsStore((s) => s.series[k]);
  if (!series || series.length === 0) return <span className="text-muted-foreground/60">—</span>;
  const vals = series.map((s) => s[field]);
  const last = vals[vals.length - 1]!;

  return (
    <span className="inline-flex items-center gap-1.5">
      <Sparkline data={vals} variant="area" tone="info" curve label={`${field === "cpu" ? "CPU" : "Memory"} over the last ${vals.length} samples`} className="h-5 w-14" />
      <span className="font-mono">{field === "cpu" ? formatCpu(last) : formatBytes(last)}</span>
    </span>
  );
};

const metricColumns = (clusterId: string | undefined, kind: MetricsKind): Column<KObj>[] => {
  if (!clusterId) return [];
  const key = (o: KObj) => metricKey(clusterId, kind, kind === "pods" ? (o.metadata?.namespace ?? "") : "", o.metadata?.name ?? "");

  return [
    { id: "cpu", header: "CPU", cell: (o) => <MetricCell k={key(o)} field="cpu" />, width: "130px" },
    { id: "mem", header: "Memory", cell: (o) => <MetricCell k={key(o)} field="mem" />, width: "130px" },
  ];
};

const name: Column<KObj> = { id: "name", header: "Name", cell: (o) => <span className="font-medium">{o.metadata?.name}</span>, width: "minmax(220px,2fr)", value: (o) => o.metadata?.name };
/** Across all namespaces the namespace sits under the name, as in Hirael's pod table. */
const nameWithNamespace: Column<KObj> = {
  id: "name",
  header: "Name",
  width: "minmax(240px,2fr)",
  value: (o) => o.metadata?.name,
  title: (o) => `${o.metadata?.namespace}/${o.metadata?.name}`,
  cell: (o) => (
    <div className="flex min-w-0 flex-col">
      <span className="truncate font-medium">{o.metadata?.name}</span>
      <span className="truncate text-xs text-muted-foreground">{o.metadata?.namespace}</span>
    </div>
  ),
};
const ns: Column<KObj> = { id: "ns", header: "Namespace", cell: (o) => <span className="text-muted-foreground">{o.metadata?.namespace}</span>, width: "minmax(140px,1fr)", value: (o) => o.metadata?.namespace };
const absolute = (ts: string | undefined) => (ts ? new Date(ts).toLocaleString() : undefined);
const ageCol: Column<KObj> = {
  id: "age",
  header: "Age",
  cell: (o) => <span className="text-muted-foreground">{age(o.metadata?.creationTimestamp)}</span>,
  width: "80px",
  // Ascending age means youngest first.
  value: (o) => (o.metadata?.creationTimestamp ? -Date.parse(o.metadata.creationTimestamp) : undefined),
  title: (o) => absolute(o.metadata?.creationTimestamp),
};

const RESTART_WARN_AT = 3;

/** Counts that read as plain integers sort as numbers and use tabular figures. */
const COUNT_IDS = new Set(["restarts", "upd", "avail", "desired", "keys", "count", "cur"]);

/**
 * Fill in what most columns share: a sort key and hover text from a plain-text
 * cell, and tabular figures for counts and metrics.
 */
const finish = (cols: Column<KObj>[]): Column<KObj>[] =>
  cols.map((c) => {
    const quantity = COUNT_IDS.has(c.id) || c.id === "cpu" || c.id === "mem";
    let value = c.value;
    if (!value && !quantity) {
      value = (o) => {
        const v = c.cell(o);

        return typeof v === "string" ? v : undefined;
      };
    }
    if (!value && COUNT_IDS.has(c.id)) value = (o) => Number(c.cell(o));

    return { ...c, value, numeric: c.numeric ?? quantity };
  });

const baseColumns = (resource: string, namespaced: boolean, clusterId?: string): Column<KObj>[] => {
  const base = namespaced ? [nameWithNamespace] : [name];
  switch (resource) {
    case "pods":
      return [
        ...base,
        { id: "ready", header: "Ready", cell: podReady, width: "70px", mono: true },
        {
          id: "status",
          header: "Status",
          width: "160px",
          value: (o) => podStatus(o).text,
          cell: (o) => {
            const s = podStatus(o);

            return (
              <ToneBadge tone={s.tone} dot pulse={s.text === "Running" || s.text === "Pending" || s.text === "ContainerCreating"}>
                {s.text}
              </ToneBadge>
            );
          },
        },
        {
          id: "restarts",
          header: "Restarts",
          width: "100px",
          value: (o) => podRestarts(o),
          // Three or more restarts usually means a crash loop worth a look.
          cell: (o) => <span className={podRestarts(o) >= RESTART_WARN_AT ? "text-destructive" : undefined}>{podRestarts(o)}</span>,
        },
        ...metricColumns(clusterId, "pods"),
        { id: "node", header: "Node", cell: (o) => <span className="text-muted-foreground">{o.spec?.nodeName ?? ""}</span>, width: "minmax(140px,1fr)" },
        ageCol,
      ];
    case "deployments":
    case "statefulsets":
      return [
        ...base,
        { id: "ready", header: "Ready", cell: (o) => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}`, width: "80px", mono: true },
        { id: "upd", header: "Up-to-date", cell: (o) => String(o.status?.updatedReplicas ?? 0), width: "90px", mono: true },
        { id: "avail", header: "Available", cell: (o) => String(o.status?.availableReplicas ?? 0), width: "90px", mono: true },
        ageCol,
      ];
    case "daemonsets":
      return [
        ...base,
        { id: "desired", header: "Desired", cell: (o) => String(o.status?.desiredNumberScheduled ?? 0), width: "80px", mono: true },
        { id: "ready", header: "Ready", cell: (o) => String(o.status?.numberReady ?? 0), width: "80px", mono: true },
        ageCol,
      ];
    case "replicasets":
      return [
        ...base,
        { id: "desired", header: "Desired", cell: (o) => String(o.spec?.replicas ?? 0), width: "80px", mono: true },
        { id: "ready", header: "Ready", cell: (o) => String(o.status?.readyReplicas ?? 0), width: "80px", mono: true },
        ageCol,
      ];
    case "jobs":
      return [
        ...base,
        { id: "comp", header: "Completions", cell: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}`, width: "100px", mono: true },
        ageCol,
      ];
    case "cronjobs":
      return [
        ...base,
        { id: "sched", header: "Schedule", cell: (o) => o.spec?.schedule ?? "", width: "120px", mono: true },
        { id: "susp", header: "Suspend", cell: (o) => String(!!o.spec?.suspend), width: "80px" },
        { id: "last", header: "Last schedule", cell: (o) => age(o.status?.lastScheduleTime), width: "110px" },
        ageCol,
      ];
    case "services":
      return [
        ...base,
        { id: "type", header: "Type", cell: (o) => <ToneBadge tone="info">{o.spec?.type ?? "ClusterIP"}</ToneBadge>, width: "120px" },
        { id: "cip", header: "Cluster IP", cell: (o) => o.spec?.clusterIP ?? "", width: "130px", mono: true },
        { id: "ports", header: "Ports", cell: servicePorts, width: "minmax(160px,1fr)", mono: true },
        ageCol,
      ];
    case "ingresses":
      return [
        ...base,
        { id: "class", header: "Class", cell: (o) => o.spec?.ingressClassName ?? "", width: "100px" },
        { id: "hosts", header: "Hosts", cell: ingressHosts, width: "minmax(200px,1.5fr)", mono: true },
        { id: "addr", header: "Address", cell: ingressAddress, width: "140px", mono: true },
        ageCol,
      ];
    case "nodes":
      return [
        name,
        {
          id: "status",
          header: "Status",
          width: "180px",
          value: (o) => nodeStatus(o),
          cell: (o) => {
            const s = nodeStatus(o);

            return (
              <ToneBadge tone={s.startsWith("Ready") ? "ok" : "bad"} dot>
                {s}
              </ToneBadge>
            );
          },
        },
        { id: "roles", header: "Roles", cell: nodeRoles, width: "140px" },
        ...metricColumns(clusterId, "nodes"),
        { id: "ver", header: "Version", cell: (o) => o.status?.nodeInfo?.kubeletVersion ?? "", width: "120px", mono: true },
        ageCol,
      ];
    case "namespaces":
      return [name, { id: "phase", header: "Status", cell: (o) => <ToneBadge tone={o.status?.phase === "Active" ? "ok" : "warn"}>{o.status?.phase}</ToneBadge>, width: "100px" }, ageCol];
    case "events":
      return [
        { id: "type", header: "Type", cell: (o) => <ToneBadge tone={o.type === "Warning" ? "warn" : "muted"}>{o.type}</ToneBadge>, width: "90px" },
        { id: "reason", header: "Reason", cell: (o) => o.reason ?? "", width: "160px" },
        { id: "obj", header: "Object", cell: (o) => `${o.involvedObject?.kind ?? ""}/${o.involvedObject?.name ?? ""}`, width: "minmax(180px,1fr)", mono: true },
        ns,
        { id: "msg", header: "Message", cell: (o) => o.message ?? "", width: "minmax(300px,3fr)" },
        { id: "count", header: "Count", cell: (o) => String(o.count ?? 1), width: "60px", mono: true },
        {
          id: "last",
          header: "Last seen",
          cell: (o) => age(o.lastTimestamp ?? o.eventTime),
          width: "90px",
          value: (o) => -Date.parse(o.lastTimestamp ?? o.eventTime ?? "") || undefined,
          title: (o) => absolute(o.lastTimestamp ?? o.eventTime),
        },
      ];
    case "persistentvolumeclaims":
      return [
        ...base,
        { id: "status", header: "Status", cell: (o) => <ToneBadge tone={o.status?.phase === "Bound" ? "ok" : "warn"}>{o.status?.phase}</ToneBadge>, width: "90px" },
        { id: "vol", header: "Volume", cell: (o) => o.spec?.volumeName ?? "", width: "minmax(160px,1fr)", mono: true },
        { id: "cap", header: "Capacity", cell: (o) => o.status?.capacity?.storage ?? "", width: "90px", mono: true },
        { id: "sc", header: "StorageClass", cell: (o) => o.spec?.storageClassName ?? "", width: "120px" },
        ageCol,
      ];
    case "persistentvolumes":
      return [
        name,
        { id: "cap", header: "Capacity", cell: (o) => o.spec?.capacity?.storage ?? "", width: "90px", mono: true },
        { id: "status", header: "Status", cell: (o) => o.status?.phase ?? "", width: "90px" },
        { id: "claim", header: "Claim", cell: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : ""), width: "minmax(160px,1fr)", mono: true },
        { id: "sc", header: "StorageClass", cell: (o) => o.spec?.storageClassName ?? "", width: "120px" },
        ageCol,
      ];
    case "configmaps":
    case "secrets":
      return [
        ...base,
        ...(resource === "secrets" ? [{ id: "type", header: "Type", cell: (o: KObj) => o.type ?? "", width: "200px", mono: true } as Column<KObj>] : []),
        { id: "keys", header: "Keys", cell: (o) => String(Object.keys(o.data ?? {}).length), width: "60px", mono: true },
        ageCol,
      ];
    case "horizontalpodautoscalers":
      return [
        ...base,
        { id: "ref", header: "Target", cell: (o) => `${o.spec?.scaleTargetRef?.kind}/${o.spec?.scaleTargetRef?.name}`, width: "minmax(160px,1fr)", mono: true },
        { id: "minmax", header: "Min/Max", cell: (o) => `${o.spec?.minReplicas ?? 1}/${o.spec?.maxReplicas}`, width: "80px", mono: true },
        { id: "cur", header: "Replicas", cell: (o) => String(o.status?.currentReplicas ?? 0), width: "80px", mono: true },
        ageCol,
      ];
    case "customresourcedefinitions":
      return [
        name,
        { id: "group", header: "Group", cell: (o) => o.spec?.group ?? "", width: "minmax(180px,1fr)", mono: true },
        { id: "kind", header: "Kind", cell: (o) => o.spec?.names?.kind ?? "", width: "140px" },
        { id: "scope", header: "Scope", cell: (o) => o.spec?.scope ?? "", width: "100px" },
        ageCol,
      ];
    default:
      return [...base, ageCol];
  }
};

export const columnsFor = (resource: string, namespaced: boolean, clusterId?: string): Column<KObj>[] =>
  finish(baseColumns(resource, namespaced, clusterId));
