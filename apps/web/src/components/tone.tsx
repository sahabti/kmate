import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

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

/** Pill shape shared by status badges and chips; KMate's own, sized like shadcn's Badge. */
const PILL = "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap";

const badgeClass: Record<Tone, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/30 bg-warning/10 text-warning",
  bad: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
  info: "border-info/30 bg-info/10 text-info",
  slate: "border-border bg-transparent text-muted-foreground",
};

interface DotProps {
  tone: Tone;
  className?: string;
  pulse?: boolean;
}

export const Dot = ({ tone, className, pulse }: DotProps) => {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0 rounded-full", dotClass[tone], className)}>
      {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden", dotClass[tone])} />}
    </span>
  );
};

interface ToneBadgeProps {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
  dot?: boolean;
  /** Pulse the dot for a state that is still changing (Running, Pending). */
  pulse?: boolean;
}

export const ToneBadge = ({ tone = "muted", className, children, title, dot, pulse }: ToneBadgeProps) => {
  return (
    <span data-slot="tone-badge" data-tone={tone} title={title} className={cn(PILL, badgeClass[tone], className)}>
      {dot && <Dot tone={tone} pulse={pulse} className="size-1.5" />}
      {children}
    </span>
  );
};

interface ChipsProps {
  map?: Record<string, string>;
  empty?: string;
}

/** Small key=value chips for labels/annotations/selectors. */
export const Chips = ({ map, empty = "none" }: ChipsProps) => {
  const entries = Object.entries(map ?? {});
  if (!entries.length) return <span className="text-xs text-muted-foreground">{empty}</span>;

  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => {
        const shown = v.length > 120 ? `${v.slice(0, 120)}…` : v;

        return (
          <span key={k} data-slot="chip" title={`${k}=${v}`} className="inline-flex max-w-full rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs break-all text-secondary-foreground">
            {k}
            {v ? `=${shown}` : ""}
          </span>
        );
      })}
    </div>
  );
};
