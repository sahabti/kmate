import { useEffect } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { cluster } from "./client";
import { metricKey, useMetricsStore } from "@/store/metrics";

const POLL_MS = 15_000;
/** Active pollers so several tables sharing (cluster, kind, ns) poll once. */
const pollers = new Map<string, { refs: number; stop: () => void }>();

async function fetchOnce(clusterId: string, kind: "pods" | "nodes", namespace: string) {
  const store = useMetricsStore.getState();
  if (store.unavailable[clusterId]) return;
  try {
    const res = await cluster.getMetrics({ clusterId, metrics: { kind, namespace } });
    const t = Date.now();
    const totals = new Map<string, { cpu: number; mem: number }>();
    const rows: Array<{ key: string; cpu: number; mem: number }> = [];
    for (const s of res.samples) {
      const cpu = Number(s.cpuMillicores);
      const mem = Number(s.memoryBytes);
      if (kind === "pods") {
        rows.push({ key: metricKey(clusterId, kind, s.namespace, s.name, s.container || "_"), cpu, mem });
        const tk = metricKey(clusterId, kind, s.namespace, s.name);
        const cur = totals.get(tk) ?? { cpu: 0, mem: 0 };
        totals.set(tk, { cpu: cur.cpu + cpu, mem: cur.mem + mem });
      } else {
        rows.push({ key: metricKey(clusterId, kind, "", s.name), cpu, mem });
      }
    }
    for (const [key, v] of totals) rows.push({ key, ...v });
    useMetricsStore.getState().push(rows, t);
  } catch (e) {
    if (e instanceof ConnectError && (e.code === Code.Unimplemented || e.code === Code.FailedPrecondition || e.code === Code.NotFound)) {
      useMetricsStore.getState().setUnavailable(clusterId, e.rawMessage || "metrics-server not available");
      return;
    }
    // transient (agent offline, timeout): keep polling silently
  }
}

/**
 * Polls metrics-server through the agent every 15 s while mounted.
 * Stops for a cluster once the agent reports metrics are unavailable.
 */
export function useMetricsPoll(clusterId: string, kind: "pods" | "nodes", namespace: string, enabled = true) {
  useEffect(() => {
    if (!enabled || !clusterId) return;
    const key = `${clusterId}|${kind}|${namespace}`;
    const existing = pollers.get(key);
    if (existing) {
      existing.refs++;
    } else {
      let timer: ReturnType<typeof setInterval> | null = null;
      void fetchOnce(clusterId, kind, namespace);
      timer = setInterval(() => void fetchOnce(clusterId, kind, namespace), POLL_MS);
      pollers.set(key, {
        refs: 1,
        stop: () => {
          if (timer) clearInterval(timer);
        },
      });
    }
    return () => {
      const p = pollers.get(key);
      if (!p) return;
      p.refs--;
      if (p.refs <= 0) {
        p.stop();
        pollers.delete(key);
      }
    };
  }, [clusterId, kind, namespace, enabled]);

  return useMetricsStore((s) => s.unavailable[clusterId] ?? null);
}
