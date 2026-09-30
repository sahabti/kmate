import { useMemo, useState } from "react";
import { ExternalLink, Terminal } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, openPortForward } from "@/api/client";
import { usePodsForSelector } from "@/api/hooks";
import { CopyButton } from "@/components/copy-button";
import { Spinner } from "@/components/spinner";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { podStatus, type KObj } from "@/lib/k8s";

interface PortOption {
  id: string;
  label: string;
  port: number; // container/target port on the pod
  servicePort?: number;
}

function podPorts(pod: KObj): PortOption[] {
  const out: PortOption[] = [];
  for (const c of pod.spec?.containers ?? []) {
    for (const p of c.ports ?? []) {
      const port = Number(p.containerPort);
      if (!port) continue;
      out.push({ id: `${c.name}:${port}`, label: `${port}${p.name ? ` (${p.name})` : ""} · ${c.name}`, port });
    }
  }
  return out;
}

function resolveTargetPort(pod: KObj | undefined, target: string | number | undefined, fallback: number): number {
  if (typeof target === "number") return target;
  if (typeof target === "string" && /^\d+$/.test(target)) return Number(target);
  if (typeof target === "string" && pod) {
    for (const c of pod.spec?.containers ?? []) for (const p of c.ports ?? []) if (p.name === target) return Number(p.containerPort);
  }
  return fallback;
}

/**
 * Port-forward dialog for a Pod or a Service. Opens the hub's HTTP proxy in a
 * new tab, which is what web/mobile can do without a local listener.
 */
export function PortForwardDialog({ open, onClose, clusterId, obj }: { open: boolean; onClose: () => void; clusterId: string; obj: KObj }) {
  const isService = obj.kind === "Service";
  const namespace = obj.metadata?.namespace ?? "";
  const pods = usePodsForSelector(clusterId, namespace, obj.spec?.selector, open && isService);
  const readyPod = useMemo(() => (pods.data ?? []).find((p) => podStatus(p).tone === "ok") ?? (pods.data ?? [])[0], [pods.data]);
  const targetPod = isService ? readyPod : obj;
  const options: PortOption[] = useMemo(() => {
    if (!isService) return podPorts(obj);
    return (obj.spec?.ports ?? []).map((p: any) => {
      const port = resolveTargetPort(readyPod, p.targetPort, Number(p.port));
      return { id: `${p.port}`, label: `${p.port}${p.name ? ` (${p.name})` : ""} → ${port}`, port, servicePort: Number(p.port) };
    });
  }, [isService, obj, readyPod]);
  const [sel, setSel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const chosen = options.find((o) => o.id === sel) ?? options[0];
  const podName = targetPod?.metadata?.name ?? "";
  const kubectl = isService
    ? `kubectl -n ${namespace} port-forward svc/${obj.metadata?.name} ${chosen?.servicePort ?? chosen?.port ?? 8080}:${chosen?.servicePort ?? chosen?.port ?? 8080}`
    : `kubectl -n ${namespace} port-forward pod/${obj.metadata?.name} ${chosen?.port ?? 8080}:${chosen?.port ?? 8080}`;

  const go = async () => {
    if (!chosen || !podName) return;
    setBusy(true);
    try {
      await openPortForward(clusterId, namespace, podName, chosen.port);
      toast.success(`Port-forward opened to ${podName}:${chosen.port}`);
      onClose();
    } catch (e) {
      toast.error("Port-forward failed", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Port-forward {obj.kind}/{obj.metadata?.name}</DialogTitle>
          <DialogDescription>Traffic is tunnelled through the hub and the in-cluster agent. Opens in a new tab.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isService && pods.isLoading && <Spinner size="sm" label="Resolving backing pod" />}
          {isService && pods.data && !readyPod && (
            <Callout variant="warning" className="py-2">
              <CalloutTitle>No pods match this service's selector</CalloutTitle>
              <CalloutDescription>Nothing to forward to.</CalloutDescription>
            </Callout>
          )}
          {options.length === 0 ? (
            <Callout variant="info" className="py-2">
              <CalloutTitle>No ports declared</CalloutTitle>
              <CalloutDescription>The {obj.kind} declares no ports. Use the kubectl command with a port of your choice.</CalloutDescription>
            </Callout>
          ) : (
            <Field>
              <FieldLabel>Port</FieldLabel>
              <Select value={chosen?.id ?? ""} onValueChange={setSel}>
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue placeholder="Choose a port" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id} className="font-mono text-xs">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {isService && readyPod && (
            <p className="text-xs text-muted-foreground">
              Target pod: <span className="font-mono">{podName}</span>
            </p>
          )}
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={kubectl}>
              {kubectl}
            </span>
            <CopyButton value={kubectl} size="sm" variant="ghost" aria-label="Copy kubectl command" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void go()} disabled={busy || !chosen || !podName}>
            {busy ? <Spinner size="sm" /> : <ExternalLink />} Open in new tab
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
