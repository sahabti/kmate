import { useParams } from "@tanstack/react-router";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useAuditEvents } from "@/api/hooks";
import { errorMessage } from "@/api/client";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, ErrorCallout, Loading } from "@/components/status";
import { SimpleTable } from "@/components/Table";
import { ToneBadge } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import type { AuditEvent } from "@/gen/kmate/v1/hub_pb";
import { useUI } from "@/store/ui";

/** Who did what on this cluster, as recorded by the hub. */
export function AuditPage() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const search = useUI((s) => s.search);
  const q = useAuditEvents(clusterId, 200);
  const rows = (q.data ?? []).filter((e) => !search || `${e.user} ${e.action} ${e.target} ${e.result}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 md:p-5">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">Audit log</h1>
        {q.data && (
          <Badge variant="secondary" className="rounded-md font-mono">
            {rows.length}
          </Badge>
        )}
        <p className="hidden text-xs text-muted-foreground sm:block">Writes, exec, logs and port-forwards relayed through the hub. Newest first, last 200.</p>
      </div>
      <ErrorCallout message={q.error ? errorMessage(q.error) : null} />
      {q.isLoading && <Loading />}
      {q.data && rows.length === 0 && <EmptyState title="No audit events yet" hint="Actions such as scale, apply, delete, exec and log streaming are recorded here." />}
      {rows.length > 0 && (
        <SimpleTable<AuditEvent>
          rows={rows}
          rowKey={(e) => e.id}
          columns={[
            { id: "t", header: "When", cell: (e) => (e.time ? <span title={timestampDate(e.time).toLocaleString()}><RelativeTime date={timestampDate(e.time)} format="short" /></span> : "—") },
            { id: "u", header: "User", cell: (e) => e.user, mono: true },
            { id: "a", header: "Action", cell: (e) => <Badge variant="outline" className="rounded-md font-mono text-[10px]">{e.action}</Badge> },
            { id: "tg", header: "Target", cell: (e) => e.target, mono: true },
            { id: "r", header: "Result", cell: (e) => <ToneBadge tone={e.result === "ok" ? "ok" : e.result ? "bad" : "muted"}>{e.result || "—"}</ToneBadge> },
          ]}
        />
      )}
    </div>
  );
}
