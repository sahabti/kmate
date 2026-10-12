import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Box, Database, Unplug, ExternalLink, Globe, Lock, Package, Search, Server, ShoppingCart, Workflow, Zap, type LucideIcon } from "lucide-react";
import { useCatalog } from "@/hooks/use-catalog";
import { StatCard, StatCardLabel, StatCardValue } from "@/components/stat-card";
import { PageHeader } from "@/components/page-header";
import { DeniedState, EmptyState, ErrorCallout } from "@/components/status";
import { DataTable, type Column } from "@/components/data-table";
import { Dot, ToneBadge, type Tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Health, type CatalogEntry, type Exposure } from "@/gen/kmate/v1/catalog_pb";
import { cn } from "@/lib/utils";
import { platform } from "@/platform/platform";
import { useDrawer } from "@/stores/drawer";
import { useUI } from "@/stores/ui";

const ICONS: Record<string, LucideIcon> = {
  "shopping-cart": ShoppingCart,
  database: Database,
  server: Server,
  globe: Globe,
  workflow: Workflow,
  zap: Zap,
  lock: Lock,
};

interface HealthLabel {
  tone: Tone;
  label: string;
}

export const healthTone = (h: Health): HealthLabel => {
  switch (h) {
    case Health.HEALTHY:
      return { tone: "ok", label: "Healthy" };
    case Health.DEGRADED:
      return { tone: "warn", label: "Degraded" };
    case Health.DOWN:
      return { tone: "bad", label: "Down" };
    case Health.NO_SELECTOR:
      return { tone: "slate", label: "No selector" };
    default:
      return { tone: "muted", label: "Unknown" };
  }
};

const exposureLabel = (e: Exposure): string => {
  switch (e.kind) {
    case "Ingress":
    case "HTTPRoute":
    case "GRPCRoute":
      return `${e.kind} ${e.host || e.addresses[0] || ""}${e.path && e.path !== "/" ? e.path : ""}`;
    case "LoadBalancer":
      return `LB ${e.addresses.join(",") || "pending"}${e.port ? `:${e.port}` : ""}`;
    case "NodePort":
      return `NodePort ${e.port}`;
    case "ExternalName":
      return `ExternalName ${e.host}`;
    default:
      return e.kind;
  }
};

type HealthFilter = "all" | "healthy" | "degraded" | "down";

const useFilteredCatalog = (clusterId: string) => {
  const { catalog, error, denial } = useCatalog(clusterId);
  const namespace = useUI((s) => s.namespace);
  const search = useUI((s) => s.search);
  const [health, setHealth] = useState<HealthFilter>("all");
  const [exposedOnly, setExposedOnly] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [q, setQ] = useState("");

  const entries = useMemo(() => {
    const term = (q || search).toLowerCase();

    return (catalog?.entries ?? []).filter((e) => {
      if (namespace && e.namespace !== namespace) return false;
      if (!showSystem && e.system) return false;
      if (exposedOnly && e.exposures.length === 0) return false;
      if (health === "healthy" && e.health !== Health.HEALTHY) return false;
      if (health === "degraded" && e.health !== Health.DEGRADED) return false;
      if (health === "down" && e.health !== Health.DOWN) return false;
      if (term) {
        const hay = `${e.name} ${e.namespace} ${e.group} ${e.description} ${e.helmRelease} ${e.exposures.map((x) => x.url + x.host).join(" ")}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }

      return true;
    });
  }, [catalog, namespace, search, q, health, exposedOnly, showSystem]);

  const stats = useMemo(() => {
    const all = (catalog?.entries ?? []).filter((e) => (showSystem || !e.system) && (!namespace || e.namespace === namespace));

    return {
      total: all.length,
      healthy: all.filter((e) => e.health === Health.HEALTHY).length,
      degraded: all.filter((e) => e.health === Health.DEGRADED).length,
      down: all.filter((e) => e.health === Health.DOWN).length,
      exposed: all.filter((e) => e.exposures.length > 0).length,
    };
  }, [catalog, showSystem, namespace]);

  return { catalog, error, denial, entries, stats, filters: { health, setHealth, exposedOnly, setExposedOnly, showSystem, setShowSystem, q, setQ } };
};

type CatalogFilters = ReturnType<typeof useFilteredCatalog>["filters"];
type CatalogStats = ReturnType<typeof useFilteredCatalog>["stats"];

interface FiltersProps {
  f: CatalogFilters;
}

const Filters = ({ f }: FiltersProps) => {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <InputGroup className="h-8 w-full sm:hidden">
        <InputGroupAddon>
          <Search className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search services…" value={f.q} onChange={(e) => f.setQ(e.target.value)} />
      </InputGroup>
      <Select value={f.health} onValueChange={(v) => f.setHealth(v as HealthFilter)}>
        <SelectTrigger size="sm" className="w-32" aria-label="Health filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All health</SelectItem>
          <SelectItem value="healthy">Healthy</SelectItem>
          <SelectItem value="degraded">Degraded</SelectItem>
          <SelectItem value="down">Down</SelectItem>
        </SelectContent>
      </Select>
      <Label htmlFor="exposed-only">
        <Switch id="exposed-only" size="sm" checked={f.exposedOnly} onCheckedChange={f.setExposedOnly} /> Exposed only
      </Label>
      <Label htmlFor="show-system">
        <Switch id="show-system" size="sm" checked={f.showSystem} onCheckedChange={f.setShowSystem} /> Show system
      </Label>
    </div>
  );
};

/** Label, count, tone. */
type StatTile = [string, number, Tone];

interface StatTilesProps {
  s: CatalogStats;
  /** Before the first catalog arrives the counts are unknown, not zero. */
  isLoading: boolean;
}

const StatTiles = ({ s, isLoading }: StatTilesProps) => {
  const tiles: StatTile[] = [
    ["Services", s.total, "info"],
    ["Healthy", s.healthy, "ok"],
    ["Degraded", s.degraded, "warn"],
    ["Down", s.down, "bad"],
    ["Exposed", s.exposed, "slate"],
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map(([l, v, t]) => (
        <StatCard key={l} className="gap-1 p-3">
          <StatCardLabel className="flex items-center gap-1.5 text-xs tracking-wide">
            <Dot tone={t} /> {l}
          </StatCardLabel>
          {isLoading ? <Skeleton className="mt-1 h-7 w-10" /> : <StatCardValue className="font-mono text-xl">{v}</StatCardValue>}
        </StatCard>
      ))}
    </div>
  );
};

interface CatalogHeaderProps {
  version?: bigint;
  f: CatalogFilters;
}

/** Header shared by the card and table views, with the filters as a toolbar under it. */
const CatalogHeader = ({ version, f }: CatalogHeaderProps) => (
  <>
    <PageHeader
      title="Service catalog"
      meta={version !== undefined && <Badge variant="outline">v{String(version)}</Badge>}
      description="Auto-discovered services, their workloads and how they are exposed."
    />
    <Filters f={f} />
  </>
);

/* ---------- Dashboard (card grid) ---------- */
export const OverviewPage = () => {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const { catalog, error, denial, entries, stats, filters } = useFilteredCatalog(clusterId);
  const open = useDrawer((s) => s.open);

  const groups = useMemo(() => {
    const m = new Map<string, CatalogEntry[]>();
    for (const e of entries) {
      const k = e.group || e.namespace;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }

    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <CatalogHeader version={catalog?.version} f={filters} />
      {!denial && <ErrorCallout title="Can't load the service catalog" message={error} />}
      {denial && <DeniedState denial={denial} what="see the service catalog for this cluster" />}
      {!denial && catalog?.version !== 0n && <StatTiles s={stats} isLoading={!catalog && !error} />}
      {!catalog && !error && !denial && (
        <div role="status" aria-label="Loading services" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      )}
      {/* Version 0 is the hub's placeholder: the agent has never reported this cluster. */}
      {catalog && catalog.version === 0n && (
        <EmptyState
          icon={<Unplug />}
          title="No catalog yet"
          hint="The agent hasn't reported this cluster's services. Check that it is installed and connected."
        />
      )}
      {catalog && catalog.version !== 0n && entries.length === 0 && (
        <EmptyState icon={<Box />} title="No services match" hint="Adjust the namespace or filters, or enable 'Show system'." />
      )}
      {groups.map(([group, list]) => (
        <section key={group} className="space-y-2">
          <h2 className="flex items-center gap-2 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {group}
            <Badge variant="secondary">{list.length}</Badge>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((e) => (
              <ServiceCard
                key={e.id}
                e={e}
                onOpen={() => open({ gvr: { group: "", version: "v1", resource: "services" }, namespace: e.namespace, name: e.name, kind: "Service" })}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
};

interface ServiceCardProps {
  e: CatalogEntry;
  onOpen: () => void;
}

const ServiceCard = ({ e, onOpen }: ServiceCardProps) => {
  const h = healthTone(e.health);
  const Icon = ICONS[e.icon] ?? Box;
  const primary = e.exposures.find((x) => x.url);
  const rest = e.exposures.filter((x) => x !== primary);

  return (
    // The clickable box is a wrapper KMate owns, so hover and focus live here, not on Card.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && onOpen()}
      className="cursor-pointer rounded-xl transition-shadow outline-none hover:ring-2 hover:ring-primary/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <Card size="sm">
        <CardContent>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-start gap-2.5">
              <div className={cn("shrink-0 rounded-md border bg-muted/50 p-2")}>
                <Icon className="size-[18px] text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{e.name}</span>
                  {e.helmRelease && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="secondary">
                          <Package /> helm
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>Helm release {e.helmRelease}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {e.namespace} · {e.type}
                </div>
              </div>
              <ToneBadge tone={h.tone} dot>
                {h.label}
              </ToneBadge>
            </div>
            {e.description && <p className="line-clamp-2 text-xs text-muted-foreground">{e.description}</p>}
            <div className="flex flex-wrap gap-1.5">
              {e.workloads.map((w) => (
                <ToneBadge
                  key={`${w.kind}/${w.name}`}
                  tone={w.ready >= w.desired && w.desired > 0 ? "ok" : w.ready > 0 ? "warn" : "bad"}
                  title={`${w.kind} ${w.name}`}
                >
                  <span className="opacity-70">{w.kind}</span> {w.name}
                  <span className="font-mono">
                    {w.ready}/{w.desired}
                  </span>
                </ToneBadge>
              ))}
              {e.workloads.length === 0 && e.endpoints && (
                <ToneBadge tone="muted">
                  endpoints
                  <span className="font-mono">
                    {e.endpoints.ready}/{e.endpoints.ready + e.endpoints.notReady}
                  </span>
                </ToneBadge>
              )}
            </div>
            {(primary || rest.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
                {primary && (
                  <Button
                    size="sm"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      platform.openExternal(primary.url);
                    }}
                    title={primary.url}
                    className="max-w-full"
                  >
                    <ExternalLink /> <span className="truncate">{primary.host || primary.url}</span>
                    {primary.tls && <Lock className="size-3 opacity-70" />}
                  </Button>
                )}
                {rest.map((x, i) => (
                  <Tooltip key={i}>
                    <TooltipTrigger asChild>
                      <Badge variant="outline">
                        {x.kind}: {x.host || x.addresses[0] || (x.port ? String(x.port) : "")}
                        {x.path && x.path !== "/" ? x.path : ""}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <span className="font-mono">{x.url || exposureLabel(x)}</span>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

/* ---------- Dense table ---------- */
export const CatalogTablePage = () => {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const { catalog, error, denial, entries, stats, filters } = useFilteredCatalog(clusterId);
  const open = useDrawer((s) => s.open);
  const cols: Column<CatalogEntry>[] = [
    { id: "name", header: "Service", cell: (e) => <span className="font-medium">{e.name}</span> },
    { id: "ns", header: "Namespace", cell: (e) => <span className="text-muted-foreground">{e.namespace}</span> },
    {
      id: "health",
      header: "Health",
      cell: (e) => {
        const h = healthTone(e.health);

        return (
          <ToneBadge tone={h.tone} dot>
            {h.label}
          </ToneBadge>
        );
      },
    },
    { id: "type", header: "Type", cell: (e) => e.type },
    { id: "ports", header: "Ports", cell: (e) => e.ports.map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`).join(", "), mono: true },
    {
      id: "wl",
      header: "Workloads",
      cell: (e) => e.workloads.map((w) => `${w.kind}/${w.name} ${w.ready}/${w.desired}`).join(", ") || <span className="text-muted-foreground">—</span>,
      mono: true,
    },
    {
      id: "exp",
      header: "Exposure",
      cell: (e) => (
        <div className="flex flex-wrap gap-1">
          {e.exposures.map((x, i) =>
            x.url ? (
              <a
                key={i}
                href={x.url}
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  platform.openExternal(x.url);
                }}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {exposureLabel(x)} <ExternalLink className="size-2.5" />
              </a>
            ) : (
              <span key={i} className="text-muted-foreground">
                {exposureLabel(x)}
              </span>
            ),
          )}
          {e.exposures.length === 0 && <span className="text-muted-foreground">internal</span>}
        </div>
      ),
    },
    { id: "group", header: "Group", cell: (e) => e.group },
    { id: "helm", header: "Helm", cell: (e) => e.helmRelease || "" },
  ];

  return (
    <div className="flex flex-col gap-4 px-4 py-6 md:px-8">
      <CatalogHeader version={catalog?.version} f={filters} />
      {!denial && <ErrorCallout title="Can't load the service catalog" message={error} />}
      {denial && <DeniedState denial={denial} what="see the service catalog for this cluster" />}
      {!denial && catalog?.version !== 0n && <StatTiles s={stats} isLoading={!catalog && !error} />}
      {!denial && !error && (
        <DataTable
          rows={entries}
          loading={!catalog}
          columns={cols}
          rowKey={(e) => e.id}
          onRowClick={(e) => open({ gvr: { group: "", version: "v1", resource: "services" }, namespace: e.namespace, name: e.name, kind: "Service" })}
          emptyIcon={catalog?.version === 0n ? <Unplug /> : <Box />}
          emptyTitle={catalog?.version === 0n ? "No catalog yet" : "No services match"}
          emptyHint={
            catalog?.version === 0n
              ? "The agent hasn't reported this cluster's services. Check that it is installed and connected."
              : "Adjust the namespace or filters, or enable “Show system”."
          }
        />
      )}
    </div>
  );
};
