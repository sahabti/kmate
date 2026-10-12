import { Suspense, lazy, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, MoreHorizontal, Network, RefreshCw, Scaling, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cluster, errorMessage } from "@/services/api-client";
import { denialFromReason } from "@/lib/denial";
import { useAccessReview, type AccessQuestion } from "@/features/explorer/hooks/use-access-review";
import { useCapabilities } from "@/hooks/use-capabilities";
import { useEventsFor } from "@/features/explorer/hooks/use-events-for";
import { useObject } from "@/features/explorer/hooks/use-object";
import { usePodsOnNode } from "@/features/explorer/hooks/use-pods-on-node";
import { LogsView } from "@/features/explorer/components/logs-view";
import { PortForwardDialog } from "@/features/explorer/components/port-forward-dialog";
import { Sparkline } from "@/components/sparkline";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { formatBytes, formatCpu, metricKey, useMetricsStore } from "@/stores/metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RelativeTime } from "@/components/relative-time";
import { Spinner } from "@/components/spinner";
import { useConfirm } from "@/components/confirm";
import { EmptyState, ErrorCallout, FillSkeleton, PanelSkeleton } from "@/components/status";
import { DataTable } from "@/components/data-table";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { age, containersOf, podReady, podRestarts, podStatus, stripManaged, type KObj } from "@/lib/k8s";
import { useDrawer } from "@/stores/drawer";
import { useUI } from "@/stores/ui";

const YamlView = lazy(() => import("@/features/explorer/components/yaml-view").then((m) => ({ default: m.YamlView })));
const ExecTerminal = lazy(() => import("@/features/explorer/components/exec-terminal").then((m) => ({ default: m.ExecTerminal })));

type Tab = "summary" | "yaml" | "events" | "logs" | "terminal";
type Pending = { kind: "scale" } | { kind: "restart" } | { kind: "cordon"; on: boolean } | { kind: "pf" } | null;
type MetricField = "cpu" | "mem";

/* The slices of Kubernetes object JSON the summary reads; KObj leaves spec and status open. */
interface ServicePortSpec {
  name?: string;
  port: number;
  targetPort?: string | number;
  protocol?: string;
}

interface LoadBalancerIngress {
  ip?: string;
  hostname?: string;
}

interface NodeAddress {
  type: string;
  address: string;
}

interface ServiceBackendPort {
  number?: number;
  name?: string;
}

interface IngressServiceBackend {
  name: string;
  port?: ServiceBackendPort;
}

interface IngressBackend {
  service?: IngressServiceBackend;
}

interface IngressPath {
  path?: string;
  backend?: IngressBackend;
}

interface HTTPIngressRuleValue {
  paths?: IngressPath[];
}

interface IngressRule {
  host?: string;
  http?: HTTPIngressRuleValue;
}

interface IngressTLS {
  hosts?: string[];
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

interface ContainerPort {
  containerPort: number;
  protocol?: string;
}

interface ResourceRequirements {
  requests?: Record<string, string>;
}

interface ContainerSpec {
  name: string;
  image?: string;
  ports?: ContainerPort[];
  resources?: ResourceRequirements;
}

interface Taint {
  key: string;
  value?: string;
  effect: string;
}

interface ResourceDrawerProps {
  clusterId: string;
}

export const ResourceDrawer = ({ clusterId }: ResourceDrawerProps) => {
  const target = useDrawer((s) => s.target);
  const close = useDrawer((s) => s.close);
  const [tab, setTab] = useState<Tab>("summary");
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [replicas, setReplicas] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useObject(clusterId, target?.gvr ?? null, target?.namespace ?? "", target?.name ?? "");
  const obj = q.data ?? null;
  const isPod = target?.gvr.resource === "pods";
  const isNode = target?.gvr.resource === "nodes";
  const isService = target?.gvr.resource === "services";
  const { canWrite, canExec, known: capsKnown } = useCapabilities(clusterId);
  const scalable = target?.gvr.resource === "deployments" || target?.gvr.resource === "statefulsets" || target?.gvr.resource === "replicasets";
  const restartable = target?.gvr.resource === "deployments" || target?.gvr.resource === "statefulsets" || target?.gvr.resource === "daemonsets";

  // Ask the API server what this user may really do, so buttons reflect the
  // cluster's own RBAC and not just how the agent was installed.
  const questions = useMemo<AccessQuestion[]>(() => {
    if (!target) return [];
    const base = { group: target.gvr.group, version: target.gvr.version, resource: target.gvr.resource, namespace: target.namespace, name: target.name };
    const qs: AccessQuestion[] = [
      { ...base, verb: "patch" },
      { ...base, verb: "delete" },
    ];
    if (target.gvr.resource === "pods") {
      qs.push({ group: "", version: "v1", resource: "pods", subresource: "exec", namespace: target.namespace, name: target.name, verb: "create" });
      qs.push({ group: "", version: "v1", resource: "pods", subresource: "portforward", namespace: target.namespace, name: target.name, verb: "create" });
    }

    return qs;
  }, [target]);
  const review = useAccessReview(clusterId, questions, !!target);

  // Opening another object starts on its summary with no leftover dialog or error.
  // Reset during render so the old object's tab never paints for the new one.
  const targetKey = `${target?.gvr.resource}|${target?.namespace}|${target?.name}`;
  const [openedKey, setOpenedKey] = useState(targetKey);
  if (openedKey !== targetKey) {
    setOpenedKey(targetKey);
    setTab("summary");
    setErr(null);
    setPending(null);
  }

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
      // The dialog that ran the action stays open and shows this inline.
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doScale = () => {
    const n = Number(replicas);
    if (replicas.trim() === "" || !Number.isInteger(n) || n < 0) return setErr("Enter a whole number, 0 or more.");
    void run(`Scaled ${target.name} to ${n}`, () => cluster.scale({ clusterId, scale: { ref, replicas: n } }));
  };
  const dismiss = () => {
    setPending(null);
    setErr(null);
  };
  const doRestart = () => void run(`Restarting ${target.name}`, () => cluster.rolloutRestart({ clusterId, restart: { ref } }));
  // Deleting a namespace or node takes everything in or on it down too, so it asks for the name.
  const severe = target.gvr.resource === "namespaces" || target.gvr.resource === "nodes";
  const doDelete = () =>
    void confirm({
      title: `Delete ${kindLabel} ${target.name}?`,
      description: (
        <>
          {target.namespace && (
            <>
              Deletes <span className="font-mono text-foreground">{target.name}</span> from namespace{" "}
              <span className="font-mono text-foreground">{target.namespace}</span>.{" "}
            </>
          )}
          {target.gvr.resource === "namespaces"
            ? "Every object in the namespace is deleted with it. This cannot be undone."
            : target.gvr.resource === "nodes"
              ? "The node is removed from the cluster; its pods are not drained first. This cannot be undone."
              : "This cannot be undone. Dependent objects are deleted in the background."}
        </>
      ),
      confirmText: `Delete ${kindLabel.toLowerCase()}`,
      tone: "destructive",
      typeToConfirm: severe ? target.name : undefined,
      onConfirm: async () => {
        await cluster.delete({ clusterId, delete: { ref, propagationPolicy: "Background" } });
        await qc.invalidateQueries({ queryKey: ["object", clusterId] });
        toast.success(`Deleted ${kindLabel.toLowerCase()} ${target.name}`);
        close();
      },
    });
  const doCordon = (on: boolean) =>
    void run(on ? `Cordoned ${target.name}` : `Uncordoned ${target.name}`, () =>
      cluster.patch({
        clusterId,
        patch: {
          ref,
          patchType: "application/merge-patch+json",
          patch: new TextEncoder().encode(JSON.stringify({ spec: { unschedulable: on ? true : null } })),
        },
      }),
    );
  const readOnlyHint = capsKnown ? "The agent is installed read-only (rbac.write=false)" : "Checking agent capabilities…";

  /**
   * Why a verb is unavailable, or null when it is allowed. The agent capability
   * is checked first because it blocks everyone; then the user's own answer from
   * the API server.
   */
  const blockedReason = (verb: string, subresource?: string): string | null => {
    if (!target) return null;
    if (!canWrite && verb !== "create") return readOnlyHint;
    const ans = review.can({
      group: subresource ? "" : target.gvr.group,
      version: subresource ? "v1" : target.gvr.version,
      resource: subresource ? "pods" : target.gvr.resource,
      subresource,
      namespace: target.namespace,
      name: target.name,
      verb,
    });
    if (!ans) return null; // unknown yet: do not disable on a guess
    if (ans.allowed) return null;
    const why = ans.reason?.trim() || "the cluster's RBAC does not allow it";
    // Name the layer that actually refused, so the sentence matches the reason.
    const d = denialFromReason(why);
    if (d === "kmate") return `You cannot ${verb} this: ${why}`;
    if (ans.shared) return `Not allowed: ${why}`;

    return `Your Kubernetes account cannot ${verb} this: ${why}`;
  };

  const patchBlocked = blockedReason("patch");
  // Port-forward is a create on pods/portforward, and needs no write capability.
  const portForwardBlocked = isPod ? blockedReason("create", "portforward") : null;

  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:w-[720px] data-[side=right]:sm:max-w-[88vw] data-[side=right]:lg:w-[860px]"
        showCloseButton
      >
        <div className="border-b">
          <SheetHeader className="gap-1 pr-12">
            <SheetTitle className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary" className="shrink-0">
                  {kindLabel}
                </Badge>
                <span className="truncate font-mono">{target.name}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon-sm" className="ml-auto shrink-0" aria-label="Actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {(isPod || isService) && (
                      <>
                        <PortForwardItem blocked={portForwardBlocked} disabled={!obj} onSelect={() => setPending({ kind: "pf" })} />
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {scalable && (
                      <WriteItem
                        blocked={patchBlocked}
                        onSelect={() => {
                          setReplicas(String(obj?.spec?.replicas ?? 0));
                          setPending({ kind: "scale" });
                        }}
                      >
                        <Scaling /> Scale…
                      </WriteItem>
                    )}
                    {restartable && (
                      <WriteItem blocked={patchBlocked} onSelect={() => setPending({ kind: "restart" })}>
                        <RefreshCw /> Rollout restart…
                      </WriteItem>
                    )}
                    {isNode &&
                      (obj?.spec?.unschedulable ? (
                        <WriteItem blocked={patchBlocked} onSelect={() => setPending({ kind: "cordon", on: false })}>
                          <CircleCheck /> Uncordon…
                        </WriteItem>
                      ) : (
                        <WriteItem blocked={patchBlocked} onSelect={() => setPending({ kind: "cordon", on: true })}>
                          <Ban /> Cordon…
                        </WriteItem>
                      ))}
                    {(scalable || restartable || isNode) && <DropdownMenuSeparator />}
                    <WriteItem variant="destructive" blocked={blockedReason("delete")} onSelect={doDelete}>
                      <Trash2 /> Delete…
                    </WriteItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </SheetTitle>
            <SheetDescription>{target.namespace ? `namespace ${target.namespace}` : "cluster-scoped"}</SheetDescription>
          </SheetHeader>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1">
          <div className="border-b px-2">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="yaml">YAML</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              {isPod && <TabsTrigger value="logs">Logs</TabsTrigger>}
              {isPod && <TabsTrigger value="terminal">Terminal</TabsTrigger>}
            </TabsList>
          </div>
          {err && !pending && (
            <div className="p-3">
              <ErrorCallout message={err} />
            </div>
          )}
          {q.isLoading && <PanelSkeleton className="p-4" lines={6} />}
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
              <Suspense fallback={<FillSkeleton />}>
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
                <Suspense fallback={<FillSkeleton />}>
                  <ExecTerminal
                    clusterId={clusterId}
                    namespace={target.namespace}
                    pod={target.name}
                    containers={containersOf(obj)}
                    canExec={canExec}
                    blockedReason={canExec ? blockedReason("create", "exec") : null}
                  />
                </Suspense>
              )}
            </TabsContent>
          )}
        </Tabs>
      </SheetContent>

      {/* Scale dialog */}
      <Dialog open={pending?.kind === "scale"} onOpenChange={(o) => !o && dismiss()}>
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
            <Field data-invalid={!!err || undefined}>
              <FieldLabel htmlFor="replicas">Replicas</FieldLabel>
              <Input
                id="replicas"
                type="number"
                inputMode="numeric"
                min={0}
                value={replicas}
                onChange={(e) => setReplicas(e.target.value)}
                autoFocus
                aria-invalid={!!err || undefined}
                aria-describedby={err ? "replicas-error" : undefined}
              />
              {err && <FieldError id="replicas-error">{err}</FieldError>}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={dismiss}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Spinner size="sm" />} Scale {kindLabel.toLowerCase()}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Restart confirm */}
      <AlertDialog open={pending?.kind === "restart"} onOpenChange={(o) => !o && dismiss()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rollout restart {target.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Pods are replaced one by one following the rollout strategy. No spec changes are made besides the restart annotation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ErrorCallout message={err} title="That did not work" />
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
      <AlertDialog open={pending?.kind === "cordon"} onOpenChange={(o) => !o && dismiss()}>
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
          <ErrorCallout message={err} title="That did not work" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (pending?.kind === "cordon") doCordon(pending.on);
              }}
            >
              {busy ? <Spinner size="sm" /> : pending?.kind === "cordon" && pending.on ? <Ban /> : <CircleCheck />}{" "}
              {pending?.kind === "cordon" && pending.on ? "Cordon node" : "Uncordon node"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {obj && pending?.kind === "pf" && <PortForwardDialog open onClose={() => setPending(null)} clusterId={clusterId} obj={obj} />}
    </Sheet>
  );
};

interface PortForwardItemProps {
  /** Why the user may not port-forward, or null when allowed. */
  blocked: string | null;
  disabled: boolean;
  onSelect: () => void;
}

const PortForwardItem = ({ blocked, disabled, onSelect }: PortForwardItemProps) => {
  const item = (
    <DropdownMenuItem disabled={disabled || !!blocked} onSelect={onSelect}>
      <Network /> Port-forward…
    </DropdownMenuItem>
  );
  if (!blocked) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{item}</div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        {blocked}
      </TooltipContent>
    </Tooltip>
  );
};

interface WriteItemProps {
  children: React.ReactNode;
  /** Why the user may not run this action, or null when allowed. */
  blocked: string | null;
  onSelect: () => void;
  variant?: "destructive";
}

const WriteItem = ({ children, blocked, onSelect, variant }: WriteItemProps) =>
  blocked ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <DropdownMenuItem disabled variant={variant}>
            {children}
          </DropdownMenuItem>
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        {blocked}
      </TooltipContent>
    </Tooltip>
  ) : (
    <DropdownMenuItem variant={variant} onSelect={onSelect}>
      {children}
    </DropdownMenuItem>
  );

type KVRow = [string, React.ReactNode];

interface KVProps {
  rows: KVRow[];
}

const KV = ({ rows }: KVProps) => {
  return (
    <Table>
      <TableBody>
        {rows.map(([k, v]) => (
          <TableRow key={k}>
            <TableCell className="w-36 py-1.5 align-top">
              <span className="text-muted-foreground">{k}</span>
            </TableCell>
            <TableCell className="py-1.5 break-words whitespace-pre-wrap">
              {v != null ? <span className="font-mono">{v}</span> : <span className="text-muted-foreground">—</span>}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section = ({ title, children }: SectionProps) => {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
};

interface SummaryProps {
  obj: KObj;
  clusterId: string;
}

const Summary = ({ obj, clusterId }: SummaryProps) => {
  const m = obj.metadata ?? {};
  const kind = obj.kind ?? "";
  const status: KVRow[] = [];
  if (kind === "Pod") {
    const s = podStatus(obj);
    status.push(
      [
        "Status",
        <ToneBadge tone={s.tone} dot>
          {s.text}
        </ToneBadge>,
      ],
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
    const ports: ServicePortSpec[] = obj.spec?.ports ?? [];
    const lbIngress: LoadBalancerIngress[] = obj.status?.loadBalancer?.ingress ?? [];
    status.push(
      ["Type", obj.spec?.type],
      ["Cluster IP", obj.spec?.clusterIP],
      ["Ports", ports.map((p) => `${p.name ?? ""} ${p.port}→${p.targetPort}/${p.protocol}`).join(", ")],
      ["Selector", <Chips map={obj.spec?.selector} />],
      ["External IPs", lbIngress.map((i) => i.ip ?? i.hostname).join(", ")],
    );
  } else if (kind === "Node") {
    const ni = obj.status?.nodeInfo ?? {};
    const addresses: NodeAddress[] = obj.status?.addresses ?? [];
    status.push(
      ["Kubelet", ni.kubeletVersion],
      ["OS", `${ni.osImage} (${ni.architecture})`],
      ["Runtime", ni.containerRuntimeVersion],
      ["CPU", obj.status?.allocatable?.cpu],
      ["Memory", obj.status?.allocatable?.memory],
      ["Addresses", addresses.map((a) => `${a.type}=${a.address}`).join(", ")],
    );
  } else if (kind === "Ingress") {
    const rules: IngressRule[] = obj.spec?.rules ?? [];
    const tls: IngressTLS[] = obj.spec?.tls ?? [];
    const lbIngress: LoadBalancerIngress[] = obj.status?.loadBalancer?.ingress ?? [];
    status.push(
      ["Class", obj.spec?.ingressClassName],
      [
        "Rules",
        rules
          .flatMap((r) =>
            (r.http?.paths ?? []).map(
              (p) => `${r.host ?? "*"}${p.path ?? "/"} → ${p.backend?.service?.name}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name}`,
            ),
          )
          .join("\n"),
      ],
      ["TLS", tls.map((t) => t.hosts?.join(",")).join("; ")],
      ["Address", lbIngress.map((i) => i.ip ?? i.hostname).join(", ")],
    );
  }
  const conditions: Condition[] = obj.status?.conditions ?? [];
  const containers: ContainerSpec[] = kind === "Pod" ? (obj.spec?.containers ?? []) : (obj.spec?.template?.spec?.containers ?? []);
  const taints: Taint[] = kind === "Node" ? (obj.spec?.taints ?? []) : [];
  const resourceRows =
    kind === "Node" ? ["cpu", "memory", "ephemeral-storage", "pods", ...Object.keys(obj.status?.capacity ?? {}).filter((k) => k.includes("/"))] : [];

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
          <DataTable
            rows={containers}
            rowKey={(c) => c.name}
            columns={[
              { id: "n", header: "Name", cell: (c) => c.name },
              { id: "i", header: "Image", cell: (c) => c.image, mono: true },
              { id: "p", header: "Ports", cell: (c) => (c.ports ?? []).map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", "), mono: true },
              {
                id: "r",
                header: "Requests",
                cell: (c) =>
                  Object.entries(c.resources?.requests ?? {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join(" "),
                mono: true,
              },
              ...(kind === "Pod"
                ? [
                    {
                      id: "cpu",
                      header: "CPU",
                      cell: (c: ContainerSpec) => <MetricValue k={metricKey(clusterId, "pods", m.namespace ?? "", m.name ?? "", c.name)} field="cpu" />,
                    },
                    {
                      id: "mem",
                      header: "Memory",
                      cell: (c: ContainerSpec) => <MetricValue k={metricKey(clusterId, "pods", m.namespace ?? "", m.name ?? "", c.name)} field="mem" />,
                    },
                  ]
                : []),
            ]}
          />
        </Section>
      )}
      {kind === "Node" && (
        <Section title="Resources">
          <DataTable
            rows={resourceRows}
            rowKey={(r: string) => r}
            columns={[
              { id: "r", header: "Resource", cell: (r: string) => r },
              { id: "cap", header: "Capacity", cell: (r: string) => obj.status?.capacity?.[r] ?? "—", mono: true },
              { id: "alloc", header: "Allocatable", cell: (r: string) => obj.status?.allocatable?.[r] ?? "—", mono: true },
              {
                id: "use",
                header: "Usage",
                cell: (r: string) =>
                  r === "cpu" || r === "memory" ? <MetricValue k={metricKey(clusterId, "nodes", "", m.name ?? "")} field={r === "cpu" ? "cpu" : "mem"} /> : "",
              },
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
              {taints.map((t) => (
                <Badge key={`${t.key}${t.effect}`} variant="secondary">
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
          <DataTable
            rows={conditions}
            rowKey={(c) => c.type}
            columns={[
              { id: "t", header: "Type", cell: (c) => c.type },
              {
                id: "s",
                header: "Status",
                cell: (c) => <ToneBadge tone={c.status === "True" ? "ok" : c.status === "False" ? "muted" : "warn"}>{c.status}</ToneBadge>,
              },
              { id: "r", header: "Reason", cell: (c) => c.reason ?? "" },
              { id: "m", header: "Message", cell: (c) => c.message ?? "" },
              { id: "a", header: "Since", cell: (c) => age(c.lastTransitionTime) },
            ]}
          />
        </Section>
      )}
    </div>
  );
};

interface EventsProps {
  clusterId: string;
  namespace: string;
  name: string;
}

const Events = ({ clusterId, namespace, name }: EventsProps) => {
  const q = useEventsFor(clusterId, namespace, name);
  const events = (q.data ?? [])
    .slice()
    .sort((a, b) => String(b.lastTimestamp ?? b.eventTime ?? "").localeCompare(String(a.lastTimestamp ?? a.eventTime ?? "")));

  return (
    <div className="h-full overflow-y-auto p-4">
      {q.isLoading && <PanelSkeleton />}
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
                    {(e.count ?? 1) > 1 && <Badge variant="secondary">×{e.count}</Badge>}
                  </TimelineTitle>
                  <TimelineTime className="text-xs">{when ? <RelativeTime date={when} format="short" /> : "—"}</TimelineTime>
                  <TimelineDescription className="text-xs break-words">{e.message}</TimelineDescription>
                </TimelineContent>
              </TimelineItem>
            );
          })}
        </Timeline>
      )}
    </div>
  );
};

interface MetricValueProps {
  k: string;
  field: MetricField;
}

const MetricValue = ({ k, field }: MetricValueProps) => {
  const series = useMetricsStore((s) => s.series[k]);
  if (!series || series.length === 0) return <span className="text-muted-foreground">—</span>;
  const vals = series.map((s) => s[field]);
  const last = vals[vals.length - 1]!;

  return (
    <span className="inline-flex items-center gap-1.5 font-mono">
      <Sparkline
        data={vals}
        variant="area"
        tone="info"
        curve
        label={`${field === "cpu" ? "CPU" : "Memory"} over the last ${vals.length} samples`}
        className="h-5 w-14"
      />
      {field === "cpu" ? formatCpu(last) : formatBytes(last)}
    </span>
  );
};

interface PodsOnNodeProps {
  clusterId: string;
  node: string;
}

const PodsOnNode = ({ clusterId, node }: PodsOnNodeProps) => {
  const q = usePodsOnNode(clusterId, node);
  const open = useDrawer((s) => s.open);
  const setNamespace = useUI((s) => s.setNamespace);
  const pods = q.data ?? [];

  return (
    <Section title={`Pods on this node${q.data ? ` · ${pods.length}` : ""}`}>
      {q.isLoading && <PanelSkeleton />}
      {q.error && <ErrorCallout message={errorMessage(q.error)} />}
      {q.data && pods.length === 0 && <span className="text-xs text-muted-foreground">No pods scheduled here.</span>}
      {pods.length > 0 && (
        <DataTable
          rows={pods}
          rowKey={(p) => p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`}
          onRowClick={(p) => {
            setNamespace(p.metadata?.namespace ?? "");
            open({ gvr: { group: "", version: "v1", resource: "pods" }, namespace: p.metadata?.namespace ?? "", name: p.metadata?.name ?? "", kind: "Pod" });
          }}
          columns={[
            { id: "n", header: "Name", cell: (p) => <span className="font-medium">{p.metadata?.name}</span> },
            { id: "ns", header: "Namespace", cell: (p) => <span className="text-muted-foreground">{p.metadata?.namespace}</span> },
            {
              id: "s",
              header: "Status",
              cell: (p) => {
                const st = podStatus(p);

                return <ToneBadge tone={st.tone}>{st.text}</ToneBadge>;
              },
            },
            { id: "r", header: "Ready", cell: (p) => podReady(p), mono: true },
            {
              id: "cpu",
              header: "CPU",
              cell: (p) => <MetricValue k={metricKey(clusterId, "pods", p.metadata?.namespace ?? "", p.metadata?.name ?? "")} field="cpu" />,
            },
            {
              id: "mem",
              header: "Memory",
              cell: (p) => <MetricValue k={metricKey(clusterId, "pods", p.metadata?.namespace ?? "", p.metadata?.name ?? "")} field="mem" />,
            },
          ]}
        />
      )}
      {q.data && pods.length > 0 && (
        <Callout variant="info" className="py-2">
          <CalloutTitle className="text-xs">Metrics</CalloutTitle>
          <CalloutDescription className="text-xs">
            Usage columns fill in once metrics have been polled for these namespaces (open the Pods page or wait a cycle).
          </CalloutDescription>
        </Callout>
      )}
    </Section>
  );
};
