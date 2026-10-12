import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { useSession } from "@/store/session";
import { LoginPage } from "@/pages/Login";
import { ClustersPage } from "@/pages/Clusters";
import { SettingsPage } from "@/pages/Settings";
import { UsersPage } from "@/pages/Users";
import { ClusterLayout } from "@/cluster/Layout";
import { OverviewPage, CatalogTablePage } from "@/cluster/catalog";
import { ResourceListPage } from "@/cluster/ResourceList";
import { HelmPage } from "@/cluster/Helm";
import { CRDsPage } from "@/cluster/CRDs";
import { AuditPage } from "@/cluster/Audit";
import { lazy, Suspense } from "react";

const RealmViewLazy = lazy(() => import("@/realm/RealmView").then((m) => ({ default: m.RealmViewPage })));
const RealmGalleryLazy = lazy(() => import("@/realm/Gallery").then((m) => ({ default: m.RealmGalleryPage })));
const RealmPage = () => (
  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading the realm…</div>}>
    <RealmViewLazy />
  </Suspense>
);
const RealmGalleryPage = () => (
  <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
    <RealmGalleryLazy />
  </Suspense>
);

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

// Remember where the user was going, so signing in lands them back there.
const requireAuth = ({ location }: { location: { href: string } }) => {
  if (!useSession.getState().token) throw redirect({ to: "/login", search: { next: location.href } });
};

export interface LoginSearch {
  /** In-app path to return to after signing in. */
  next?: string;
  /** Set when the hub rejected an expired session. */
  expired?: boolean;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>): LoginSearch => ({
    next: typeof s.next === "string" ? s.next : undefined,
    expired: s.expired === true || s.expired === "1" || s.expired === 1 ? true : undefined,
  }),
  beforeLoad: () => {
    if (useSession.getState().token) throw redirect({ to: "/" });
  },
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ClustersPage, beforeLoad: requireAuth });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage, beforeLoad: requireAuth });
const usersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/users", component: UsersPage, beforeLoad: requireAuth });

const clusterRoute = createRoute({ getParentRoute: () => rootRoute, path: "/c/$clusterId", component: ClusterLayout, beforeLoad: requireAuth });
const overviewRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/", component: OverviewPage });
const catalogRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/catalog", component: CatalogTablePage });
const resourceRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/r/$group/$version/$resource", component: ResourceListPage });
const helmRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/helm", component: HelmPage });
const crdsRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/crds", component: CRDsPage });
const auditRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/audit", component: AuditPage });
const realmRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/realm", component: RealmPage });
const realmGalleryRoute = createRoute({ getParentRoute: () => clusterRoute, path: "/realm/gallery", component: RealmGalleryPage });

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  settingsRoute,
  usersRoute,
  clusterRoute.addChildren([overviewRoute, catalogRoute, resourceRoute, helmRoute, crdsRoute, auditRoute, realmRoute, realmGalleryRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
