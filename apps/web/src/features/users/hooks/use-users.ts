import { useQuery } from "@tanstack/react-query";
import { hub } from "@/services/api-client";

export const useUsers = (enabled = true) =>
  useQuery({
    queryKey: ["users"],
    queryFn: async () => (await hub.listUsers({})).users,
    enabled,
    retry: false,
  });
