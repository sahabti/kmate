import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { useSession } from "@/store/session";
import { LoginPage } from "@/pages/Login";
import { ClustersPage } from "@/pages/Clusters";
import { SettingsPage } from "@/pages/Settings";
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

const requireAuth = () => {
  if (!useSession.getState().token) throw redirect({ to: "/login" });
};

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
  beforeLoad: () => {
    if (useSession.getState().token) throw redirect({ to: "/" });
  },
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ClustersPage, beforeLoad: requireAuth });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage, beforeLoad: requireAuth });

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
  clusterRoute.addChildren([overviewRoute, catalogRoute, resourceRoute, helmRoute, crdsRoute, auditRoute, realmRoute, realmGalleryRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
