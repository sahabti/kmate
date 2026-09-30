import { useMemo } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useWatch } from "@/api/hooks";
import { columnsFor } from "@/cluster/columns";
import { ErrorCallout, Loading } from "@/components/status";
import { VirtualTable } from "@/components/Table";
import { Badge } from "@/components/ui/badge";
import type { KObj } from "@/lib/k8s";
import { useUI } from "@/store/ui";

export function CRDsPage() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const nav = useNavigate();
  const search = useUI((s) => s.search);
  const { items, synced, error } = useWatch(clusterId, { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions" }, "", { columnsOnly: true });
  const rows = useMemo(() => (search ? items.filter((o) => (o.metadata?.name ?? "").toLowerCase().includes(search.toLowerCase())) : items), [items, search]);
  const openCRD = (o: KObj) => {
    const group = o.spec?.group as string;
    const versions: any[] = o.spec?.versions ?? [];
    const v = versions.find((x) => x.storage) ?? versions[0];
    const resource = o.spec?.names?.plural as string;
    if (!group || !v || !resource) return;
    void nav({ to: "/c/$clusterId/r/$group/$version/$resource", params: { clusterId, group, version: v.name, resource } });
  };
  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-5">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">Custom Resource Definitions</h1>
        <Badge variant="secondary" className="rounded-md font-mono">
          {rows.length}
        </Badge>
        {!synced && !error && <Loading label="syncing" />}
      </div>
      <ErrorCallout message={error} />
      <div className="min-h-0 flex-1">
        <VirtualTable rows={rows} columns={columnsFor("customresourcedefinitions", false)} rowKey={(o) => o.metadata?.uid ?? o.metadata?.name ?? ""} onRowClick={openCRD} />
      </div>
    </div>
  );
}
