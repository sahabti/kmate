import type { ReactNode } from "react";
import { Inbox, Lock } from "lucide-react";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { RelativeTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { Dot } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { denialHeadline, denialHint, denialLayer, type Denial } from "@/lib/denial";
import { cn } from "@/lib/utils";

/** Inline error callout; renders nothing when there is no message. */
export function ErrorCallout({ message, title = "Something went wrong", className }: { message: string | null | undefined; title?: string; className?: string }) {
  if (!message) return null;
  return (
    <Callout variant="destructive" className={cn("py-2.5", className)}>
      <CalloutTitle>{title}</CalloutTitle>
      <CalloutDescription className="font-mono text-[11px] break-words">{message}</CalloutDescription>
    </Callout>
  );
}

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <Spinner size="sm" label={label} /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Inbox />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {hint && <EmptyDescription>{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/**
 * Shown in place of a table or panel the user may not see.
 *
 * Never render an empty list for a denial: a blank panel reads as a broken
 * product, which is a documented way Kubernetes dashboards mislead people.
 */
export function DeniedState({ denial, what, className }: { denial: Denial; what?: string; className?: string }) {
  return (
    <Empty className={cn("py-14", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Lock />
        </EmptyMedia>
        <EmptyTitle>{what ? `You cannot ${what}` : denialHeadline(denial)}</EmptyTitle>
        <EmptyDescription className="max-w-prose">
          <span className="mb-2 block font-mono text-[11px] break-words text-foreground/80">{denial.message}</span>
          {denialHint(denial)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Badge variant="outline" className="rounded-md text-[10px]">
          refused by {denialLayer(denial)}
        </Badge>
      </EmptyContent>
    </Empty>
  );
}

/** Compact denial notice for drawer tabs and panels that are not full pages. */
export function DeniedCallout({ denial, what, className }: { denial: Denial; what?: string; className?: string }) {
  return (
    <Callout variant="warning" className={cn("py-2.5", className)}>
      <CalloutTitle>{what ? `You cannot ${what}` : denialHeadline(denial)}</CalloutTitle>
      <CalloutDescription>
        <span className="block font-mono text-[11px] break-words">{denial.message}</span>
        <span className="mt-1 block text-[11px] opacity-80">
          Refused by {denialLayer(denial)}. {denialHint(denial)}
        </span>
      </CalloutDescription>
    </Callout>
  );
}


/**
 * Freshness of a live-watched list: "Live" while the watch is healthy,
 * "Reconnecting" while showing rows from before a dropped connection.
 */
export function LiveStatus({ synced, stale, syncedAt, error, className }: { synced: boolean; stale: boolean; syncedAt: number | null; error?: string | null; className?: string }) {
  if (stale) {
    return (
      <span role="status" className={cn("flex items-center gap-1.5 text-xs text-warning", className)}>
        <Spinner size="sm" label="Reconnecting" />
        Reconnecting
        {syncedAt && (
          <span className="text-muted-foreground">
            · showing data from <RelativeTime date={syncedAt} format="narrow" />
          </span>
        )}
      </span>
    );
  }
  // The error callout explains why; a spinner beside it would suggest progress.
  if (!synced && error) return null;
  if (!synced) return <Loading className={className} label="Syncing" />;

  return (
    <span role="status" className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Dot tone="ok" pulse />
      Live
    </span>
  );
}
