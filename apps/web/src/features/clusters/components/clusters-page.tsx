import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ArrowRight, KeyRound, MoreHorizontal, Plus, Search, Server, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { hub, errorMessage } from "@/services/api-client";
import { useClusters } from "@/hooks/use-clusters";
import { CodeBlock, CodeBlockContent, CodeBlockHeader } from "@/components/code-block";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/callout";
import { CopyButton } from "@/components/copy-button";
import { HubShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { EmptyState, ErrorCallout } from "@/components/status";
import { DataTable, type Column } from "@/components/data-table";
import { ToneBadge } from "@/components/tone";
import { statusTone } from "@/lib/cluster-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useConfirm } from "@/components/confirm";
import { Spinner } from "@/components/spinner";
import { type Cluster, type CreateClusterResponse, type IssueEnrollmentTokenResponse } from "@/gen/kmate/v1/hub_pb";
import { useSession } from "@/stores/session";

export const ClustersPage = () => {
  const { clusters, loaded, error } = useClusters();
  const [adding, setAdding] = useState(false);
  const [reissue, setReissue] = useState<Cluster | null>(null);
  const [q, setQ] = useState("");
  const isAdmin = useSession((s) => s.user?.role) === "admin";
  const confirm = useConfirm();
  const nav = useNavigate();

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();

    return t ? clusters.filter((c) => `${c.name} ${c.info?.platform ?? ""} ${c.info?.kubernetesVersion ?? ""}`.toLowerCase().includes(t)) : clusters;
  }, [clusters, q]);

  const remove = (c: Cluster) =>
    confirm({
      title: `Remove cluster ${c.name}?`,
      description: "Everyone loses access to it through KMate, and its agent is rejected until it is enrolled again. Nothing changes inside the cluster itself.",
      confirmText: "Remove cluster",
      tone: "destructive",
      typeToConfirm: c.name,
      onConfirm: async () => {
        await hub.deleteCluster({ id: c.id });
        toast.success(`Removed cluster ${c.name}`);
      },
    });

  const columns: Column<Cluster>[] = [
    {
      id: "name",
      header: "Name",
      width: "minmax(220px,2fr)",
      value: (c) => c.name,
      cell: (c) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{c.name}</span>
          <span className="truncate text-xs text-muted-foreground">{c.info?.platform || "kubernetes"}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "130px",
      value: (c) => statusTone(c.status).label,
      cell: (c) => {
        const st = statusTone(c.status);

        return (
          <ToneBadge tone={st.tone} dot>
            {st.label}
          </ToneBadge>
        );
      },
    },
    { id: "version", header: "Version", width: "120px", mono: true, value: (c) => c.info?.kubernetesVersion || undefined, cell: (c) => c.info?.kubernetesVersion || "—" },
    { id: "nodes", header: "Nodes", width: "90px", numeric: true, value: (c) => c.info?.nodeCount ?? 0, cell: (c) => c.info?.nodeCount ?? 0 },
    { id: "pods", header: "Pods", width: "90px", numeric: true, value: (c) => c.info?.podCount ?? 0, cell: (c) => c.info?.podCount ?? 0 },
    {
      id: "heartbeat",
      header: "Last heartbeat",
      width: "150px",
      value: (c) => (c.lastHeartbeat ? -timestampDate(c.lastHeartbeat).getTime() : undefined),
      title: (c) => (c.lastHeartbeat ? timestampDate(c.lastHeartbeat).toLocaleString() : undefined),
      cell: (c) => <span className="text-muted-foreground">{c.lastHeartbeat ? <RelativeTime date={timestampDate(c.lastHeartbeat)} format="short" /> : "Never"}</span>,
    },
    {
      id: "actions",
      header: "",
      width: "56px",
      cell: (c) => (
        // Row clicks open the cluster; the menu must not.
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${c.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onSelect={() => void nav({ to: "/c/$clusterId", params: { clusterId: c.id } })}>
                <ArrowRight /> Open cluster
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onSelect={() => setReissue(c)}>
                  <KeyRound /> Issue new enrollment token…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(c)}>
                <Trash2 /> Remove cluster…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <HubShell>
      <PageHeader
        title="Clusters"
        description="Pick a cluster to work in. Each one is reached through its own KMate agent."
        actions={
          isAdmin && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add cluster
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-4">
        <ErrorCallout message={error} />
        {loaded && clusters.length === 0 ? (
          // An admin sees none because none exist yet. Anyone else sees none
          // because nothing has been granted to them, which is a different
          // problem and needs different advice.
          isAdmin ? (
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
          ) : (
            <EmptyState icon={<Server />} title="No clusters available to you" hint="Clusters appear here once an administrator grants you access to one. Your KMate role is listed under Settings." />
          )
        ) : (
          <>
            <InputGroup className="max-w-sm">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput placeholder="Search clusters…" aria-label="Search clusters" value={q} onChange={(e) => setQ(e.target.value)} />
            </InputGroup>
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(c) => c.id}
              rowLabel={(c) => `Open cluster ${c.name}`}
              onRowClick={(c) => void nav({ to: "/c/$clusterId", params: { clusterId: c.id } })}
              loading={!loaded}
              empty={
                <EmptyState
                  title={`No clusters match "${q}"`}
                  action={
                    <Button variant="outline" onClick={() => setQ("")}>
                      Clear search
                    </Button>
                  }
                />
              }
            />
          </>
        )}
      </div>

      <AddClusterDialog open={adding} onClose={() => setAdding(false)} />
      {reissue && <ReissueTokenDialog cluster={reissue} open onOpenChange={(o) => !o && setReissue(null)} />}
    </HubShell>
  );
};

interface EnrollmentDetailsProps {
  token: string;
  helmCommand: string;
}

/** Token plus install command, shared by "Add cluster" and "Issue new token". */
const EnrollmentDetails = ({ token, helmCommand }: EnrollmentDetailsProps) => {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Enrollment token</span>
          <CopyButton value={token} size="sm" label="Copy" />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all">
          <Badge variant="outline">24h · single use</Badge>
          {token}
        </div>
      </div>
      <CodeBlock code={helmCommand} language="bash" filename="install-agent.sh" showLineNumbers={false} wrap>
        <CodeBlockHeader />
        <CodeBlockContent />
      </CodeBlock>
      <Callout variant="info" title="Local development">
        <CalloutTitle>Running the agent outside the cluster?</CalloutTitle>
        <CalloutDescription className="space-y-2">
          <p>From the repo root, with your kubeconfig pointing at the cluster:</p>
          <CodeBlock code={`KMATE_ENROLLMENT_TOKEN=${token} make agent-local`} language="bash" showLineNumbers={false} wrap>
            <CodeBlockHeader />
            <CodeBlockContent />
          </CodeBlock>
        </CalloutDescription>
      </Callout>
    </div>
  );
};

interface ReissueTokenDialogProps {
  cluster: Cluster;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/** Mints a replacement token for a cluster whose agent has lost its identity. */
const ReissueTokenDialog = ({ cluster, open, onOpenChange }: ReissueTokenDialogProps) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<IssueEnrollmentTokenResponse | null>(null);

  const issue = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await hub.issueEnrollmentToken({ clusterId: cluster.id }));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onOpenChange(false);
    setTimeout(() => { setResult(null); setErr(null); }, 200);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>New enrollment token for "{cluster.name}"</DialogTitle>
          <DialogDescription>
            Enrollment tokens are single use. Issue a new one only when an agent has lost its stored
            identity and cannot reconnect. A running agent never needs one.
          </DialogDescription>
        </DialogHeader>
        {err && <ErrorCallout message={err} />}
        {result ? (
          <>
            <EnrollmentDetails token={result.enrollmentToken} helmCommand={result.helmCommand} />
            <DialogFooter><Button onClick={close}>Done</Button></DialogFooter>
          </>
        ) : (
          <>
            <Callout variant="warning">
              <CalloutDescription>
                Any outstanding unused token for this cluster stops working immediately.
              </CalloutDescription>
            </Callout>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button onClick={issue} disabled={busy}>{busy && <Spinner size="sm" />} Issue token</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};


interface AddClusterDialogProps {
  open: boolean;
  onClose: () => void;
}

const AddClusterDialog = ({ open, onClose }: AddClusterDialogProps) => {
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
            <EnrollmentDetails token={result.enrollmentToken} helmCommand={result.helmCommand} />
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
