import { Suspense, lazy, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cluster, errorMessage } from "@/api/client";
import { useHelmRelease } from "@/api/hooks";
import { ErrorCallout, Loading } from "@/components/status";
import { SimpleTable } from "@/components/Table";
import { ToneBadge, type Tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { HelmRelease } from "@/gen/kmate/v1/agent_pb";
import { useUI } from "@/store/ui";

const CodeEditor = lazy(() => import("@/cluster/CodeEditor"));

function statusTone(s: string): Tone {
  if (s === "deployed") return "ok";
  if (s === "failed") return "bad";
  if (s === "superseded" || s === "uninstalled") return "muted";
  return "warn";
}

export function HelmPage() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const namespace = useUI((s) => s.namespace);
  const [sel, setSel] = useState<HelmRelease | null>(null);
  const q = useQuery({
    queryKey: ["helm", clusterId, namespace],
    queryFn: async () => (await cluster.listHelmReleases({ clusterId, namespace })).releases,
    refetchInterval: 30_000,
  });
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 md:p-5">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">Helm releases</h1>
        {q.data && (
          <Badge variant="secondary" className="rounded-md font-mono">
            {q.data.length}
          </Badge>
        )}
        <p className="hidden text-xs text-muted-foreground sm:block">Read from release secrets; no Helm binary needed in the cluster.</p>
      </div>
      <ErrorCallout message={q.error ? errorMessage(q.error) : null} />
      {q.isLoading && <Loading />}
      {q.data && (
        <SimpleTable<HelmRelease>
          rows={q.data}
          rowKey={(r) => `${r.namespace}/${r.name}`}
          onRowClick={setSel}
          columns={[
            { id: "name", header: "Release", cell: (r) => <span className="font-medium">{r.name}</span> },
            { id: "ns", header: "Namespace", cell: (r) => <span className="text-muted-foreground">{r.namespace}</span> },
            { id: "rev", header: "Revision", cell: (r) => String(r.revision), mono: true },
            { id: "status", header: "Status", cell: (r) => <ToneBadge tone={statusTone(r.status)}>{r.status}</ToneBadge> },
            { id: "chart", header: "Chart", cell: (r) => `${r.chart}${r.chartVersion ? `-${r.chartVersion}` : ""}`, mono: true },
            { id: "app", header: "App version", cell: (r) => r.appVersion, mono: true },
            { id: "upd", header: "Updated", cell: (r) => r.updated },
          ]}
          emptyText="No Helm releases found"
        />
      )}
      {sel && <ReleaseSheet clusterId={clusterId} release={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function ReleaseSheet({ clusterId, release, onClose }: { clusterId: string; release: HelmRelease; onClose: () => void }) {
  const [revision, setRevision] = useState(0);
  const [valuesMode, setValuesMode] = useState<"user" | "chart">("user");
  const q = useHelmRelease(clusterId, release.namespace, release.name, revision);
  const d = q.data;
  const rel = d?.release ?? release;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[720px] data-[side=right]:sm:max-w-[88vw] data-[side=right]:lg:w-[900px]" showCloseButton>
        <SheetHeader className="gap-1 border-b pr-12">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Badge variant="secondary" className="rounded-md">
              Helm
            </Badge>
            <span className="font-mono">{release.name}</span>
            <ToneBadge tone={statusTone(rel.status)}>{rel.status}</ToneBadge>
            {revision > 0 && (
              <Badge variant="outline" className="rounded-md font-mono text-[10px]">
                rev {revision}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="text-xs">
            namespace {release.namespace} · {rel.chart}
            {rel.chartVersion ? `-${rel.chartVersion}` : ""}
          </SheetDescription>
        </SheetHeader>
        {q.error && (
          <div className="p-3">
            <ErrorCallout message={errorMessage(q.error)} />
          </div>
        )}
        <Tabs defaultValue="overview" className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="w-full justify-start rounded-none border-b px-2">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="values">Values</TabsTrigger>
            <TabsTrigger value="manifest">Manifest</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto p-4">
            {q.isLoading && <Loading />}
            <Table className="text-xs">
              <TableBody>
                {(
                  [
                    ["Chart", `${rel.chart}${rel.chartVersion ? `-${rel.chartVersion}` : ""}`],
                    ["App version", rel.appVersion],
                    ["Revision", String(rel.revision)],
                    ["Status", rel.status],
                    ["Updated", rel.updated],
                    ["Description", d?.description],
                  ] as Array<[string, string | undefined]>
                ).map(([k, v]) => (
                  <TableRow key={k} className="hover:bg-transparent">
                    <TableCell className="w-32 py-1.5 text-muted-foreground">{k}</TableCell>
                    <TableCell className="py-1.5 font-mono break-words whitespace-pre-wrap">{v || <span className="text-muted-foreground">—</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {d?.notes && (
              <div className="mt-4 space-y-1">
                <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Notes</h3>
                <pre className="rounded-md border bg-muted/40 p-3 font-mono text-[11px] whitespace-pre-wrap">{d.notes}</pre>
              </div>
            )}
          </TabsContent>
          <TabsContent value="values" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
              <ToggleGroup type="single" size="sm" variant="outline" value={valuesMode} onValueChange={(v) => v && setValuesMode(v as "user" | "chart")}>
                <ToggleGroupItem value="user">User values</ToggleGroupItem>
                <ToggleGroupItem value="chart">Chart defaults</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="min-h-0 flex-1">
              {d && (
                <Suspense fallback={<Loading className="p-4" />}>
                  <CodeEditor value={(valuesMode === "user" ? d.valuesYaml : d.chartValuesYaml) || "# (empty)\n"} readOnly />
                </Suspense>
              )}
            </div>
          </TabsContent>
          <TabsContent value="manifest" className="min-h-0 flex-1">
            {d && (
              <Suspense fallback={<Loading className="p-4" />}>
                <CodeEditor value={d.manifest || "# (empty)\n"} readOnly />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-4">
            {d && (
              <SimpleTable<HelmRelease>
                rows={d.history}
                rowKey={(r) => String(r.revision)}
                onRowClick={(r) => setRevision(r.revision)}
                columns={[
                  { id: "rev", header: "Revision", cell: (r) => (r.revision === rel.revision ? <span className="font-semibold">{r.revision} ●</span> : String(r.revision)), mono: true },
                  { id: "status", header: "Status", cell: (r) => <ToneBadge tone={statusTone(r.status)}>{r.status}</ToneBadge> },
                  { id: "chart", header: "Chart", cell: (r) => `${r.chart}${r.chartVersion ? `-${r.chartVersion}` : ""}`, mono: true },
                  { id: "app", header: "App version", cell: (r) => r.appVersion, mono: true },
                  { id: "upd", header: "Updated", cell: (r) => r.updated },
                ]}
                emptyText="No history"
              />
            )}
            {revision > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Showing revision {revision}.{" "}
                <button className="underline" onClick={() => setRevision(0)}>
                  Back to latest
                </button>
              </p>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
