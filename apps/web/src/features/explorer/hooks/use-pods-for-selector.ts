import { useQuery } from "@tanstack/react-query";
import { cluster } from "@/services/api-client";
import { decodeObject } from "@/lib/k8s";

/** Pods selected by a Service (for port-forward target resolution). */
export const usePodsForSelector = (clusterId: string, namespace: string, selector: Record<string, string> | undefined, enabled = true) => {
  const labelSelector = Object.entries(selector ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");

  return useQuery({
    queryKey: ["podsForSelector", clusterId, namespace, labelSelector],
    queryFn: async () => {
      const res = await cluster.list({ clusterId, gvr: { group: "", version: "v1", resource: "pods" }, options: { namespace, labelSelector, columnsOnly: true } });

      return res.items.map((o) => decodeObject(o.json));
    },
    enabled: enabled && !!clusterId && !!labelSelector,
  });
};
