import { Puzzle } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useWatch } from "@/hooks/use-watch";
import { columnsFor } from "@/features/explorer/components/resource-columns";
import { PageHeader } from "@/components/page-header";
import { ErrorCallout } from "@/components/status";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import type { KObj } from "@/lib/k8s";
import { useUI } from "@/stores/ui";

/** The slice of a CRD's spec.versions[] entry needed to route to its resource list. */
interface CrdVersion {
  name: string;
  storage?: boolean;
}

export const CRDsPage = () => {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const nav = useNavigate();
  const search = useUI((s) => s.search);
  const { items, synced, error } = useWatch(clusterId, { group: "apiextensions.k8s.io", version: "v1", resource: "customresourcedefinitions" }, "", { columnsOnly: true });
  const rows = useMemo(() => (search ? items.filter((o) => (o.metadata?.name ?? "").toLowerCase().includes(search.toLowerCase())) : items), [items, search]);
  const openCRD = (o: KObj) => {
    const group = o.spec?.group as string;
    const versions: CrdVersion[] = o.spec?.versions ?? [];
    const v = versions.find((x) => x.storage) ?? versions[0];
    const resource = o.spec?.names?.plural as string;
    if (!group || !v || !resource) return;
    void nav({ to: "/c/$clusterId/r/$group/$version/$resource", params: { clusterId, group, version: v.name, resource } });
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <PageHeader
        title="Custom resource definitions"
        meta={<Badge variant="secondary">{rows.length}</Badge>}
        description="Resource types added to this cluster. Open one to list its objects."
      />
      <ErrorCallout title="Can't reach the cluster" message={error} />
      <DataTable rows={rows} columns={columnsFor("customresourcedefinitions", false)} rowKey={(o) => o.metadata?.uid ?? o.metadata?.name ?? ""} onRowClick={openCRD} rowLabel={(o) => o.metadata?.name ?? ""} loading={!synced && !error} emptyIcon={<Puzzle />} emptyTitle={error ? "Cluster not reachable" : "No custom resource definitions"} emptyHint={error ? "Nothing to show until the agent reconnects." : undefined} />
    </div>
  );
};
