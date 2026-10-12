import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { LogOut, Moon, Server, Settings, Sun, Users, Waypoints, type LucideIcon } from "lucide-react";
import { hub } from "@/services/api-client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
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
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useSession } from "@/stores/session";
import { useTheme } from "@/stores/theme";
import { useUI } from "@/stores/ui";

/*
 * Two-level app frame, after Cloudflare's dashboard: the hub level (clusters,
 * users, settings) and the cluster level share one layout. Both have a sidebar
 * for navigation and a top bar with the breadcrumb and the account menu.
 */

export const signOut = async (clear: () => void, go: () => void) => {
  try {
    await hub.logout({});
  } catch {
    /* the session ends locally either way */
  }
  clear();
  go();
};

export const initials = (nameOrEmail: string | undefined) => {
  const base = (nameOrEmail ?? "?").split("@")[0]!;
  const parts = base.split(/[\s._-]+/).filter(Boolean);

  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};

/** Avatar button and menu at the right end of the top bar, on every page. */
export const AccountMenu = () => {
  const user = useSession((s) => s.user);
  const clear = useSession((s) => s.clear);
  const { theme, toggle } = useTheme();
  const nav = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <Avatar className="size-7">
            <AvatarFallback>{initials(user?.name || user?.email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate">{user?.name || user?.email}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user?.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <Settings /> Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={toggle}>
            {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light theme" : "Dark theme"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut(clear, () => void nav({ to: "/login" }))}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

interface AppSidebarProviderProps {
  children: ReactNode;
}

/** Sidebar open state, remembered across both levels and reloads. */
export const AppSidebarProvider = ({ children }: AppSidebarProviderProps) => {
  const { sidebarCollapsed, toggleSidebar } = useUI();

  return (
    // Controlled: with onOpenChange but no `open`, shadcn hands the state to the
    // parent and stops updating its own, so the sidebar would never move.
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={(open) => {
        if (open === sidebarCollapsed) toggleSidebar();
      }}
      className="h-full min-h-0"
    >
      {children}
    </SidebarProvider>
  );
};

interface AppTopBarProps {
  breadcrumb: ReactNode;
  children?: ReactNode;
}

/** Top bar shared by both levels: sidebar toggle, breadcrumb, page tools, account menu. */
export const AppTopBar = ({ breadcrumb, children }: AppTopBarProps) => {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-2 sm:px-3">
      <SidebarTrigger className="-ms-1" />
      <Separator orientation="vertical" className="me-1 data-[orientation=vertical]:h-4" />
      <div className="min-w-0 flex-1">{breadcrumb}</div>
      <div className="flex shrink-0 items-center gap-2">
        {children}
        <AccountMenu />
      </div>
    </header>
  );
};

/** Brand row at the top of the hub sidebar. */
const HubBrand = () => {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild tooltip="KMate">
          <Link to="/">
            <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Waypoints className="size-4" />
            </div>
            <div className="grid flex-1 text-start text-sm leading-tight">
              <span className="truncate font-medium">KMate</span>
              <span className="truncate text-xs text-muted-foreground">Hub</span>
            </div>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

interface HubNavItem {
  to: "/" | "/settings/users" | "/settings";
  label: string;
  icon: LucideIcon;
  admin?: boolean;
}

const HUB_NAV: HubNavItem[] = [
  { to: "/", label: "Clusters", icon: Server },
  { to: "/settings/users", label: "Users", icon: Users, admin: true },
  { to: "/settings", label: "Settings", icon: Settings },
];

interface HubShellProps {
  children: ReactNode;
}

/** Frame for hub-level pages: pick a cluster here, then work inside the cluster's own sidebar. */
export const HubShell = ({ children }: HubShellProps) => {
  const isAdmin = useSession((s) => s.user?.role) === "admin";
  const loc = useLocation();
  const items = HUB_NAV.filter((n) => !n.admin || isAdmin);
  const current = items.find((n) => loc.pathname === n.to);

  return (
    <AppSidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <HubBrand />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Hub</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {items.map((n) => (
                  <SidebarMenuItem key={n.to}>
                    <SidebarMenuButton asChild tooltip={n.label} isActive={loc.pathname === n.to}>
                      <Link to={n.to}>
                        <n.icon />
                        <span>{n.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">
        <AppTopBar
          breadcrumb={
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbPage>{current?.label ?? "KMate"}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          }
        />
        <div id="main-content" data-slot="app-scroll" tabIndex={-1} className="min-h-0 flex-1 overflow-auto outline-none">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8 md:py-8">{children}</div>
        </div>
      </SidebarInset>
    </AppSidebarProvider>
  );
};
