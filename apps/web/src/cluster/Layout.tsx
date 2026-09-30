import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  Boxes,
  Castle,
  ChevronRight,
  Cpu,
  Database,
  FolderTree,
  Globe,
  HardDrive,
  KeyRound,
  LayoutGrid,
  ListTree,
  Moon,
  ScrollText,
  MoreHorizontal,
  Network,
  Package,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCluster, useClusters, useWatch } from "@/api/hooks";
import { NAV_GROUPS, NAV_SINGLE, resourcePath } from "@/cluster/nav";
import { ResourceDrawer } from "@/cluster/ResourceDrawer";
import { NamespacePicker } from "@/components/NamespacePicker";
import { Kbd } from "@/components/kbd";
import { Dot } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { statusTone } from "@/pages/Clusters";
import { useSession } from "@/store/session";
import { useTheme } from "@/store/theme";
import { useUI } from "@/store/ui";

const GROUP_ICONS: Record<string, LucideIcon> = {
  Workloads: Boxes,
  Config: Database,
  Network: Network,
  Storage: HardDrive,
  Access: ShieldCheck,
};
const SINGLE_ICONS: Record<string, LucideIcon> = {
  nodes: Cpu,
  namespaces: FolderTree,
  events: ListTree,
};

export function ClusterLayout() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const { sidebarCollapsed, toggleSidebar } = useUI();
  return (
    <SidebarProvider
      defaultOpen={!sidebarCollapsed}
      onOpenChange={(open) => {
        if (open === sidebarCollapsed) toggleSidebar();
      }}
      className="h-full min-h-0"
    >
      <ClusterSidebar clusterId={clusterId} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <TopBar clusterId={clusterId} />
        <main className="min-h-0 flex-1 overflow-hidden pb-14 md:pb-0">
          <Outlet />
        </main>
        <BottomTabs clusterId={clusterId} />
      </SidebarInset>
      <ResourceDrawer clusterId={clusterId} />
      <CommandPalette clusterId={clusterId} />
    </SidebarProvider>
  );
}

/* ---------------- Sidebar ---------------- */

function ClusterSidebar({ clusterId }: { clusterId: string }) {
  const user = useSession((s) => s.user);
  const loc = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
    // close the mobile sheet on navigation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const isActive = (to: string, exact = false) => (exact ? loc.pathname === to : loc.pathname.startsWith(to));

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="All clusters">
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Waypoints className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">KMate</span>
                  <span className="truncate text-[11px] text-muted-foreground">All clusters</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Overview" isActive={isActive(`/c/${clusterId}`, true)}>
                  <Link to="/c/$clusterId" params={{ clusterId }}>
                    <LayoutGrid /> <span>Overview</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Service Catalog" isActive={isActive(`/c/${clusterId}/catalog`)}>
                  <Link to="/c/$clusterId/catalog" params={{ clusterId }}>
                    <Globe /> <span>Service Catalog</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Resources</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_GROUPS.map((g) => {
                const Icon = GROUP_ICONS[g.label] ?? Boxes;
                const groupActive = g.items.some((it) => isActive(resourcePath(clusterId, it.gvr)));
                return (
                  <Collapsible key={g.label} asChild defaultOpen={groupActive || g.label === "Workloads"} className="group/collapsible">
                    <SidebarMenuItem>
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton tooltip={g.label} isActive={groupActive}>
                          <Icon />
                          <span>{g.label}</span>
                          <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {g.items.map((it) => {
                            const to = resourcePath(clusterId, it.gvr);
                            return (
                              <SidebarMenuSubItem key={it.gvr.resource}>
                                <SidebarMenuSubButton asChild isActive={isActive(to)} size="sm">
                                  <Link to={to}>
                                    <span>{it.label}</span>
                                  </Link>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            );
                          })}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </SidebarMenuItem>
                  </Collapsible>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Cluster</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_SINGLE.map((it) => {
                const to = resourcePath(clusterId, it.gvr);
                const Icon = SINGLE_ICONS[it.gvr.resource] ?? Server;
                return (
                  <SidebarMenuItem key={it.gvr.resource}>
                    <SidebarMenuButton asChild tooltip={it.label} isActive={isActive(to)}>
                      <Link to={to}>
                        <Icon /> <span>{it.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Realm" isActive={isActive(`/c/${clusterId}/realm`)}>
                  <Link to="/c/$clusterId/realm" params={{ clusterId }}>
                    <Castle /> <span>Realm</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Helm" isActive={isActive(`/c/${clusterId}/helm`)}>
                  <Link to="/c/$clusterId/helm" params={{ clusterId }}>
                    <Package /> <span>Helm</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="CRDs" isActive={isActive(`/c/${clusterId}/crds`)}>
                  <Link to="/c/$clusterId/crds" params={{ clusterId }}>
                    <KeyRound /> <span>CRDs</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Audit log" isActive={isActive(`/c/${clusterId}/audit`)}>
                  <Link to="/c/$clusterId/audit" params={{ clusterId }}>
                    <ScrollText /> <span>Audit log</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Settings">
              <Link to="/settings">
                <Settings />
                <div className="grid flex-1 leading-tight">
                  <span className="truncate">Settings</span>
                  <span className="truncate text-[10px] text-muted-foreground">{user?.email}</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/* ---------------- Top bar ---------------- */

function sectionLabel(pathname: string, clusterId: string): string {
  const rest = pathname.replace(`/c/${clusterId}`, "");
  if (!rest || rest === "/") return "Overview";
  if (rest.startsWith("/catalog")) return "Service Catalog";
  if (rest.startsWith("/helm")) return "Helm";
  if (rest.startsWith("/crds")) return "CRDs";
  if (rest.startsWith("/audit")) return "Audit log";
  if (rest.startsWith("/realm/gallery")) return "Realm gallery";
  if (rest.startsWith("/realm")) return "Realm";
  const m = rest.match(/^\/r\/[^/]+\/[^/]+\/([^/]+)/);
  if (m) {
    const res = m[1]!;
    for (const g of NAV_GROUPS) for (const it of g.items) if (it.gvr.resource === res) return it.label;
    for (const it of NAV_SINGLE) if (it.gvr.resource === res) return it.label;
    return res;
  }
  return "";
}

function TopBar({ clusterId }: { clusterId: string }) {
  const { data: cluster } = useCluster(clusterId);
  const { namespace, setNamespace, search, setSearch } = useUI();
  const { items: namespaces } = useWatch(clusterId, { group: "", version: "v1", resource: "namespaces" }, "", { columnsOnly: true });
  const nsNames = useMemo(() => namespaces.map((n) => n.metadata?.name ?? "").filter(Boolean).sort(), [namespaces]);
  const loc = useLocation();
  const { theme, toggle } = useTheme();
  const searchRef = useRef<HTMLInputElement>(null);
  const st = cluster ? statusTone(cluster.status) : { tone: "muted" as const, label: "…" };
  const section = sectionLabel(loc.pathname, clusterId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-3">
      <SidebarTrigger className="-ml-1 shrink-0" />
      <Breadcrumb className="min-w-0 flex-1 sm:flex-none">
        <BreadcrumbList className="flex-nowrap text-xs sm:gap-1.5">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbLink asChild>
              <Link to="/c/$clusterId" params={{ clusterId }} className="flex items-center gap-1.5">
                <Dot tone={st.tone} pulse={st.tone === "ok"} />
                <span className="truncate font-semibold text-foreground">{cluster?.name ?? clusterId}</span>
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {section && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="whitespace-nowrap">{section}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          )}
        </BreadcrumbList>
      </Breadcrumb>
      {cluster?.info?.kubernetesVersion && (
        <Badge variant="outline" className="hidden rounded-md font-mono text-[10px] md:inline-flex">
          {cluster.info.kubernetesVersion}
        </Badge>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        <NamespacePicker namespaces={nsNames} value={namespace} onChange={setNamespace} />
        <InputGroup className="hidden h-8 w-44 sm:flex lg:w-64">
          <InputGroupAddon>
            <Search className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput ref={searchRef} placeholder="Filter…" value={search} onChange={(e) => setSearch(e.target.value)} className="text-xs" />
          <InputGroupAddon align="inline-end">
            {search ? (
              <InputGroupButton size="icon-xs" aria-label="Clear filter" onClick={() => setSearch("")}>
                <X />
              </InputGroupButton>
            ) : (
              <Kbd>/</Kbd>
            )}
          </InputGroupAddon>
        </InputGroup>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme" className="shrink-0">
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Switch to {theme === "dark" ? "light" : "dark"} theme</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

/* ---------------- Mobile bottom tabs ---------------- */

function BottomTabs({ clusterId }: { clusterId: string }) {
  const { setOpenMobile } = useSidebar();
  const loc = useLocation();
  const tabs: Array<{ to: string; label: string; icon: LucideIcon; exact?: boolean }> = [
    { to: `/c/${clusterId}`, label: "Overview", icon: LayoutGrid, exact: true },
    { to: resourcePath(clusterId, { group: "", version: "v1", resource: "pods" }), label: "Pods", icon: Boxes },
    { to: resourcePath(clusterId, { group: "apps", version: "v1", resource: "deployments" }), label: "Deploys", icon: Package },
    { to: resourcePath(clusterId, { group: "", version: "v1", resource: "services" }), label: "Services", icon: Network },
  ];
  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 backdrop-blur md:hidden">
      <div className="grid h-14 grid-cols-5">
        {tabs.map((t) => {
          const active = t.exact ? loc.pathname === t.to : loc.pathname.startsWith(t.to);
          return (
            <Link key={t.to} to={t.to} className={cn("flex flex-col items-center justify-center gap-0.5 text-[10px]", active ? "text-primary" : "text-muted-foreground")}>
              <t.icon className="size-[18px]" />
              {t.label}
            </Link>
          );
        })}
        <button onClick={() => setOpenMobile(true)} className="flex flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground">
          <MoreHorizontal className="size-[18px]" /> More
        </button>
      </div>
    </nav>
  );
}

/* ---------------- ⌘K command palette ---------------- */

function CommandPalette({ clusterId }: { clusterId: string }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const { clusters } = useClusters();
  const { toggle } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    void nav({ to });
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Jump to a view or cluster">
      <Command>
      <CommandInput placeholder="Jump to…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Views">
          <CommandItem onSelect={() => go(`/c/${clusterId}`)}>
            <LayoutGrid /> Overview
          </CommandItem>
          <CommandItem onSelect={() => go(`/c/${clusterId}/catalog`)}>
            <Globe /> Service Catalog
          </CommandItem>
          {NAV_GROUPS.flatMap((g) => g.items).map((it) => (
            <CommandItem key={it.gvr.resource} value={`${it.label} ${it.gvr.resource}`} onSelect={() => go(resourcePath(clusterId, it.gvr))}>
              <Boxes /> {it.label}
            </CommandItem>
          ))}
          {NAV_SINGLE.map((it) => (
            <CommandItem key={it.gvr.resource} value={`${it.label} ${it.gvr.resource}`} onSelect={() => go(resourcePath(clusterId, it.gvr))}>
              <Server /> {it.label}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go(`/c/${clusterId}/helm`)}>
            <Package /> Helm releases
          </CommandItem>
          <CommandItem onSelect={() => go(`/c/${clusterId}/crds`)}>
            <KeyRound /> Custom Resource Definitions
          </CommandItem>
          <CommandItem onSelect={() => go(`/c/${clusterId}/audit`)}>
            <ScrollText /> Audit log
          </CommandItem>
          <CommandItem value="realm fantasy map world" onSelect={() => go(`/c/${clusterId}/realm`)}>
            <Castle /> Realm
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Clusters">
          {clusters.map((c) => (
            <CommandItem key={c.id} value={`cluster ${c.name}`} onSelect={() => go(`/c/${c.id}`)}>
              <Dot tone={statusTone(c.status).tone} /> {c.name}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => go("/")}>
            <Waypoints /> All clusters
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            onSelect={() => {
              toggle();
              setOpen(false);
            }}
          >
            <Sun /> Toggle theme
          </CommandItem>
          <CommandItem onSelect={() => go("/settings")}>
            <Settings /> Settings
          </CommandItem>
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
