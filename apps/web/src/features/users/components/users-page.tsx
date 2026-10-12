import { useId, useMemo, useState } from "react";
import { KeyRound, MoreHorizontal, Pencil, Plus, Search, SearchX, ShieldCheck, Trash2, UserCheck, UserPlus, Users, UserX } from "lucide-react";
import { toast } from "sonner";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { hub, errorMessage } from "@/services/api-client";
import { useClusters } from "@/hooks/use-clusters";
import { useGrants } from "@/hooks/use-grants";
import { useRefreshUsers } from "@/features/users/hooks/use-refresh-users";
import { useUsers } from "@/features/users/hooks/use-users";
import { useConfirm } from "@/components/confirm";
import { HubShell, initials } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/relative-time";
import { DeniedState, ErrorCallout, PanelSkeleton } from "@/components/status";
import { DataTable, type Column } from "@/components/data-table";
import { ToneBadge } from "@/components/tone";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { denialFromError } from "@/lib/denial";
import { useSession } from "@/stores/session";
import type { Cluster, ClusterGrant, User } from "@/gen/kmate/v1/hub_pb";

const ROLES = ["viewer", "operator", "admin"] as const;

interface RoleBadgeProps {
  role: string;
}

const RoleBadge = ({ role }: RoleBadgeProps) => {
  const tone = role === "admin" ? "default" : role === "operator" ? "secondary" : "outline";

  return (
    <Badge variant={tone}>{role}</Badge>
  );
};

/** Admin-only directory of accounts and their cluster grants. */
export const UsersPage = () => {
  const me = useSession((s) => s.user);
  const users = useUsers();
  const refresh = useRefreshUsers();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [granting, setGranting] = useState<User | null>(null);
  const [password, setPassword] = useState<User | null>(null);
  const [q, setQ] = useState("");
  const confirm = useConfirm();

  const denial = denialFromError(users.error);
  const all = useMemo(() => users.data ?? [], [users.data]);
  const activeAdmins = useMemo(() => all.filter((u) => u.role === "admin" && u.active).length, [all]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();

    return t ? all.filter((u) => `${u.email} ${u.name} ${u.role}`.toLowerCase().includes(t)) : all;
  }, [all, q]);

  const setActive = async (u: User, active: boolean) => {
    const run = async () => {
      await hub.updateUser({ id: u.id, active, activeSet: true });
      toast.success(active ? `Activated ${u.email}` : `Deactivated ${u.email}`);
      refresh();
    };
    if (active) {
      try {
        await run();
      } catch (e) {
        toast.error(errorMessage(e));
      }

      return;
    }
    await confirm({
      title: `Deactivate ${u.email}?`,
      description: "They are signed out and cannot sign in until an administrator activates the account again. Their grants are kept.",
      confirmText: "Deactivate user",
      tone: "destructive",
      onConfirm: run,
    });
  };

  const remove = (u: User) =>
    confirm({
      title: `Delete ${u.email}?`,
      description: "Their account and every cluster grant are removed. This cannot be undone.",
      confirmText: "Delete user",
      tone: "destructive",
      onConfirm: async () => {
        await hub.deleteUser({ id: u.id });
        toast.success(`Deleted ${u.email}`);
        refresh();
      },
    });

  const columns: Column<User>[] = [
    {
      id: "user",
      header: "User",
      width: "minmax(240px,2fr)",
      value: (u) => u.email,
      cell: (u) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-8">
            <AvatarFallback>{initials(u.name || u.email)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">
              {u.name || u.email}
              {u.id === me?.id && <span className="ms-1 font-normal text-muted-foreground">(you)</span>}
            </span>
            {u.name && <span className="truncate text-xs text-muted-foreground">{u.email}</span>}
          </div>
        </div>
      ),
    },
    { id: "role", header: "Role", width: "120px", value: (u) => u.role, cell: (u) => <RoleBadge role={u.role} /> },
    {
      id: "identity",
      header: "Kubernetes identity",
      width: "minmax(180px,1.5fr)",
      value: (u) => u.k8sUser || u.email,
      cell: (u) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono">{u.k8sUser || u.email}</span>
          {u.k8sGroups.length > 0 && <span className="truncate text-xs text-muted-foreground">{u.k8sGroups.join(", ")}</span>}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "130px",
      value: (u) => (u.active ? "Active" : "Deactivated"),
      cell: (u) => (
        <ToneBadge tone={u.active ? "ok" : "muted"} dot>
          {u.active ? "Active" : "Deactivated"}
        </ToneBadge>
      ),
    },
    {
      id: "created",
      header: "Created",
      width: "130px",
      value: (u) => (u.createdAt ? -timestampDate(u.createdAt).getTime() : undefined),
      title: (u) => (u.createdAt ? timestampDate(u.createdAt).toLocaleString() : undefined),
      cell: (u) => <span className="text-muted-foreground">{u.createdAt ? <RelativeTime date={timestampDate(u.createdAt)} format="short" /> : "—"}</span>,
    },
    {
      id: "actions",
      header: "",
      width: "56px",
      cell: (u) => {
        const lastAdmin = u.role === "admin" && u.active && activeAdmins <= 1;
        const guard = u.id === me?.id ? "This is your own account" : lastAdmin ? "This is the last active administrator" : null;

        return (
          // Row clicks open the editor; the menu must not.
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.email}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => setEditing(u)}>
                  <Pencil /> Edit…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setGranting(u)}>
                  <ShieldCheck /> Cluster access…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPassword(u)}>
                  <KeyRound /> Set password…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <Guarded reason={guard}>
                  <DropdownMenuItem disabled={!!guard} onSelect={() => void setActive(u, !u.active)}>
                    {u.active ? <UserX /> : <UserCheck />} {u.active ? "Deactivate…" : "Activate"}
                  </DropdownMenuItem>
                </Guarded>
                <Guarded reason={guard}>
                  <DropdownMenuItem variant="destructive" disabled={!!guard} onSelect={() => void remove(u)}>
                    <Trash2 /> Delete…
                  </DropdownMenuItem>
                </Guarded>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return (
    <HubShell>
      <PageHeader
        title="Users"
        description="Who can sign in to this hub. The role sets what they may do in KMate; each cluster's RBAC still decides what they may do there."
        actions={
          !denial && (
            <Button onClick={() => setCreating(true)}>
              <UserPlus /> Add user
            </Button>
          )
        }
      />
      {denial ? (
        <DeniedState denial={denial} what="manage users" />
      ) : (
        <div className="flex flex-col gap-4">
          <ErrorCallout message={users.error ? errorMessage(users.error) : null} />
          <InputGroup className="max-w-sm">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search users…" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
          </InputGroup>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(u) => u.id}
            rowLabel={(u) => `Edit ${u.email}`}
            onRowClick={setEditing}
            loading={users.isLoading}
            emptyIcon={q ? <SearchX /> : <Users />}
            emptyTitle={q ? `No users match "${q}"` : "No users yet"}
            emptyHint={q ? "Try a different search, or clear it." : undefined}
          />
        </div>
      )}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} onDone={refresh} />}
      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {granting && <GrantsDialog user={granting} onClose={() => setGranting(null)} onDone={refresh} />}
      {password && <PasswordDialog user={password} onClose={() => setPassword(null)} />}
    </HubShell>
  );
};

interface GuardedProps {
  reason: string | null;
  children: React.ReactNode;
}

/** Wraps a disabled menu item so the reason is visible on hover. */
const Guarded = ({ reason, children }: GuardedProps) => {
  if (!reason) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{children}</div>
      </TooltipTrigger>
      <TooltipContent side="left">{reason}</TooltipContent>
    </Tooltip>
  );
};

interface CreateUserDialogProps {
  onClose: () => void;
  onDone: () => void;
}

const CreateUserDialog = ({ onClose, onDone }: CreateUserDialogProps) => {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await hub.createUser({ email: email.trim(), name: name.trim(), password: pw, role });
      toast.success(`Created ${email.trim()}`);
      onDone();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>They sign in with this email and password. Give them cluster access afterwards.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
            <Input id={`${id}-email`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" autoFocus />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
            <Input id={`${id}-password`} type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
            <RoleSelect id={`${id}-role`} value={role} onChange={setRole} />
            <FieldDescription>Admins manage users and clusters. Operators may change resources where granted.</FieldDescription>
          </Field>
          <ErrorCallout message={err} title="Could not create the user" />
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !email.trim() || pw.length < 8}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface EditUserDialogProps {
  user: User;
  onClose: () => void;
  onDone: () => void;
}

const EditUserDialog = ({ user, onClose, onDone }: EditUserDialogProps) => {
  const me = useSession((s) => s.user);
  const self = user.id === me?.id;
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [k8sUser, setK8sUser] = useState(user.k8sUser);
  const [groups, setGroups] = useState(user.k8sGroups.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await hub.updateUser({
        id: user.id,
        name, nameSet: true,
        role, roleSet: !self && role !== user.role,
        k8sUser, k8sUserSet: true,
        k8sGroups: groups.split(",").map((g) => g.trim()).filter(Boolean), k8sGroupsSet: true,
      });
      toast.success(`Updated ${user.email}`);
      onDone();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user.email}</DialogTitle>
          <DialogDescription>The Kubernetes identity is who the agent impersonates on the user's behalf.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
            <RoleSelect id={`${id}-role`} value={role} onChange={setRole} disabled={self} />
            {self && <FieldDescription>You cannot change your own role.</FieldDescription>}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-k8s-user`}>Kubernetes user</FieldLabel>
            <Input id={`${id}-k8s-user`} value={k8sUser} onChange={(e) => setK8sUser(e.target.value)} placeholder={user.email} />
            <FieldDescription>Leave empty to impersonate their email address.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-k8s-groups`}>Kubernetes groups</FieldLabel>
            <Input id={`${id}-k8s-groups`} value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="kmate:viewer, platform-team" />
            <FieldDescription>Comma separated. Bind these in the cluster with a RoleBinding.</FieldDescription>
          </Field>
          <ErrorCallout message={err} title="Could not save" />
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface PasswordDialogProps {
  user: User;
  onClose: () => void;
}

const PasswordDialog = ({ user, onClose }: PasswordDialogProps) => {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set password for {user.email}</DialogTitle>
          <DialogDescription>They can change it themselves afterwards from Settings.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-password`}>New password</FieldLabel>
            <Input id={`${id}-password`} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
            <FieldDescription>At least 8 characters.</FieldDescription>
          </Field>
          <ErrorCallout message={err} title="Could not set the password" />
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || pw.length < 8}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await hub.setPassword({ userId: user.id, newPassword: pw });
                toast.success("Password set");
                onClose();
              } catch (e) {
                setErr(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Set password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface GrantsDialogProps {
  user: User;
  onClose: () => void;
  onDone: () => void;
}

/** Grant a user access to clusters, optionally narrowed to namespaces. */
const GrantsDialog = ({ user, onClose, onDone }: GrantsDialogProps) => {
  const { clusters } = useClusters();
  const grants = useGrants(user.id);
  const [adding, setAdding] = useState(false);

  const confirm = useConfirm();
  const revoke = (g: ClusterGrant) => {
    const name = g.clusterName || g.clusterId;

    return confirm({
      title: `Revoke ${user.email}'s access to ${name}?`,
      description: "The cluster disappears for them straight away. You can grant it again later.",
      confirmText: "Revoke access",
      tone: "destructive",
      onConfirm: async () => {
        await hub.deleteGrant({ userId: user.id, clusterId: g.clusterId });
        toast.success(`Revoked ${user.email}'s access to ${name}`);
        void grants.refetch();
        onDone();
      },
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cluster access for {user.email}</DialogTitle>
          <DialogDescription>
            {user.role === "admin"
              ? "This user is a KMate administrator, so they already reach every cluster."
              : "Without a grant a cluster is invisible to them. Leave namespaces empty for the whole cluster."}
          </DialogDescription>
        </DialogHeader>

        {grants.isLoading && <PanelSkeleton lines={3} />}
        {grants.data && grants.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cluster</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Namespaces</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.data.map((g) => (
                <TableRow key={g.id}>
                  <TableCell>{g.clusterName || g.clusterId}</TableCell>
                  <TableCell>
                    <RoleBadge role={g.role} />
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{g.namespaces.length ? g.namespaces.join(", ") : "all namespaces"}</span>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label={`Revoke access to ${g.clusterName || g.clusterId}`} onClick={() => void revoke(g)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {grants.data && grants.data.length === 0 && <p className="text-xs text-muted-foreground">No cluster access yet.</p>}

        {adding ? (
          <AddGrant
            userId={user.id}
            clusters={clusters.map((c) => ({ id: c.id, name: c.name }))}
            onClose={() => setAdding(false)}
            onDone={() => {
              void grants.refetch();
              onDone();
            }}
          />
        ) : (
          <Button variant="outline" size="sm" className="self-start" onClick={() => setAdding(true)}>
            <Plus /> Grant a cluster
          </Button>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface AddGrantProps {
  userId: string;
  clusters: Pick<Cluster, "id" | "name">[];
  onClose: () => void;
  onDone: () => void;
}

const AddGrant = ({ userId, clusters, onClose, onDone }: AddGrantProps) => {
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? "");
  const [role, setRole] = useState("viewer");
  const [all, setAll] = useState(true);
  const [namespaces, setNamespaces] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await hub.setGrant({
        userId,
        clusterId,
        role,
        namespaces: all ? [] : namespaces.split(",").map((n) => n.trim()).filter(Boolean),
      });
      toast.success("Access granted");
      onDone();
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-cluster`}>Cluster</FieldLabel>
          <Select value={clusterId} onValueChange={setClusterId}>
            <SelectTrigger id={`${id}-cluster`} size="sm" className="w-full">
              <SelectValue placeholder="Pick a cluster" />
            </SelectTrigger>
            <SelectContent>
              {clusters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-role`}>Role</FieldLabel>
          <RoleSelect id={`${id}-role`} value={role} onChange={setRole} />
        </Field>
      </div>
      <Field orientation="horizontal">
        <Checkbox id={`${id}-all`} checked={all} onCheckedChange={(v) => setAll(!!v)} />
        <FieldLabel htmlFor={`${id}-all`}>Every namespace</FieldLabel>
      </Field>
      {!all && (
        <Field>
          <FieldLabel htmlFor={`${id}-namespaces`}>Namespaces</FieldLabel>
          <Input id={`${id}-namespaces`} value={namespaces} onChange={(e) => setNamespaces(e.target.value)} placeholder="shop, payments" />
          <FieldDescription>Comma separated. They cannot read anything outside these.</FieldDescription>
        </Field>
      )}
      <ErrorCallout message={err} title="Could not grant access" />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy || !clusterId || (!all && !namespaces.trim())}>
          Grant
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

interface RoleSelectProps {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

const RoleSelect = ({ id, value, onChange, disabled }: RoleSelectProps) => {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {r}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
