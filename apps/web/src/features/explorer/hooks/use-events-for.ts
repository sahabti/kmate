import { useQuery } from "@tanstack/react-query";
import { cluster } from "@/services/api-client";
import { decodeObject } from "@/lib/k8s";
import { pollUnlessDenied } from "@/lib/poll-unless-denied";

export const useEventsFor = (clusterId: string, namespace: string, name: string, enabled = true) => {
  return useQuery({
    queryKey: ["events", clusterId, namespace, name],
    queryFn: async () => {
      const res = await cluster.list({
        clusterId,
        gvr: { group: "", version: "v1", resource: "events" },
        options: {
          namespace,
          fieldSelector: namespace
            ? `involvedObject.name=${name},involvedObject.namespace=${namespace}`
            : `involvedObject.name=${name}`,
        },
      });

      return res.items
        .map((o) => decodeObject(o.json))
        .sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? "").localeCompare(String(a.lastTimestamp ?? a.eventTime ?? "")));
    },
    enabled: enabled && !!clusterId && !!name,
    refetchInterval: pollUnlessDenied(10_000),
  });
};

/* ---------------- access review ---------------- */
