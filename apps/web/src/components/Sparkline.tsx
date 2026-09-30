import { cn } from "@/lib/utils";

/** Tiny inline SVG sparkline; no chart library. */
export function Sparkline({ values, width = 64, height = 16, className, stroke = "currentColor" }: { values: number[]; width?: number; height?: number; className?: string; stroke?: string }) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={cn("shrink-0 opacity-40", className)} aria-hidden />;
  }
  const max = Math.max(...values, 1e-9);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 1 - ((v - min) / span) * (height - 2)).toFixed(1)}`);
  const d = `M${pts.join(" L")}`;
  const last = pts[pts.length - 1]!.split(",");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("shrink-0", className)} aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={1.6} fill={stroke} />
    </svg>
  );
}
