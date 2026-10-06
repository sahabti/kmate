import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Moon, Sun, Users as UsersIcon } from "lucide-react";
import { toast } from "sonner";
import { hub, errorMessage } from "@/api/client";
import { useGrants } from "@/api/hooks";
import { ErrorCallout, Loading } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { platform } from "@/platform";
import { useSession } from "@/store/session";
import { useTheme } from "@/store/theme";

export function SettingsPage() {
  const user = useSession((s) => s.user);
  const clear = useSession((s) => s.clear);
  const { theme, setTheme } = useTheme();
  const nav = useNavigate();
  const grants = useGrants("");
  const isAdmin = user?.role === "admin";

  const logout = async () => {
    try {
      await hub.logout({});
    } catch {
      /* ignore */
    }
    clear();
    void nav({ to: "/login" });
  };

  const rows: Array<[string, React.ReactNode]> = [
    ["Email", user?.email],
    ["Name", user?.name || "—"],
    ["Role", <Badge variant="secondary" className="rounded-md">{user?.role}</Badge>],
    ["Hub", <span className="font-mono">{platform.hubUrl()}</span>],
    ["Platform", platform.name],
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 md:p-8">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">
            <ArrowLeft /> Clusters
          </Link>
        </Button>
        <h1 className="text-base font-semibold">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Who you are signed in as on this hub.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table className="text-xs">
            <TableBody>
              {rows.map(([k, v]) => (
                <TableRow key={k} className="hover:bg-transparent">
                  <TableCell className="w-32 text-muted-foreground">{k}</TableCell>
                  <TableCell>{v}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Button variant="destructive" size="sm" onClick={logout}>
            <LogOut /> Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your cluster access</CardTitle>
          <CardDescription>
            {isAdmin
              ? "You are a KMate administrator, so every cluster is visible to you. What you may change in a cluster is still decided by that cluster's own RBAC."
              : "What KMate lets you reach. Inside a cluster, its own RBAC decides what you may actually do."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {grants.isLoading && <Loading label="Loading your access…" />}
          <ErrorCallout message={grants.error ? errorMessage(grants.error) : null} />
          {grants.data && grants.data.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {isAdmin ? "No explicit grants; administrator access covers every cluster." : "No cluster access yet. Ask an administrator for a grant."}
            </p>
          )}
          {grants.data && grants.data.length > 0 && (
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Cluster</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Namespaces</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.data.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.clusterName || g.clusterId}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-md">{g.role}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{g.namespaces.length ? g.namespaces.join(", ") : "all namespaces"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ChangePassword />

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Administration</CardTitle>
            <CardDescription>Accounts, roles and which clusters each person may reach.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" asChild>
              <Link to="/settings/users">
                <UsersIcon /> Manage users
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Theme is stored on this device.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="dark-mode" className="flex items-center gap-2 text-xs">
              {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />} Dark mode
            </Label>
            <Switch id="dark-mode" checked={theme === "dark"} onCheckedChange={(v) => setTheme(v ? "dark" : "light")} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await hub.setPassword({ currentPassword: current, newPassword: next });
      toast.success("Password changed");
      setCurrent("");
      setNext("");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Change the password you use to sign in to this hub.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Current password</Label>
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">New password</Label>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">At least 8 characters.</p>
        <ErrorCallout message={err} title="Could not change the password" />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !current || next.length < 8}>
          Change password
        </Button>
      </CardContent>
    </Card>
  );
}
