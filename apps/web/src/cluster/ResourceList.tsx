import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { useWatch } from "@/api/hooks";
import { useMetricsPoll } from "@/api/metrics";
import { columnsFor } from "@/cluster/columns";
import { labelForResource } from "@/cluster/nav";
import { ErrorCallout, Loading } from "@/components/status";
import { VirtualTable } from "@/components/Table";
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
  const { items, synced, error } = useWatch(p.clusterId, gvr, namespaced ? namespace : "", { columnsOnly: true });
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
    <div className="flex h-full flex-col gap-3 p-3 md:p-5">
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
        {!synced && !error && <Loading className="ml-2" label="syncing" />}
        {metricsKind && metricsUnavailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto cursor-help text-[11px] text-muted-foreground">metrics-server not available</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{metricsUnavailable}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <ErrorCallout message={error} />
      <div className="min-h-0 flex-1">
        <VirtualTable
          rows={rows}
          columns={columns}
          rowKey={rowKey}
          onRowClick={(o) => open({ gvr, namespace: o.metadata?.namespace ?? "", name: o.metadata?.name ?? "", kind: o.kind })}
          emptyText={synced ? "No resources found" : "Loading…"}
        />
      </div>
    </div>
  );
}
