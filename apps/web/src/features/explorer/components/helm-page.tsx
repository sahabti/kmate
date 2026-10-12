import { Suspense, lazy, useState } from "react";
import { Package } from "lucide-react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cluster, errorMessage } from "@/services/api-client";
import { useHelmRelease } from "@/features/explorer/hooks/use-helm-release";
import { PageHeader } from "@/components/page-header";
import { ErrorCallout, FillSkeleton, PanelSkeleton } from "@/components/status";
import { DataTable } from "@/components/data-table";
import { ToneBadge, type Tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { HelmRelease } from "@/gen/kmate/v1/agent_pb";
import { useUI } from "@/stores/ui";

const CodeEditor = lazy(() => import("@/features/explorer/components/code-editor").then((m) => ({ default: m.CodeEditor })));

const statusTone = (s: string): Tone => {
  if (s === "deployed") return "ok";
  if (s === "failed") return "bad";
  if (s === "superseded" || s === "uninstalled") return "muted";

  return "warn";
};

export const HelmPage = () => {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const namespace = useUI((s) => s.namespace);
  const [sel, setSel] = useState<HelmRelease | null>(null);
  const q = useQuery({
    queryKey: ["helm", clusterId, namespace],
    queryFn: async () => (await cluster.listHelmReleases({ clusterId, namespace })).releases,
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <PageHeader
        title="Helm releases"
        meta={q.data && <Badge variant="secondary">{q.data.length}</Badge>}
        description="Read from release secrets; no Helm binary is needed in the cluster."
      />
      <ErrorCallout title="Could not load Helm releases" message={q.error ? errorMessage(q.error) : null} onRetry={() => void q.refetch()} />
      {!q.error && (
        <DataTable<HelmRelease>
          rows={q.data ?? []}
          loading={q.isLoading}
          emptyIcon={<Package />}
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
          emptyTitle="No Helm releases"
          emptyHint="Releases installed with Helm 3 appear here."
        />
      )}
      {sel && <ReleaseSheet clusterId={clusterId} release={sel} onClose={() => setSel(null)} />}
    </div>
  );
};

type ValuesMode = "user" | "chart";

type OverviewRow = [string, string | undefined];

interface ReleaseSheetProps {
  clusterId: string;
  release: HelmRelease;
  onClose: () => void;
}

const ReleaseSheet = ({ clusterId, release, onClose }: ReleaseSheetProps) => {
  const [revision, setRevision] = useState(0);
  const [valuesMode, setValuesMode] = useState<ValuesMode>("user");
  const q = useHelmRelease(clusterId, release.namespace, release.name, revision);
  const d = q.data;
  const rel = d?.release ?? release;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[720px] data-[side=right]:sm:max-w-[88vw] data-[side=right]:lg:w-[900px]"
        showCloseButton
      >
        <div className="border-b">
          <SheetHeader className="gap-1 pr-12">
            <SheetTitle>
              <span className="flex items-center gap-2">
                <Badge variant="secondary">Helm</Badge>
                <span className="font-mono">{release.name}</span>
                <ToneBadge tone={statusTone(rel.status)}>{rel.status}</ToneBadge>
                {revision > 0 && <Badge variant="outline">rev {revision}</Badge>}
              </span>
            </SheetTitle>
            <SheetDescription>
              namespace {release.namespace} · {rel.chart}
              {rel.chartVersion ? `-${rel.chartVersion}` : ""}
            </SheetDescription>
          </SheetHeader>
        </div>
        {q.error && (
          <div className="p-3">
            <ErrorCallout message={errorMessage(q.error)} />
          </div>
        )}
        <Tabs defaultValue="overview" className="min-h-0 flex-1">
          <div className="border-b px-2">
            <TabsList variant="line" className="w-full justify-start">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="values">Values</TabsTrigger>
              <TabsTrigger value="manifest">Manifest</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-4">
              {q.isLoading && <PanelSkeleton lines={6} />}
              <Table>
                <TableBody>
                  {(
                    [
                      ["Chart", `${rel.chart}${rel.chartVersion ? `-${rel.chartVersion}` : ""}`],
                      ["App version", rel.appVersion],
                      ["Revision", String(rel.revision)],
                      ["Status", rel.status],
                      ["Updated", rel.updated],
                      ["Description", d?.description],
                    ] as OverviewRow[]
                  ).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="w-32 py-1.5">
                        <span className="text-muted-foreground">{k}</span>
                      </TableCell>
                      <TableCell className="py-1.5 break-words whitespace-pre-wrap">
                        {v ? <span className="font-mono">{v}</span> : <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {d?.notes && (
                <div className="mt-4 space-y-1">
                  <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Notes</h3>
                  <pre className="rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">{d.notes}</pre>
                </div>
              )}
            </div>
          </TabsContent>
          <TabsContent value="values" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
              <ToggleGroup type="single" size="sm" variant="outline" value={valuesMode} onValueChange={(v) => v && setValuesMode(v as ValuesMode)}>
                <ToggleGroupItem value="user">User values</ToggleGroupItem>
                <ToggleGroupItem value="chart">Chart defaults</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="min-h-0 flex-1">
              {d && (
                <Suspense fallback={<FillSkeleton />}>
                  <CodeEditor value={(valuesMode === "user" ? d.valuesYaml : d.chartValuesYaml) || "# (empty)\n"} readOnly />
                </Suspense>
              )}
            </div>
          </TabsContent>
          <TabsContent value="manifest" className="min-h-0 flex-1">
            {d && (
              <Suspense fallback={<FillSkeleton />}>
                <CodeEditor value={d.manifest || "# (empty)\n"} readOnly />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
            <div className="p-4">
              {d && (
                <DataTable<HelmRelease>
                  rows={d.history}
                  rowKey={(r) => String(r.revision)}
                  onRowClick={(r) => setRevision(r.revision)}
                  columns={[
                    {
                      id: "rev",
                      header: "Revision",
                      cell: (r) => (r.revision === rel.revision ? <span className="font-semibold">{r.revision} ●</span> : String(r.revision)),
                      mono: true,
                    },
                    { id: "status", header: "Status", cell: (r) => <ToneBadge tone={statusTone(r.status)}>{r.status}</ToneBadge> },
                    { id: "chart", header: "Chart", cell: (r) => `${r.chart}${r.chartVersion ? `-${r.chartVersion}` : ""}`, mono: true },
                    { id: "app", header: "App version", cell: (r) => r.appVersion, mono: true },
                    { id: "upd", header: "Updated", cell: (r) => r.updated },
                  ]}
                  emptyTitle="No history"
                />
              )}
              {revision > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing revision {revision}.{" "}
                  <button className="underline" onClick={() => setRevision(0)}>
                    Back to latest
                  </button>
                </p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
};
