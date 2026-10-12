import { useQuery } from "@tanstack/react-query";
import { cluster } from "@/services/api-client";

export const useHelmRelease = (clusterId: string, namespace: string, name: string, revision = 0, enabled = true) => {
  return useQuery({
    queryKey: ["helmRelease", clusterId, namespace, name, revision],
    queryFn: async () => cluster.getHelmRelease({ clusterId, helm: { namespace, name, revision } }),
    enabled: enabled && !!clusterId && !!name,
    staleTime: 30_000,
  });
};
