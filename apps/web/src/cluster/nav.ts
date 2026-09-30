import type { GVRKey } from "@/lib/k8s";

export interface NavItem {
  label: string;
  gvr: GVRKey;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

const g = (group: string, version: string, resource: string): GVRKey => ({ group, version, resource });

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workloads",
    items: [
      { label: "Pods", gvr: g("", "v1", "pods") },
      { label: "Deployments", gvr: g("apps", "v1", "deployments") },
      { label: "StatefulSets", gvr: g("apps", "v1", "statefulsets") },
      { label: "DaemonSets", gvr: g("apps", "v1", "daemonsets") },
      { label: "ReplicaSets", gvr: g("apps", "v1", "replicasets") },
      { label: "Jobs", gvr: g("batch", "v1", "jobs") },
      { label: "CronJobs", gvr: g("batch", "v1", "cronjobs") },
    ],
  },
  {
    label: "Config",
    items: [
      { label: "ConfigMaps", gvr: g("", "v1", "configmaps") },
      { label: "Secrets", gvr: g("", "v1", "secrets") },
      { label: "HPAs", gvr: g("autoscaling", "v2", "horizontalpodautoscalers") },
      { label: "PDBs", gvr: g("policy", "v1", "poddisruptionbudgets") },
      { label: "ResourceQuotas", gvr: g("", "v1", "resourcequotas") },
      { label: "LimitRanges", gvr: g("", "v1", "limitranges") },
    ],
  },
  {
    label: "Network",
    items: [
      { label: "Services", gvr: g("", "v1", "services") },
      { label: "Ingresses", gvr: g("networking.k8s.io", "v1", "ingresses") },
      { label: "EndpointSlices", gvr: g("discovery.k8s.io", "v1", "endpointslices") },
      { label: "NetworkPolicies", gvr: g("networking.k8s.io", "v1", "networkpolicies") },
    ],
  },
  {
    label: "Storage",
    items: [
      { label: "PVCs", gvr: g("", "v1", "persistentvolumeclaims") },
      { label: "PVs", gvr: g("", "v1", "persistentvolumes") },
      { label: "StorageClasses", gvr: g("storage.k8s.io", "v1", "storageclasses") },
    ],
  },
  {
    label: "Access",
    items: [
      { label: "ServiceAccounts", gvr: g("", "v1", "serviceaccounts") },
      { label: "Roles", gvr: g("rbac.authorization.k8s.io", "v1", "roles") },
      { label: "RoleBindings", gvr: g("rbac.authorization.k8s.io", "v1", "rolebindings") },
      { label: "ClusterRoles", gvr: g("rbac.authorization.k8s.io", "v1", "clusterroles") },
      { label: "ClusterRoleBindings", gvr: g("rbac.authorization.k8s.io", "v1", "clusterrolebindings") },
    ],
  },
];

export const NAV_SINGLE: NavItem[] = [
  { label: "Nodes", gvr: g("", "v1", "nodes") },
  { label: "Namespaces", gvr: g("", "v1", "namespaces") },
  { label: "Events", gvr: g("", "v1", "events") },
];

export function resourcePath(clusterId: string, gvr: GVRKey): string {
  return `/c/${clusterId}/r/${gvr.group || "core"}/${gvr.version}/${gvr.resource}`;
}

export function labelForResource(resource: string): string {
  for (const grp of NAV_GROUPS) for (const it of grp.items) if (it.gvr.resource === resource) return it.label;
  for (const it of NAV_SINGLE) if (it.gvr.resource === resource) return it.label;
  return resource;
}
