import { useMemo } from "react";
import type { ClusterGrant } from "@/gen/kmate/v1/hub_pb";
import { useWatch } from "@/hooks/use-watch";
import { useGrants } from "@/hooks/use-grants";

/**
 * Namespaces the user may select on a cluster.
 *
 * A namespace-limited user cannot list the cluster-scoped `namespaces` resource,
 * so falling back to their own grant keeps the picker useful instead of empty.
 * `restricted` means "all namespaces" is not an option for this user.
 */
export const useAllowedNamespaces = (clusterId: string) => {
  const watch = useWatch(clusterId, { group: "", version: "v1", resource: "namespaces" }, "", { columnsOnly: true });
  const grants = useGrants("", !!clusterId);
  const granted = useMemo(() => {
    const g = (grants.data ?? []).find((x: ClusterGrant) => x.clusterId === clusterId);

    return g?.namespaces ?? [];
  }, [grants.data, clusterId]);

  const watched = useMemo(
    () => watch.items.map((n) => n.metadata?.name ?? "").filter(Boolean).sort(),
    [watch.items],
  );

  const restricted = granted.length > 0;
  const namespaces = useMemo(() => {
    if (restricted) {
      // Prefer the live list intersected with the grant, so names stay accurate.
      const live = new Set(watched);
      const inter = granted.filter((n) => live.has(n));

      return (inter.length ? inter : [...granted]).sort();
    }

    return watched;
  }, [restricted, granted, watched]);

  return { namespaces, restricted, denial: watch.denial };
};
