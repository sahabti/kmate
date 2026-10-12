import { useQuery } from "@tanstack/react-query";
import { cluster } from "@/services/api-client";
import { decodeObject } from "@/lib/k8s";
import { pollUnlessDenied } from "@/lib/poll-unless-denied";

/**
 * Pods scheduled on a node. The agent serves lists from its informer cache and
 * only honours metadata field selectors there, so filter on spec.nodeName here.
 */
export const usePodsOnNode = (clusterId: string, node: string, enabled = true) => {
  return useQuery({
    queryKey: ["podsOnNode", clusterId, node],
    queryFn: async () => {
      const res = await cluster.list({
        clusterId,
        gvr: { group: "", version: "v1", resource: "pods" },
        // Server-side field selector: the agent cache resolves spec.nodeName,
        // so large clusters don't ship every pod just to filter one node.
        options: { namespace: "", columnsOnly: true, fieldSelector: `spec.nodeName=${node}` },
      });

      return res.items.map((o) => decodeObject(o.json)).filter((p) => p.spec?.nodeName === node);
    },
    enabled: enabled && !!clusterId && !!node,
    refetchInterval: pollUnlessDenied(15_000),
  });
};
