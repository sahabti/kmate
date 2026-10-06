import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, KeyRound, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { hub, errorMessage } from "@/api/client";
import { useClusters, useGrants, useRefreshUsers, useUsers } from "@/api/hooks";
import { RelativeTime } from "@/components/relative-time";
import { DeniedState, ErrorCallout, Loading } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { denialFromError } from "@/lib/denial";
import { useSession } from "@/store/session";
import type { ClusterGrant, User } from "@/gen/kmate/v1/hub_pb";

const ROLES = ["viewer", "operator", "admin"] as const;

function RoleBadge({ role }: { role: string }) {
  const tone = role === "admin" ? "default" : role === "operator" ? "secondary" : "outline";
  return (
    <Badge variant={tone} className="rounded-md">
      {role}
    </Badge>
  );
}

/** Admin-only directory of accounts and their cluster grants. */
export function UsersPage() {
  const me = useSession((s) => s.user);
  const users = useUsers();
  const refresh = useRefreshUsers();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [granting, setGranting] = useState<User | null>(null);
  const [password, setPassword] = useState<User | null>(null);
  const [removing, setRemoving] = useState<User | null>(null);

  const denial = denialFromError(users.error);
  const activeAdmins = useMemo(() => (users.data ?? []).filter((u) => u.role === "admin" && u.active).length, [users.data]);

  const setActive = async (u: User, active: boolean) => {
    try {
      await hub.updateUser({ id: u.id, active, activeSet: true });
      toast.success(active ? `${u.email} activated` : `${u.email} deactivated`);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings">
            <ArrowLeft /> Settings
          </Link>
        </Button>
        <h1 className="text-base font-semibold">Users</h1>
        <Button size="sm" className="ml-auto" onClick={() => setCreating(true)} disabled={!!denial}>
          <UserPlus /> Add user
        </Button>
      </div>

      {denial ? (
        <DeniedState denial={denial} what="manage users" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Accounts on this hub</CardTitle>
            <CardDescription>
              A role here decides what someone may do in KMate. What they may do in a cluster is still decided by that cluster's own RBAC.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {users.isLoading && <Loading label="Loading users…" />}
            <ErrorCallout message={users.error && !denial ? errorMessage(users.error) : null} />
            {users.data && (
              <Table className="text-xs">
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Kubernetes identity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.data.map((u) => {
                    const self = u.id === me?.id;
                    const lastAdmin = u.role === "admin" && u.active && activeAdmins <= 1;
                    const guard = self ? "This is your own account" : lastAdmin ? "This is the last active administrator" : null;
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-mono">
                          {u.email}
                          {self && <span className="ml-1 text-muted-foreground">(you)</span>}
                        </TableCell>
                        <TableCell>{u.name || "—"}</TableCell>
                        <TableCell>
                          <RoleBadge role={u.role} />
                        </TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                          {u.k8sUser || u.email}
                          {u.k8sGroups.length > 0 && <span className="block opacity-70">{u.k8sGroups.join(", ")}</span>}
                        </TableCell>
                        <TableCell>
                          {u.active ? <span className="text-success">active</span> : <span className="text-muted-foreground">deactivated</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{u.createdAt ? <RelativeTime date={timestampDate(u.createdAt)} format="short" /> : "—"}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.email}`}>
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-48">
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
                                  {u.active ? "Deactivate" : "Activate"}
                                </DropdownMenuItem>
                              </Guarded>
                              <Guarded reason={guard}>
                                <DropdownMenuItem variant="destructive" disabled={!!guard} onSelect={() => setRemoving(u)}>
                                  <Trash2 /> Delete…
                                </DropdownMenuItem>
                              </Guarded>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {creating && <CreateUserDialog onClose={() => setCreating(false)} onDone={refresh} />}
      {editing && <EditUserDialog user={editing} onClose={() => setEditing(null)} onDone={refresh} />}
      {granting && <GrantsDialog user={granting} onClose={() => setGranting(null)} onDone={refresh} />}
      {password && <PasswordDialog user={password} onClose={() => setPassword(null)} />}
      {removing && (
        <AlertDialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {removing.email}?</AlertDialogTitle>
              <AlertDialogDescription>Their account and every cluster grant are removed. This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={async () => {
                  try {
                    await hub.deleteUser({ id: removing.id });
                    toast.success(`Deleted ${removing.email}`);
                    refresh();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  }
                  setRemoving(null);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/** Wraps a disabled menu item so the reason is visible on hover. */
function Guarded({ reason, children }: { reason: string | null; children: React.ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{children}</div>
      </TooltipTrigger>
      <TooltipContent side="left">{reason}</TooltipContent>
    </Tooltip>
  );
}

function CreateUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <div className="space-y-3">
          <Field label="Email">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@example.com" autoFocus />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
          </Field>
          <Field label="Password" hint="At least 8 characters.">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Role" hint="Admins manage users and clusters. Operators may change resources where granted.">
            <RoleSelect value={role} onChange={setRole} />
          </Field>
          <ErrorCallout message={err} title="Could not create the user" />
        </div>
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
}

function EditUserDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const me = useSession((s) => s.user);
  const self = user.id === me?.id;
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [k8sUser, setK8sUser] = useState(user.k8sUser);
  const [groups, setGroups] = useState(user.k8sGroups.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Role" hint={self ? "You cannot change your own role." : undefined}>
            <RoleSelect value={role} onChange={setRole} disabled={self} />
          </Field>
          <Field label="Kubernetes user" hint="Leave empty to impersonate their email address.">
            <Input value={k8sUser} onChange={(e) => setK8sUser(e.target.value)} placeholder={user.email} className="font-mono" />
          </Field>
          <Field label="Kubernetes groups" hint="Comma separated. Bind these in the cluster with a RoleBinding.">
            <Input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="kmate:viewer, platform-team" className="font-mono" />
          </Field>
          <ErrorCallout message={err} title="Could not save" />
        </div>
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
}

function PasswordDialog({ user, onClose }: { user: User; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set password for {user.email}</DialogTitle>
          <DialogDescription>They can change it themselves afterwards from Settings.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="New password" hint="At least 8 characters.">
            <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </Field>
          <ErrorCallout message={err} title="Could not set the password" />
        </div>
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
}

/** Grant a user access to clusters, optionally narrowed to namespaces. */
function GrantsDialog({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const { clusters } = useClusters();
  const grants = useGrants(user.id);
  const [adding, setAdding] = useState(false);

  const revoke = async (g: ClusterGrant) => {
    try {
      await hub.deleteGrant({ userId: user.id, clusterId: g.clusterId });
      toast.success(`Revoked access to ${g.clusterName || g.clusterId}`);
      void grants.refetch();
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    }
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

        {grants.isLoading && <Loading label="Loading grants…" />}
        {grants.data && grants.data.length > 0 && (
          <Table className="text-xs">
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
                  <TableCell className="font-medium">{g.clusterName || g.clusterId}</TableCell>
                  <TableCell>
                    <RoleBadge role={g.role} />
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">{g.namespaces.length ? g.namespaces.join(", ") : "all namespaces"}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon-sm" aria-label="Revoke" onClick={() => void revoke(g)}>
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
}

function AddGrant({ userId, clusters, onClose, onDone }: { userId: string; clusters: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? "");
  const [role, setRole] = useState("viewer");
  const [all, setAll] = useState(true);
  const [namespaces, setNamespaces] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    <div className="space-y-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cluster">
          <Select value={clusterId} onValueChange={setClusterId}>
            <SelectTrigger size="sm" className="w-full">
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
        <Field label="Role">
          <RoleSelect value={role} onChange={setRole} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={all} onCheckedChange={(v) => setAll(!!v)} /> Every namespace
      </label>
      {!all && (
        <Field label="Namespaces" hint="Comma separated. They cannot read anything outside these.">
          <Input value={namespaces} onChange={(e) => setNamespaces(e.target.value)} placeholder="shop, payments" className="font-mono" />
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
}

function RoleSelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size="sm" className="w-full">
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
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
