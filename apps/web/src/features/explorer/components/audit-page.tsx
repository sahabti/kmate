import { ScrollText, SearchX } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useAuditEvents } from "@/features/explorer/hooks/use-audit-events";
import { errorMessage } from "@/services/api-client";
import { RelativeTime } from "@/components/relative-time";
import { PageHeader } from "@/components/page-header";
import { ErrorCallout } from "@/components/status";
import { DataTable } from "@/components/data-table";
import { ToneBadge } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import type { AuditEvent } from "@/gen/kmate/v1/hub_pb";
import { useUI } from "@/stores/ui";

/** Who did what on this cluster, as recorded by the hub. */
export const AuditPage = () => {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const search = useUI((s) => s.search);
  const q = useAuditEvents(clusterId, 200);
  const rows = (q.data ?? []).filter((e) => !search || `${e.user} ${e.action} ${e.target} ${e.result}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <PageHeader
        title="Audit log"
        meta={q.data && <Badge variant="secondary">{rows.length}</Badge>}
        description="Writes, exec, logs and port-forwards relayed through the hub. Newest first, last 200."
      />
      <ErrorCallout title="Could not load the audit log" message={q.error ? errorMessage(q.error) : null} onRetry={() => void q.refetch()} />
      {!q.error && (
        <DataTable<AuditEvent>
          rows={rows}
          rowKey={(e) => e.id}
          loading={q.isLoading}
          emptyIcon={search ? <SearchX /> : <ScrollText />}
          emptyTitle={search ? `No audit events match "${search}"` : "No audit events yet"}
          emptyHint={search ? "Try a different filter, or clear it." : "Actions such as scale, apply, delete, exec and log streaming are recorded here."}
          columns={[
            { id: "t", header: "When", cell: (e) => (e.time ? <span title={timestampDate(e.time).toLocaleString()}><RelativeTime date={timestampDate(e.time)} format="short" /></span> : "—") },
            { id: "u", header: "User", cell: (e) => e.user, mono: true },
            { id: "a", header: "Action", cell: (e) => <Badge variant="outline">{e.action}</Badge> },
            { id: "tg", header: "Target", cell: (e) => e.target, mono: true },
            { id: "r", header: "Result", cell: (e) => <ToneBadge tone={e.result === "ok" ? "ok" : e.result ? "bad" : "muted"}>{e.result || "—"}</ToneBadge> },
          ]}
        />
      )}
    </div>
  );
};
