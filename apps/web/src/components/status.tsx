import type { ReactNode } from "react";
import { CircleAlert, Inbox, Lock, RotateCw } from "lucide-react";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { RelativeTime } from "@/components/relative-time";
import { Dot } from "@/components/tone";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { denialHeadline, denialHint, denialLayer, type Denial } from "@/lib/denial";
import { cn } from "@/lib/utils";

interface ErrorCalloutProps {
  message: string | null | undefined;
  /** What failed, in plain words: "Could not load Helm releases". */
  title?: string;
  /** Shows a Retry button; omit when the data refreshes on its own. */
  onRetry?: () => void;
  className?: string;
}

/** Inline error for a panel or page; renders nothing when there is no message. */
export const ErrorCallout = ({ message, title = "Something went wrong", onRetry, className }: ErrorCalloutProps) => {
  if (!message) return null;

  return (
    <Alert variant="destructive" className={className}>
      <CircleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="break-words">{message}</AlertDescription>
      {onRetry && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Retry
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
};

interface PanelSkeletonProps {
  /** Number of text lines to stand in for. */
  lines?: number;
  className?: string;
}

/** Placeholder for a text panel (summary, details) while its data loads. */
export const PanelSkeleton = ({ lines = 4, className }: PanelSkeletonProps) => (
  <div role="status" aria-label="Loading" className={cn("flex flex-col gap-3", className)}>
    {Array.from({ length: lines }, (_, i) => (
      // Uneven widths read as text rather than as a bar chart.
      <Skeleton key={i} className={cn("h-4", i % 3 === 0 ? "w-2/3" : i % 3 === 1 ? "w-full" : "w-5/6")} />
    ))}
  </div>
);

interface FillSkeletonProps {
  className?: string;
}

/** Placeholder that fills its parent, for an editor or terminal whose code is loading. */
export const FillSkeleton = ({ className }: FillSkeletonProps) => <Skeleton role="status" aria-label="Loading" className={cn("size-full min-h-40", className)} />;

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}

export const EmptyState = ({ icon, title, hint, action }: EmptyStateProps) => {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Inbox />}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {hint && <EmptyDescription>{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
};

interface DeniedStateProps {
  denial: Denial;
  what?: string;
  className?: string;
}

/**
 * Shown in place of a table or panel the user may not see.
 *
 * Never render an empty list for a denial: a blank panel reads as a broken
 * product, which is a documented way Kubernetes dashboards mislead people.
 */
export const DeniedState = ({ denial, what, className }: DeniedStateProps) => {
  return (
    <Empty className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Lock />
        </EmptyMedia>
        <EmptyTitle>{what ? `You cannot ${what}` : denialHeadline(denial)}</EmptyTitle>
        <EmptyDescription className="max-w-prose">
          <span className="mb-2 block font-mono text-xs break-words text-foreground/80">{denial.message}</span>
          {denialHint(denial)}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Badge variant="outline">
          refused by {denialLayer(denial)}
        </Badge>
      </EmptyContent>
    </Empty>
  );
};

interface DeniedCalloutProps {
  denial: Denial;
  what?: string;
  className?: string;
}

/** Compact denial notice for drawer tabs and panels that are not full pages. */
export const DeniedCallout = ({ denial, what, className }: DeniedCalloutProps) => {
  return (
    <Callout variant="warning" className={cn("py-2.5", className)}>
      <CalloutTitle>{what ? `You cannot ${what}` : denialHeadline(denial)}</CalloutTitle>
      <CalloutDescription>
        <span className="block font-mono text-xs break-words">{denial.message}</span>
        <span className="mt-1 block text-xs opacity-80">
          Refused by {denialLayer(denial)}. {denialHint(denial)}
        </span>
      </CalloutDescription>
    </Callout>
  );
};


interface LiveStatusProps {
  synced: boolean;
  stale: boolean;
  syncedAt: number | null;
  error?: string | null;
  className?: string;
}

/**
 * Freshness of a live-watched list: "Live" while the watch is healthy,
 * "Reconnecting" while showing rows from before a dropped connection.
 */
export const LiveStatus = ({ synced, stale, syncedAt, error, className }: LiveStatusProps) => {
  if (stale) {
    return (
      <span role="status" className={cn("flex items-center gap-1.5 text-xs text-warning", className)}>
        <Dot tone="warn" pulse />
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
  if (!synced) {
    return (
      <span role="status" className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <Dot tone="muted" pulse />
        Syncing
      </span>
    );
  }

  return (
    <span role="status" className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Dot tone="ok" pulse />
      Live
    </span>
  );
};
