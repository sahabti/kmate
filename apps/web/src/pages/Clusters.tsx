import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Boxes, Cpu, FolderTree, MoreHorizontal, Plus, Server, Settings, Trash2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { hub, errorMessage } from "@/api/client";
import { useClusters } from "@/api/hooks";
import { CodeBlock, CodeBlockContent, CodeBlockHeader } from "@/components/code-block";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, ErrorCallout, Loading } from "@/components/status";
import { ToneBadge, type Tone } from "@/components/tone";
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
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/spinner";
import { ClusterStatus, type Cluster, type CreateClusterResponse } from "@/gen/kmate/v1/hub_pb";
import { useSession } from "@/store/session";

export function statusTone(s: ClusterStatus): { tone: Tone; label: string } {
  switch (s) {
    case ClusterStatus.ONLINE:
      return { tone: "ok", label: "Online" };
    case ClusterStatus.OFFLINE:
      return { tone: "bad", label: "Offline" };
    case ClusterStatus.PENDING:
      return { tone: "warn", label: "Pending" };
    default:
      return { tone: "muted", label: "Unknown" };
  }
}

export function ClustersPage() {
  const { clusters, loaded, error } = useClusters();
  const [adding, setAdding] = useState(false);
  const user = useSession((s) => s.user);
  const nav = useNavigate();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Waypoints className="size-5" />
          </div>
          <div>
            <h1 className="text-base leading-tight font-semibold">Clusters</h1>
            <div className="text-xs text-muted-foreground">{user?.email}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Settings">
            <Link to="/settings">
              <Settings />
            </Link>
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> Add cluster
          </Button>
        </div>
      </header>

      <ErrorCallout message={error} />
      {!loaded && <Loading label="Loading clusters…" />}
      {loaded && clusters.length === 0 && (
        <EmptyState
          icon={<Server />}
          title="No clusters yet"
          hint="Register a cluster to get an enrollment token, then install the KMate agent with Helm. The agent dials out to this hub; no kubeconfig needed here."
          action={
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add cluster
            </Button>
          }
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {clusters.map((c) => (
          <ClusterCard key={c.id} c={c} onOpen={() => nav({ to: "/c/$clusterId", params: { clusterId: c.id } })} />
        ))}
      </div>

      <AddClusterDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function ClusterCard({ c, onOpen }: { c: Cluster; onOpen: () => void }) {
  const st = statusTone(c.status);
  const info = c.info;
  const hb = c.lastHeartbeat ? timestampDate(c.lastHeartbeat) : null;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const del = async () => {
    setBusy(true);
    try {
      await hub.deleteCluster({ id: c.id });
      toast.success(`Removed cluster ${c.name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="cursor-pointer gap-3 py-4 transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <CardHeader className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <div className="truncate font-semibold">{c.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {info?.platform || "kubernetes"} · {info?.kubernetesVersion || "—"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <ToneBadge tone={st.tone} dot>
            {st.label}
          </ToneBadge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon-xs" aria-label="Cluster actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
                <Trash2 /> Remove cluster
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-2 px-4">
        <MiniStat icon={Cpu} label="Nodes" value={info?.nodeCount ?? 0} />
        <MiniStat icon={Boxes} label="Pods" value={info?.podCount ?? 0} />
        <MiniStat icon={FolderTree} label="Namespaces" value={info?.namespaceCount ?? 0} />
      </CardContent>
      <CardFooter className="flex items-center justify-between px-4 text-[11px] text-muted-foreground">
        <span>
          Heartbeat {hb ? <RelativeTime date={hb} format="short" /> : "never"}
        </span>
        {c.sharedIdentity && (
          <ToneBadge tone="warn" title="Agent cannot impersonate users; hub roles only">
            shared identity
          </ToneBadge>
        )}
      </CardFooter>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove cluster "{c.name}"?</AlertDialogTitle>
            <AlertDialogDescription>The agent will be rejected until re-enrolled. Nothing is changed inside the cluster itself.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={(e) => { e.preventDefault(); void del(); }}>
              {busy ? <Spinner size="sm" /> : <Trash2 />} Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: number | string }) {
  return (
    <div className="rounded-md border bg-muted/40 px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] tracking-wide text-muted-foreground uppercase">
        <Icon className="size-3" /> {label}
      </div>
      <div className="font-mono text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function AddClusterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CreateClusterResponse | null>(null);

  const close = () => {
    setName("");
    setResult(null);
    setErr(null);
    onClose();
  };
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await hub.createCluster({ name }));
      toast.success("Cluster registered. Install the agent to bring it online.");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{result ? "Install the agent" : "Add cluster"}</DialogTitle>
          <DialogDescription>
            {result
              ? "Run this on a machine with access to the cluster. The agent dials out to the hub; no inbound ports are needed."
              : "Give the cluster a display name. You will get a one-time enrollment token and a Helm command."}
          </DialogDescription>
        </DialogHeader>
        {!result ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void create();
            }}
          >
            <ErrorCallout message={err} />
            <Field>
              <FieldLabel htmlFor="cluster-name">Cluster name</FieldLabel>
              <Input id="cluster-name" placeholder="e.g. prod-eu-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Spinner size="sm" />} Create
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Enrollment token</span>
                <CopyButton value={result.enrollmentToken} size="sm" label="Copy" />
              </div>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] break-all">
                <Badge variant="outline" className="shrink-0 rounded-md text-[10px]">
                  24h
                </Badge>
                {result.enrollmentToken}
              </div>
            </div>
            <CodeBlock code={result.helmCommand} language="bash" filename="install-agent.sh" showLineNumbers={false} wrap>
              <CodeBlockHeader />
              <CodeBlockContent />
            </CodeBlock>
            <Callout variant="info" title="Local development">
              <CalloutTitle>Running the agent outside the cluster?</CalloutTitle>
              <CalloutDescription className="space-y-2">
                <p>From the repo root, with your kubeconfig pointing at the cluster:</p>
                <CodeBlock code={`KMATE_ENROLLMENT_TOKEN=${result.enrollmentToken} make agent-local`} language="bash" showLineNumbers={false} wrap>
                  <CodeBlockHeader />
                  <CodeBlockContent />
                </CodeBlock>
              </CalloutDescription>
            </Callout>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
