import { useMemo } from "react";
import { Inbox, SearchX, Unplug } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useWatch } from "@/hooks/use-watch";
import { useMetricsPoll } from "@/features/explorer/hooks/use-metrics-poll";
import { columnsFor } from "@/features/explorer/components/resource-columns";
import { labelForResource } from "@/features/explorer/lib/nav";
import { PageHeader } from "@/components/page-header";
import { DeniedState, ErrorCallout, LiveStatus } from "@/components/status";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isNamespaced, type GVRKey, type KObj } from "@/lib/k8s";
import { useDrawer } from "@/stores/drawer";
import { useUI } from "@/stores/ui";

export const ResourceListPage = () => {
  const p = useParams({ from: "/c/$clusterId/r/$group/$version/$resource" });
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
      <PageHeader
        title={labelForResource(gvr.resource)}
        meta={
          <>
            <Badge variant="secondary">{rows.length}</Badge>
            {!denial && <LiveStatus synced={synced} stale={stale} syncedAt={syncedAt} error={error} />}
          </>
        }
        description={
          <>
            {namespaced ? (namespace ? `In namespace ${namespace}` : "Across all namespaces") : "Cluster-scoped"} · <span className="font-mono">{gvr.group ? `${gvr.group}/${gvr.version}` : gvr.version}</span>
            {metricsKind && metricsUnavailable && (
              <>
                {" · "}
                <Tooltip>
                  <TooltipTrigger>
                    <span className="underline decoration-dotted underline-offset-4">CPU and memory unavailable</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{metricsUnavailable}</TooltipContent>
                </Tooltip>
              </>
            )}
          </>
        }
      />
      {/* With no rows the empty state explains the outage; the alert is for errors over stale rows. */}
      {!denial && rows.length > 0 && <ErrorCallout title="Can't reach the cluster" message={error} />}
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
            emptyHint={error && !synced ? error : search ? "Try a different filter, or clear it." : undefined}
          />
        )}
      </div>
    </div>
  );
};
