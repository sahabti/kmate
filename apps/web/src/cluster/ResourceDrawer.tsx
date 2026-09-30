import { Suspense, lazy, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, MoreHorizontal, Network, RefreshCw, Scaling, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cluster, errorMessage } from "@/api/client";
import { useCapabilities, useEventsFor, useObject, usePodsOnNode } from "@/api/hooks";
import { LogsView } from "@/cluster/Logs";
import { PortForwardDialog } from "@/cluster/PortForward";
import { Sparkline } from "@/components/Sparkline";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { formatBytes, formatCpu, metricKey, useMetricsStore } from "@/store/metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { EmptyState, ErrorCallout, Loading } from "@/components/status";
import { SimpleTable } from "@/components/Table";
import { Timeline, TimelineContent, TimelineDescription, TimelineDot, TimelineItem, TimelineTime, TimelineTitle } from "@/components/timeline";
import { Chips, ToneBadge } from "@/components/tone";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { age, containersOf, podReady, podRestarts, podStatus, stripManaged, type KObj } from "@/lib/k8s";
import { useDrawer } from "@/store/drawer";
import { useUI } from "@/store/ui";

const YamlView = lazy(() => import("@/cluster/YamlView"));
const ExecTerminal = lazy(() => import("@/cluster/Terminal"));

type Tab = "summary" | "yaml" | "events" | "logs" | "terminal";
type Pending = { kind: "scale" } | { kind: "restart" } | { kind: "delete" } | { kind: "cordon"; on: boolean } | { kind: "pf" } | null;

export function ResourceDrawer({ clusterId }: { clusterId: string }) {
  const target = useDrawer((s) => s.target);
  const close = useDrawer((s) => s.close);
  const [tab, setTab] = useState<Tab>("summary");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [replicas, setReplicas] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const q = useObject(clusterId, target?.gvr ?? null, target?.namespace ?? "", target?.name ?? "");
  const obj = q.data ?? null;
  const isPod = target?.gvr.resource === "pods";
  const isNode = target?.gvr.resource === "nodes";
  const isService = target?.gvr.resource === "services";
  const { canWrite, canExec, known: capsKnown } = useCapabilities(clusterId);
  const scalable = target?.gvr.resource === "deployments" || target?.gvr.resource === "statefulsets" || target?.gvr.resource === "replicasets";
  const restartable = target?.gvr.resource === "deployments" || target?.gvr.resource === "statefulsets" || target?.gvr.resource === "daemonsets";

  useEffect(() => {
    setTab("summary");
    setErr(null);
    setPending(null);
  }, [target?.gvr.resource, target?.namespace, target?.name]);

  if (!target) return null;

  const kindLabel = obj?.kind ?? target.kind ?? target.gvr.resource;
  const ref = { gvr: target.gvr, namespace: target.namespace, name: target.name };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ["object", clusterId] });
      toast.success(label);
      setPending(null);
    } catch (e) {
      const m = errorMessage(e);
      setErr(m);
      toast.error(m);
    } finally {
      setBusy(false);
    }
  };

  const doScale = () => {
    const n = Number(replicas);
    if (!Number.isInteger(n) || n < 0) return setErr("Replicas must be a non-negative integer");
    void run(`Scaled ${target.name} to ${n}`, () => cluster.scale({ clusterId, scale: { ref, replicas: n } }));
  };
  const doRestart = () => void run(`Restarting ${target.name}`, () => cluster.rolloutRestart({ clusterId, restart: { ref } }));
  const doDelete = () =>
    void run(`Deleted ${target.name}`, async () => {
      await cluster.delete({ clusterId, delete: { ref, propagationPolicy: "Background" } });
      close();
    });
  const doCordon = (on: boolean) =>
    void run(on ? `Cordoned ${target.name}` : `Uncordoned ${target.name}`, () =>
      cluster.patch({
        clusterId,
        patch: { ref, patchType: "application/merge-patch+json", patch: new TextEncoder().encode(JSON.stringify({ spec: { unschedulable: on ? true : null } })) },
      }),
    );
  const readOnlyHint = capsKnown ? "Agent installed read-only (rbac.write=false)" : "Checking agent capabilities…";
  const WriteItem = ({ children, onSelect, variant }: { children: React.ReactNode; onSelect: () => void; variant?: "destructive" }) =>
    canWrite ? (
      <DropdownMenuItem variant={variant} onSelect={onSelect}>
        {children}
      </DropdownMenuItem>
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <DropdownMenuItem disabled variant={variant}>
              {children}
            </DropdownMenuItem>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">{readOnlyHint}</TooltipContent>
      </Tooltip>
    );

  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[720px] data-[side=right]:sm:max-w-[88vw] data-[side=right]:lg:w-[860px]" showCloseButton>
        <SheetHeader className="gap-1 border-b pr-12">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-sm">
            <Badge variant="secondary" className="shrink-0 rounded-md">
              {kindLabel}
            </Badge>
            <span className="truncate font-mono">{target.name}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" className="ml-auto shrink-0" aria-label="Actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52 *:whitespace-nowrap">
                {(isPod || isService) && (
                  <>
                    <DropdownMenuItem onSelect={() => setPending({ kind: "pf" })} disabled={!obj}>
                      <Network /> Port-forward…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {scalable && (
                  <WriteItem
                    onSelect={() => {
                      setReplicas(String(obj?.spec?.replicas ?? 0));
                      setPending({ kind: "scale" });
                    }}
                  >
                    <Scaling /> Scale…
                  </WriteItem>
                )}
                {restartable && (
                  <WriteItem onSelect={() => setPending({ kind: "restart" })}>
                    <RefreshCw /> Rollout restart
                  </WriteItem>
                )}
                {isNode &&
                  (obj?.spec?.unschedulable ? (
                    <WriteItem onSelect={() => setPending({ kind: "cordon", on: false })}>
                      <CircleCheck /> Uncordon
                    </WriteItem>
                  ) : (
                    <WriteItem onSelect={() => setPending({ kind: "cordon", on: true })}>
                      <Ban /> Cordon
                    </WriteItem>
                  ))}
                {(scalable || restartable || isNode) && <DropdownMenuSeparator />}
                <WriteItem variant="destructive" onSelect={() => setPending({ kind: "delete" })}>
                  <Trash2 /> Delete
                </WriteItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SheetTitle>
          <SheetDescription className="text-xs">{target.namespace ? `namespace ${target.namespace}` : "cluster-scoped"}</SheetDescription>
        </SheetHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="w-full justify-start overflow-x-auto rounded-none border-b px-2">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="yaml">YAML</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            {isPod && <TabsTrigger value="logs">Logs</TabsTrigger>}
            {isPod && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
          </TabsList>
          {err && (
            <div className="p-3">
              <ErrorCallout message={err} />
            </div>
          )}
          {q.isLoading && <Loading className="p-4" />}
          {q.error && (
            <div className="p-3">
              <ErrorCallout message={errorMessage(q.error)} />
            </div>
          )}
          <TabsContent value="summary" className="min-h-0 flex-1 overflow-hidden">
            {obj && <Summary obj={obj} clusterId={clusterId} />}
          </TabsContent>
          <TabsContent value="yaml" className="min-h-0 flex-1 overflow-hidden">
            {obj && (
              <Suspense fallback={<Loading className="p-4" />}>
                <YamlView obj={stripManaged(obj)} clusterId={clusterId} canWrite={canWrite} />
              </Suspense>
            )}
          </TabsContent>
          <TabsContent value="events" className="min-h-0 flex-1 overflow-hidden">
            <Events clusterId={clusterId} namespace={target.namespace} name={target.name} />
          </TabsContent>
          {isPod && (
            <TabsContent value="logs" className="min-h-0 flex-1 overflow-hidden">
              {obj && <LogsView clusterId={clusterId} namespace={target.namespace} pod={target.name} containers={containersOf(obj)} />}
            </TabsContent>
          )}
          {isPod && (
            <TabsContent value="terminal" className="min-h-0 flex-1 overflow-hidden">
              {obj && (
                <Suspense fallback={<Loading className="p-4" />}>
                  <ExecTerminal clusterId={clusterId} namespace={target.namespace} pod={target.name} containers={containersOf(obj)} canExec={canExec} />
                </Suspense>
              )}
            </TabsContent>
          )}
        </Tabs>
      </SheetContent>

      {/* Scale dialog */}
      <Dialog open={pending?.kind === "scale"} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scale {target.name}</DialogTitle>
            <DialogDescription>Set the desired replica count for this {kindLabel}.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              doScale();
            }}
          >
            <Field>
              <FieldLabel htmlFor="replicas">Replicas</FieldLabel>
              <Input id="replicas" type="number" min={0} value={replicas} onChange={(e) => setReplicas(e.target.value)} autoFocus className="font-mono" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner size="sm" />} Scale
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Restart confirm */}
      <AlertDialog open={pending?.kind === "restart"} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rollout restart {target.name}?</AlertDialogTitle>
            <AlertDialogDescription>Pods are replaced one by one following the rollout strategy. No spec changes are made besides the restart annotation.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                doRestart();
              }}
            >
              {busy ? <Spinner size="sm" /> : <RefreshCw />} Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cordon / uncordon confirm */}
      <AlertDialog open={pending?.kind === "cordon"} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === "cordon" && pending.on ? "Cordon" : "Uncordon"} node {target.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "cordon" && pending.on
                ? "New pods will not be scheduled on this node. Running pods are not affected (no drain)."
                : "The node becomes schedulable again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (pending?.kind === "cordon") doCordon(pending.on);
              }}
            >
              {busy ? <Spinner size="sm" /> : pending?.kind === "cordon" && pending.on ? <Ban /> : <CircleCheck />} Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {obj && pending?.kind === "pf" && <PortForwardDialog open onClose={() => setPending(null)} clusterId={clusterId} obj={obj} />}

      {/* Delete confirm */}
      <AlertDialog open={pending?.kind === "delete"} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {kindLabel} "{target.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Dependent objects are deleted in the background.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                doDelete();
              }}
            >
              {busy ? <Spinner size="sm" /> : <Trash2 />} Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

function KV({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <Table className="text-xs">
      <TableBody>
        {rows.map(([k, v]) => (
          <TableRow key={k} className="hover:bg-transparent">
            <TableCell className="w-36 py-1.5 align-top text-muted-foreground">{k}</TableCell>
            <TableCell className="py-1.5 font-mono break-words whitespace-pre-wrap">{v ?? <span className="text-muted-foreground">—</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Summary({ obj, clusterId }: { obj: KObj; clusterId: string }) {
  const m = obj.metadata ?? {};
  const kind = obj.kind ?? "";
  const status: Array<[string, React.ReactNode]> = [];
  if (kind === "Pod") {
    const s = podStatus(obj);
    status.push(
      ["Status", <ToneBadge tone={s.tone} dot>{s.text}</ToneBadge>],
      ["Ready", podReady(obj)],
      ["Restarts", String(podRestarts(obj))],
      ["Node", obj.spec?.nodeName],
      ["Pod IP", obj.status?.podIP],
      ["QoS", obj.status?.qosClass],
      ["Service account", obj.spec?.serviceAccountName],
    );
  } else if (["Deployment", "StatefulSet", "ReplicaSet"].includes(kind)) {
    status.push(
      ["Replicas", `${obj.status?.readyReplicas ?? 0} ready / ${obj.spec?.replicas ?? 0} desired`],
      ["Updated", String(obj.status?.updatedReplicas ?? 0)],
      ["Available", String(obj.status?.availableReplicas ?? 0)],
      ["Strategy", obj.spec?.strategy?.type ?? obj.spec?.updateStrategy?.type],
    );
  } else if (kind === "Service") {
    status.push(
      ["Type", obj.spec?.type],
      ["Cluster IP", obj.spec?.clusterIP],
      ["Ports", (obj.spec?.ports ?? []).map((p: any) => `${p.name ?? ""} ${p.port}→${p.targetPort}/${p.protocol}`).join(", ")],
      ["Selector", <Chips map={obj.spec?.selector} />],
      ["External IPs", (obj.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(", ")],
    );
  } else if (kind === "Node") {
    const ni = obj.status?.nodeInfo ?? {};
    status.push(
      ["Kubelet", ni.kubeletVersion],
      ["OS", `${ni.osImage} (${ni.architecture})`],
      ["Runtime", ni.containerRuntimeVersion],
      ["CPU", obj.status?.allocatable?.cpu],
      ["Memory", obj.status?.allocatable?.memory],
      ["Addresses", (obj.status?.addresses ?? []).map((a: any) => `${a.type}=${a.address}`).join(", ")],
    );
  } else if (kind === "Ingress") {
    status.push(
      ["Class", obj.spec?.ingressClassName],
      [
        "Rules",
        (obj.spec?.rules ?? [])
          .flatMap((r: any) => (r.http?.paths ?? []).map((p: any) => `${r.host ?? "*"}${p.path ?? "/"} → ${p.backend?.service?.name}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name}`))
          .join("\n"),
      ],
      ["TLS", (obj.spec?.tls ?? []).map((t: any) => t.hosts?.join(",")).join("; ")],
      ["Address", (obj.status?.loadBalancer?.ingress ?? []).map((i: any) => i.ip ?? i.hostname).join(", ")],
    );
  }
  const conditions: any[] = obj.status?.conditions ?? [];
  const containers: any[] = kind === "Pod" ? (obj.spec?.containers ?? []) : (obj.spec?.template?.spec?.containers ?? []);
  const taints: any[] = kind === "Node" ? (obj.spec?.taints ?? []) : [];
  const resourceRows = kind === "Node" ? ["cpu", "memory", "ephemeral-storage", "pods", ...Object.keys(obj.status?.capacity ?? {}).filter((k) => k.includes("/"))] : [];

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4">
      <Section title="Metadata">
        <KV
          rows={[
            ["Name", m.name],
            ["Namespace", m.namespace],
            ["UID", m.uid],
            [
              "Created",
              m.creationTimestamp ? (
                <span>
                  {new Date(m.creationTimestamp).toLocaleString()} (<RelativeTime date={m.creationTimestamp} format="short" />)
                </span>
              ) : undefined,
            ],
            ["Owner", (m.ownerReferences ?? []).map((o) => `${o.kind}/${o.name}`).join(", ") || undefined],
          ]}
        />
      </Section>
      {status.length > 0 && (
        <Section title="Status">
          <KV rows={status} />
        </Section>
      )}
      {containers.length > 0 && (
        <Section title="Containers">
          <SimpleTable
            rows={containers}
            rowKey={(c: any) => c.name}
            columns={[
              { id: "n", header: "Name", cell: (c: any) => c.name },
              { id: "i", header: "Image", cell: (c: any) => c.image, mono: true },
              { id: "p", header: "Ports", cell: (c: any) => (c.ports ?? []).map((p: any) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", "), mono: true },
              { id: "r", header: "Requests", cell: (c: any) => Object.entries(c.resources?.requests ?? {}).map(([k, v]) => `${k}=${v}`).join(" "), mono: true },
              ...(kind === "Pod"
                ? [
                    { id: "cpu", header: "CPU", cell: (c: any) => <MetricValue k={metricKey(clusterId, "pods", m.namespace ?? "", m.name ?? "", c.name)} field="cpu" /> },
                    { id: "mem", header: "Memory", cell: (c: any) => <MetricValue k={metricKey(clusterId, "pods", m.namespace ?? "", m.name ?? "", c.name)} field="mem" /> },
                  ]
                : []),
            ]}
          />
        </Section>
      )}
      {kind === "Node" && (
        <Section title="Resources">
          <SimpleTable
            rows={resourceRows}
            rowKey={(r: string) => r}
            columns={[
              { id: "r", header: "Resource", cell: (r: string) => r },
              { id: "cap", header: "Capacity", cell: (r: string) => obj.status?.capacity?.[r] ?? "—", mono: true },
              { id: "alloc", header: "Allocatable", cell: (r: string) => obj.status?.allocatable?.[r] ?? "—", mono: true },
              { id: "use", header: "Usage", cell: (r: string) => (r === "cpu" || r === "memory" ? <MetricValue k={metricKey(clusterId, "nodes", "", m.name ?? "")} field={r === "cpu" ? "cpu" : "mem"} /> : "") },
            ]}
          />
        </Section>
      )}
      {kind === "Node" && (
        <Section title="Taints">
          {taints.length === 0 ? (
            <span className="text-xs text-muted-foreground">none</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {taints.map((t: any) => (
                <Badge key={`${t.key}${t.effect}`} variant="secondary" className="rounded-md font-mono text-[11px] font-normal">
                  {t.key}
                  {t.value ? `=${t.value}` : ""}:{t.effect}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      )}
      {kind === "Node" && <PodsOnNode clusterId={clusterId} node={m.name ?? ""} />}
      <Section title="Labels">
        <Chips map={m.labels} />
      </Section>
      <Section title="Annotations">
        <Chips map={m.annotations} />
      </Section>
      {conditions.length > 0 && (
        <Section title="Conditions">
          <SimpleTable
            rows={conditions}
            rowKey={(c: any) => c.type}
            columns={[
              { id: "t", header: "Type", cell: (c: any) => c.type },
              { id: "s", header: "Status", cell: (c: any) => <ToneBadge tone={c.status === "True" ? "ok" : c.status === "False" ? "muted" : "warn"}>{c.status}</ToneBadge> },
              { id: "r", header: "Reason", cell: (c: any) => c.reason ?? "" },
              { id: "m", header: "Message", cell: (c: any) => c.message ?? "" },
              { id: "a", header: "Since", cell: (c: any) => age(c.lastTransitionTime) },
            ]}
          />
        </Section>
      )}
    </div>
  );
}

function Events({ clusterId, namespace, name }: { clusterId: string; namespace: string; name: string }) {
  const q = useEventsFor(clusterId, namespace, name);
  const events = (q.data ?? []).slice().sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? "").localeCompare(String(a.lastTimestamp ?? a.eventTime ?? "")));
  return (
    <div className="h-full overflow-y-auto p-4">
      {q.isLoading && <Loading />}
      {q.error && <ErrorCallout message={errorMessage(q.error)} />}
      {q.data && events.length === 0 && <EmptyState title="No events" hint="Kubernetes keeps events for about an hour." />}
      {events.length > 0 && (
        <Timeline>
          {events.map((e) => {
            const when = e.lastTimestamp ?? e.eventTime;
            return (
              <TimelineItem key={e.metadata?.uid ?? e.metadata?.name ?? ""}>
                <TimelineDot tone={e.type === "Warning" ? "warning" : "success"} />
                <TimelineContent>
                  <TimelineTitle className="flex flex-wrap items-center gap-2 text-xs">
                    {e.reason}
                    {(e.count ?? 1) > 1 && (
                      <Badge variant="secondary" className="h-4 rounded-md px-1 font-mono text-[10px]">
                        ×{e.count}
                      </Badge>
                    )}
                  </TimelineTitle>
                  <TimelineTime className="text-[11px]">{when ? <RelativeTime date={when} format="short" /> : "—"}</TimelineTime>
                  <TimelineDescription className="text-xs break-words">{e.message}</TimelineDescription>
                </TimelineContent>
              </TimelineItem>
            );
          })}
        </Timeline>
      )}
    </div>
  );
}


function MetricValue({ k, field }: { k: string; field: "cpu" | "mem" }) {
  const series = useMetricsStore((s) => s.series[k]);
  if (!series || series.length === 0) return <span className="text-muted-foreground">—</span>;
  const vals = series.map((s) => s[field]);
  const last = vals[vals.length - 1]!;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono">
      <Sparkline values={vals} width={48} height={14} className="text-primary" />
      {field === "cpu" ? formatCpu(last) : formatBytes(last)}
    </span>
  );
}

function PodsOnNode({ clusterId, node }: { clusterId: string; node: string }) {
  const q = usePodsOnNode(clusterId, node);
  const open = useDrawer((s) => s.open);
  const setNamespace = useUI((s) => s.setNamespace);
  const pods = q.data ?? [];
  return (
    <Section title={`Pods on this node${q.data ? ` · ${pods.length}` : ""}`}>
      {q.isLoading && <Loading />}
      {q.error && <ErrorCallout message={errorMessage(q.error)} />}
      {q.data && pods.length === 0 && <span className="text-xs text-muted-foreground">No pods scheduled here.</span>}
      {pods.length > 0 && (
        <SimpleTable
          rows={pods}
          rowKey={(p) => p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`}
          onRowClick={(p) => {
            setNamespace(p.metadata?.namespace ?? "");
            open({ gvr: { group: "", version: "v1", resource: "pods" }, namespace: p.metadata?.namespace ?? "", name: p.metadata?.name ?? "", kind: "Pod" });
          }}
          columns={[
            { id: "n", header: "Name", cell: (p) => <span className="font-medium">{p.metadata?.name}</span> },
            { id: "ns", header: "Namespace", cell: (p) => <span className="text-muted-foreground">{p.metadata?.namespace}</span> },
            { id: "s", header: "Status", cell: (p) => { const st = podStatus(p); return <ToneBadge tone={st.tone}>{st.text}</ToneBadge>; } },
            { id: "r", header: "Ready", cell: (p) => podReady(p), mono: true },
            { id: "cpu", header: "CPU", cell: (p) => <MetricValue k={metricKey(clusterId, "pods", p.metadata?.namespace ?? "", p.metadata?.name ?? "")} field="cpu" /> },
            { id: "mem", header: "Memory", cell: (p) => <MetricValue k={metricKey(clusterId, "pods", p.metadata?.namespace ?? "", p.metadata?.name ?? "")} field="mem" /> },
          ]}
        />
      )}
      {q.data && pods.length > 0 && (
        <Callout variant="info" className="py-2">
          <CalloutTitle className="text-xs">Metrics</CalloutTitle>
          <CalloutDescription className="text-[11px]">Usage columns fill in once metrics have been polled for these namespaces (open the Pods page or wait a cycle).</CalloutDescription>
        </Callout>
      )}
    </Section>
  );
}
