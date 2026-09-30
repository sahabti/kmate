import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { Box, Database, ExternalLink, Globe, Lock, Package, Search, Server, ShoppingCart, Workflow, Zap, type LucideIcon } from "lucide-react";
import { useCatalog } from "@/api/hooks";
import { StatCard, StatCardLabel, StatCardValue } from "@/components/stat-card";
import { EmptyState, ErrorCallout, Loading } from "@/components/status";
import { SimpleTable, type Column } from "@/components/Table";
import { Dot, ToneBadge, type Tone } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Health, type CatalogEntry, type Exposure } from "@/gen/kmate/v1/catalog_pb";
import { cn } from "@/lib/utils";
import { platform } from "@/platform";
import { useDrawer } from "@/store/drawer";
import { useUI } from "@/store/ui";

const ICONS: Record<string, LucideIcon> = {
  "shopping-cart": ShoppingCart,
  database: Database,
  server: Server,
  globe: Globe,
  workflow: Workflow,
  zap: Zap,
  lock: Lock,
};

export function healthTone(h: Health): { tone: Tone; label: string } {
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
}

function exposureLabel(e: Exposure): string {
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
}

type HealthFilter = "all" | "healthy" | "degraded" | "down";

function useFilteredCatalog(clusterId: string) {
  const { catalog, error } = useCatalog(clusterId);
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

  return { catalog, error, entries, stats, filters: { health, setHealth, exposedOnly, setExposedOnly, showSystem, setShowSystem, q, setQ } };
}

function Filters({ f }: { f: ReturnType<typeof useFilteredCatalog>["filters"] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <InputGroup className="h-8 w-full sm:hidden">
        <InputGroupAddon>
          <Search className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search services…" value={f.q} onChange={(e) => f.setQ(e.target.value)} className="text-xs" />
      </InputGroup>
      <Select value={f.health} onValueChange={(v) => f.setHealth(v as HealthFilter)}>
        <SelectTrigger size="sm" className="w-32 text-xs" aria-label="Health filter">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All health</SelectItem>
          <SelectItem value="healthy">Healthy</SelectItem>
          <SelectItem value="degraded">Degraded</SelectItem>
          <SelectItem value="down">Down</SelectItem>
        </SelectContent>
      </Select>
      <Label htmlFor="exposed-only" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch id="exposed-only" size="sm" checked={f.exposedOnly} onCheckedChange={f.setExposedOnly} /> Exposed only
      </Label>
      <Label htmlFor="show-system" className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Switch id="show-system" size="sm" checked={f.showSystem} onCheckedChange={f.setShowSystem} /> Show system
      </Label>
    </div>
  );
}

function StatTiles({ s }: { s: ReturnType<typeof useFilteredCatalog>["stats"] }) {
  const tiles: Array<[string, number, Tone]> = [
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
          <StatCardLabel className="flex items-center gap-1.5 text-[10px] tracking-wide">
            <Dot tone={t} /> {l}
          </StatCardLabel>
          <StatCardValue className="font-mono text-xl">{v}</StatCardValue>
        </StatCard>
      ))}
    </div>
  );
}

function PageHeader({ title, version, f }: { title: string; version?: bigint; f: ReturnType<typeof useFilteredCatalog>["filters"] }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="text-xs text-muted-foreground">
          Auto-discovered services, their workloads and how they are exposed.
          {version !== undefined && (
            <Badge variant="outline" className="ml-2 rounded-md font-mono text-[10px]">
              v{String(version)}
            </Badge>
          )}
        </p>
      </div>
      <Filters f={f} />
    </div>
  );
}

/* ---------- Dashboard (card grid) ---------- */
export function OverviewPage() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const { catalog, error, entries, stats, filters } = useFilteredCatalog(clusterId);
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
    <div className="h-full space-y-4 overflow-y-auto p-3 md:p-5">
      <PageHeader title="Service Catalog" version={catalog?.version} f={filters} />
      <ErrorCallout message={error} />
      <StatTiles s={stats} />
      {!catalog && !error && <Loading label="Waiting for catalog from agent…" />}
      {catalog && entries.length === 0 && <EmptyState icon={<Box />} title="No services match" hint="Adjust the namespace or filters, or enable 'Show system'." />}
      {groups.map(([group, list]) => (
        <section key={group} className="space-y-2">
          <h2 className="flex items-center gap-2 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {group}
            <Badge variant="secondary" className="h-4 rounded-md px-1.5 text-[10px]">
              {list.length}
            </Badge>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((e) => (
              <ServiceCard key={e.id} e={e} onOpen={() => open({ gvr: { group: "", version: "v1", resource: "services" }, namespace: e.namespace, name: e.name, kind: "Service" })} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ServiceCard({ e, onOpen }: { e: CatalogEntry; onOpen: () => void }) {
  const h = healthTone(e.health);
  const Icon = ICONS[e.icon] ?? Box;
  const primary = e.exposures.find((x) => x.url);
  const rest = e.exposures.filter((x) => x !== primary);
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(ev) => ev.key === "Enter" && onOpen()}
      className="cursor-pointer gap-2.5 p-3 transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
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
                  <Badge variant="secondary" className="h-4 rounded-md px-1 text-[10px]">
                    <Package /> helm
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Helm release {e.helmRelease}</TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
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
          <ToneBadge key={`${w.kind}/${w.name}`} tone={w.ready >= w.desired && w.desired > 0 ? "ok" : w.ready > 0 ? "warn" : "bad"} title={`${w.kind} ${w.name}`}>
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
                <Badge variant="outline" className="rounded-md font-normal text-muted-foreground">
                  {x.kind}: {x.host || x.addresses[0] || (x.port ? String(x.port) : "")}
                  {x.path && x.path !== "/" ? x.path : ""}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">{x.url || exposureLabel(x)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------- Dense table ---------- */
export function CatalogTablePage() {
  const { clusterId } = useParams({ strict: false }) as { clusterId: string };
  const { catalog, error, entries, stats, filters } = useFilteredCatalog(clusterId);
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
    { id: "wl", header: "Workloads", cell: (e) => e.workloads.map((w) => `${w.kind}/${w.name} ${w.ready}/${w.desired}`).join(", ") || <span className="text-muted-foreground">—</span>, mono: true },
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
    <div className="h-full space-y-4 overflow-y-auto p-3 md:p-5">
      <PageHeader title="Service Catalog" version={catalog?.version} f={filters} />
      <ErrorCallout message={error} />
      <StatTiles s={stats} />
      {!catalog && !error && <Loading label="Waiting for catalog from agent…" />}
      {catalog && (
        <SimpleTable
          rows={entries}
          columns={cols}
          rowKey={(e) => e.id}
          onRowClick={(e) => open({ gvr: { group: "", version: "v1", resource: "services" }, namespace: e.namespace, name: e.name, kind: "Service" })}
          emptyText="No services match"
        />
      )}
    </div>
  );
}
