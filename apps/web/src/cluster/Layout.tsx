import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  Boxes,
  ArrowLeft,
  Castle,
  Check,
  ChevronsUpDown,
  ChevronRight,
  Cpu,
  Database,
  FolderTree,
  Globe,
  HardDrive,
  KeyRound,
  LayoutGrid,
  LayoutList,
  ListTree,
  ScrollText,
  MoreHorizontal,
  Network,
  Package,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Users as UsersIcon,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { useAllowedNamespaces, useCluster, useClusters } from "@/api/hooks";
import { NAV_GROUPS, NAV_SINGLE, resourcePath } from "@/cluster/nav";
import { ResourceDrawer } from "@/cluster/ResourceDrawer";
import { NamespacePicker } from "@/components/NamespacePicker";
import { AppSidebarProvider, AppTopBar } from "@/components/HubShell";
import { Kbd } from "@/components/kbd";
import { Dot } from "@/components/tone";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  Sidebar,
  SidebarContent,
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
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
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
  return (
    <AppSidebarProvider>
      <ClusterSidebar clusterId={clusterId} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <TopBar clusterId={clusterId} />
        <main data-slot="app-scroll" className="min-h-0 flex-1 overflow-auto pb-14 md:pb-0">
          <Outlet />
        </main>
        <BottomTabs clusterId={clusterId} />
      </SidebarInset>
      <ResourceDrawer clusterId={clusterId} />
      <CommandPalette clusterId={clusterId} />
    </AppSidebarProvider>
  );
}

/* ---------------- Sidebar ---------------- */

function ClusterSidebar({ clusterId }: { clusterId: string }) {
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
            <SidebarMenuButton asChild size="sm" tooltip="All clusters" className="text-muted-foreground">
              <Link to="/">
                <ArrowLeft />
                <span>All clusters</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ClusterSwitcher clusterId={clusterId} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
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
            <SidebarMenu className="gap-1">
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
            <SidebarMenu className="gap-1">
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

      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Switch clusters without leaving the cluster shell, like an account switcher:
 * the list of every cluster stays one click away.
 */
function ClusterSwitcher({ clusterId }: { clusterId: string }) {
  const { clusters } = useClusters();
  const current = clusters.find((c) => c.id === clusterId);
  const { isMobile } = useSidebar();
  const nav = useNavigate();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={current?.name ?? "Cluster"}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Waypoints className="size-4" />
              </div>
              <div className="grid flex-1 text-start text-sm leading-tight">
                <span className="truncate font-medium">{current?.name ?? "Cluster"}</span>
                <span className="truncate text-xs text-muted-foreground">{current ? `${statusTone(current.status).label} · ${current.info?.kubernetesVersion || "unknown version"}` : "Loading…"}</span>
              </div>
              <ChevronsUpDown className="ms-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side={isMobile ? "bottom" : "right"} className="w-64">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Clusters</DropdownMenuLabel>
            {clusters.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => void nav({ to: "/c/$clusterId", params: { clusterId: c.id } })}>
                <Dot tone={statusTone(c.status).tone} />
                <span className="truncate">{c.name}</span>
                {c.id === clusterId && <Check className="ms-auto" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/">
                <LayoutList /> All clusters
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
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
  // A namespace-limited user cannot list the cluster-scoped namespaces resource,
  // so this falls back to the namespaces in their own grant.
  const { namespaces: nsNames, restricted: nsRestricted } = useAllowedNamespaces(clusterId);
  const loc = useLocation();
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
    <AppTopBar
      breadcrumb={
        <Breadcrumb>
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="hidden md:inline-flex">
              <BreadcrumbLink asChild>
                <Link to="/">Clusters</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink asChild>
                <Link to="/c/$clusterId" params={{ clusterId }} className="flex items-center gap-1.5">
                  <Dot tone={st.tone} pulse={st.tone === "ok"} />
                  <span className="truncate">{cluster?.name ?? clusterId}</span>
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
      }
    >
      <NamespacePicker namespaces={nsNames} value={namespace} onChange={setNamespace} allowAll={!nsRestricted} />
      <InputGroup className="hidden w-44 sm:flex lg:w-64">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput ref={searchRef} placeholder="Filter…" aria-label="Filter this list" value={search} onChange={(e) => setSearch(e.target.value)} />
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
    </AppTopBar>
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
  const isAdmin = useSession((s) => s.user?.role) === "admin";
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
          {isAdmin && (
            <CommandItem value="users accounts roles grants access" onSelect={() => go("/settings/users")}>
              <UsersIcon /> Manage users
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
      </Command>
    </CommandDialog>
  );
}
