import { useMemo } from "react";
import { Inbox, SearchX, Unplug } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useWatch } from "@/api/hooks";
import { useMetricsPoll } from "@/api/metrics";
import { columnsFor } from "@/cluster/columns";
import { labelForResource } from "@/cluster/nav";
import { DeniedState, ErrorCallout, LiveStatus } from "@/components/status";
import { DataTable } from "@/components/Table";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isNamespaced, type GVRKey, type KObj } from "@/lib/k8s";
import { useDrawer } from "@/store/drawer";
import { useUI } from "@/store/ui";

export function ResourceListPage() {
  const p = useParams({ strict: false }) as { clusterId: string; group: string; version: string; resource: string };
  const gvr: GVRKey = useMemo(() => ({ group: p.group === "core" ? "" : p.group, version: p.version, resource: p.resource }), [p.group, p.version, p.resource]);
  const namespaced = isNamespaced(gvr.resource);
  const namespace = useUI((s) => s.namespace);
  const search = useUI((s) => s.search);
  const open = useDrawer((s) => s.open);
  const { items, synced, stale, syncedAt, error, denial } = useWatch(p.clusterId, gvr, namespaced ? namespace : "", { columnsOnly: true });
  const metricsKind = gvr.resource === "pods" ? "pods" : gvr.resource === "nodes" ? "nodes" : null;
  const metricsUnavailable = useMetricsPoll(p.clusterId, metricsKind ?? "pods", metricsKind === "pods" ? namespace : "", metricsKind !== null);

  const rows = useMemo(() => {
    if (!search) return items;
    const t = search.toLowerCase();
    return items.filter((o) => {
      const hay = `${o.metadata?.name} ${o.metadata?.namespace ?? ""} ${o.spec?.nodeName ?? ""} ${o.reason ?? ""} ${o.message ?? ""} ${JSON.stringify(o.metadata?.labels ?? {})}`.toLowerCase();
      return hay.includes(t);
    });
  }, [items, search]);

  const columns = useMemo(() => columnsFor(gvr.resource, namespaced && !namespace, metricsKind && !metricsUnavailable ? p.clusterId : undefined), [gvr.resource, namespaced, namespace, metricsKind, metricsUnavailable, p.clusterId]);
  const rowKey = (o: KObj) => o.metadata?.uid ?? `${o.metadata?.namespace}/${o.metadata?.name}`;

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">{labelForResource(gvr.resource)}</h1>
        <Badge variant="secondary" className="rounded-md font-mono">
          {rows.length}
        </Badge>
        {gvr.group && (
          <span className="font-mono text-xs text-muted-foreground">
            {gvr.group}/{gvr.version}
          </span>
        )}
        {!denial && <LiveStatus className="ml-2" synced={synced} stale={stale} syncedAt={syncedAt} error={error} />}
        {metricsKind && metricsUnavailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto cursor-help text-[11px] text-muted-foreground">metrics-server not available</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{metricsUnavailable}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {!denial && <ErrorCallout message={error} />}
      <div>
        {denial ? (
          <DeniedState denial={denial} what={`list ${labelForResource(gvr.resource)}${namespaced && namespace ? ` in ${namespace}` : ""}`} />
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={rowKey}
            onRowClick={(o) => open({ gvr, namespace: o.metadata?.namespace ?? "", name: o.metadata?.name ?? "", kind: o.kind })}
            rowLabel={(o) => `${o.kind ?? labelForResource(gvr.resource)} ${o.metadata?.name ?? ""}`}
            loading={!synced && !stale && !error}
            emptyIcon={error && !synced ? <Unplug /> : search ? <SearchX /> : <Inbox />}
            emptyTitle={
              error && !synced
                ? "Cluster not reachable"
                : search
                  ? `No ${labelForResource(gvr.resource).toLowerCase()} match "${search}"`
                  : `No ${labelForResource(gvr.resource).toLowerCase()}${namespaced && namespace ? ` in ${namespace}` : ""}`
            }
            emptyHint={error && !synced ? "Nothing to show until the agent reconnects." : search ? "Try a different filter, or clear it." : undefined}
          />
        )}
      </div>
    </div>
  );
}
