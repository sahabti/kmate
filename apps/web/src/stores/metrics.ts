import { create } from "zustand";

/** One metrics sample for a pod container or a node. */
export interface Sample {
  t: number; // epoch ms
  cpu: number; // millicores
  mem: number; // bytes
}

export const MAX_SAMPLES = 20;

/** One reading to append to the series named by `key` (see `metricKey`). */
export interface MetricReading {
  key: string;
  cpu: number;
  mem: number;
}

export type MetricKind = "pods" | "nodes";

/** key = `${clusterId}|${kind}|${namespace}/${name}` (pod totals / node) or `...|${container}` */
interface MetricsState {
  series: Record<string, Sample[]>;
  unavailable: Record<string, string>; // clusterId -> reason
  push(samples: MetricReading[], t: number): void;
  setUnavailable(clusterId: string, reason: string | null): void;
}

export const useMetricsStore = create<MetricsState>()((set, get) => ({
  series: {},
  unavailable: {},
  push(samples, t) {
    const series = { ...get().series };
    for (const s of samples) {
      const prev = series[s.key] ?? [];
      const next = [...prev, { t, cpu: s.cpu, mem: s.mem }];
      series[s.key] = next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
    }
    set({ series });
  },
  setUnavailable(clusterId, reason) {
    const unavailable = { ...get().unavailable };
    if (reason) unavailable[clusterId] = reason;
    else delete unavailable[clusterId];
    set({ unavailable });
  },
}));

export const metricKey = (clusterId: string, kind: MetricKind, namespace: string, name: string, container?: string): string => {
  return `${clusterId}|${kind}|${namespace}/${name}${container ? `|${container}` : ""}`;
};

export const formatCpu = (millicores: number): string => {
  if (millicores >= 1000) return `${(millicores / 1000).toFixed(millicores >= 10_000 ? 0 : 2)} cores`;

  return `${Math.round(millicores)}m`;
};

export const formatBytes = (bytes: number): string => {
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }

  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
};
