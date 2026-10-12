import { useCluster } from "@/hooks/use-cluster";

/** Capabilities advertised by the cluster's agent ("read", "write", "exec", ...). */
export const useCapabilities = (clusterId: string) => {
  const q = useCluster(clusterId);
  const caps = q.data?.capabilities ?? [];
  const known = !!q.data;

  return {
    caps,
    known,
    canWrite: caps.includes("write"),
    canExec: caps.includes("exec"),
    online: q.data ? q.data.status === 2 /* ONLINE */ : false,
  };
};
