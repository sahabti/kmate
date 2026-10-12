import { useQuery } from "@tanstack/react-query";
import { hub } from "@/services/api-client";
import { pollUnlessDenied } from "@/lib/poll-unless-denied";

export const useAuditEvents = (clusterId: string, limit = 200) =>
  useQuery({
    queryKey: ["audit", clusterId, limit],
    queryFn: async () => (await hub.listAuditEvents({ clusterId, limit })).events,
    enabled: !!clusterId,
    refetchInterval: pollUnlessDenied(15_000),
  });
