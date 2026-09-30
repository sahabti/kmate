import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/** Semantic tone used across status badges and dots. */
export type Tone = "ok" | "warn" | "bad" | "muted" | "info" | "slate";

const dotClass: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  muted: "bg-muted-foreground/60",
  info: "bg-info",
  slate: "bg-muted-foreground/40",
};

const badgeClass: Record<Tone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/30 bg-warning/10 text-warning",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
  info: "border-info/30 bg-info/10 text-info",
  slate: "border-border bg-transparent text-muted-foreground",
};

export function Dot({ tone, className, pulse }: { tone: Tone; className?: string; pulse?: boolean }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0 rounded-full", dotClass[tone], className)}>
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", dotClass[tone])} />}
    </span>
  );
}

export function ToneBadge({ tone = "muted", className, children, title, dot }: { tone?: Tone; className?: string; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <Badge variant="outline" title={title} className={cn("rounded-md px-1.5 font-medium", badgeClass[tone], className)}>
      {dot && <Dot tone={tone} className="size-1.5" />}
      {children}
    </Badge>
  );
}

/** Small key=value chips for labels/annotations/selectors. */
export function Chips({ map, empty = "none" }: { map?: Record<string, string>; empty?: string }) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return <span className="text-xs text-muted-foreground">{empty}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => {
        const shown = v.length > 120 ? `${v.slice(0, 120)}…` : v;
        return (
          <Badge key={k} variant="secondary" className="h-auto rounded-md px-1.5 py-0.5 font-mono text-[11px] font-normal break-all whitespace-normal" title={`${k}=${v}`}>
            {k}
            {v ? `=${shown}` : ""}
          </Badge>
        );
      })}
    </div>
  );
}
