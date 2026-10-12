import { useQuery } from "@tanstack/react-query";
import { hub } from "@/services/api-client";
import { pollUnlessDenied } from "@/lib/poll-unless-denied";

export const useCluster = (clusterId: string) => {
  return useQuery({
    queryKey: ["cluster", clusterId],
    queryFn: async () => (await hub.getCluster({ id: clusterId })).cluster ?? null,
    refetchInterval: pollUnlessDenied(10_000),
    enabled: !!clusterId,
  });
};
