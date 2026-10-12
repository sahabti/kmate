import { useQuery } from "@tanstack/react-query";
import { cluster } from "@/services/api-client";
import { decodeObject, gvrKey, type GVRKey } from "@/lib/k8s";
import { pollUnlessDenied } from "@/lib/poll-unless-denied";

/** Fetches the full object (with a small polling refresh). */
export const useObject = (clusterId: string, gvr: GVRKey | null, namespace: string, name: string) => {
  return useQuery({
    queryKey: ["object", clusterId, gvr ? gvrKey(gvr) : "", namespace, name],
    queryFn: async () => {
      const res = await cluster.get({ clusterId, ref: { gvr: gvr!, namespace, name } });

      return res.object ? decodeObject(res.object.json) : null;
    },
    enabled: !!clusterId && !!gvr && !!name,
    refetchInterval: pollUnlessDenied(15_000),
  });
};
