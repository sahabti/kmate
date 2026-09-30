import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Moon, Sun } from "lucide-react";
import { hub } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { platform } from "@/platform";
import { useSession } from "@/store/session";
import { useTheme } from "@/store/theme";

export function SettingsPage() {
  const user = useSession((s) => s.user);
  const clear = useSession((s) => s.clear);
  const { theme, setTheme } = useTheme();
  const nav = useNavigate();

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
