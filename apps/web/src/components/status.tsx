import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { Spinner } from "@/components/spinner";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
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
