import { useQuery } from "@tanstack/react-query";
import { hub } from "@/services/api-client";

/** Grants for a user; an empty userId means your own. */
export const useGrants = (userId = "", enabled = true) => {
  return useQuery({
    queryKey: ["grants", userId],
    queryFn: async () => (await hub.listGrants({ userId })).grants,
    enabled,
    retry: false,
  });
};
