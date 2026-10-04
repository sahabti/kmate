/**
 * Realm View page: live Kubernetes objects → world model → Pixi renderer.
 */
import "@fontsource/pixelify-sans/400.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink, Maximize2, Minus, Plus, Castle, ChevronDown, ChevronUp } from "lucide-react";
import { useCapabilities, useCatalog, useWatch } from "@/api/hooks";
import { useUI } from "@/store/ui";
import { useDrawer } from "@/store/drawer";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Callout } from "@/components/callout";
import { PixiCanvas, type PixiHandle } from "./PixiCanvas";
import { loadTheme, loadThemesIndex, type Theme, type ThemesIndex } from "./theme";
import { useRealmTheme } from "@/store/realmTheme";
import { RealmRenderer, type Target } from "./renderer";
import { buildWorld, TILE, type CatalogLite, type World } from "./world";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { platform } from "@/platform";

const g = (group: string, version: string, resource: string) => ({ group, version, resource });

export function RealmViewPage() {
  const { clusterId } = useParams({ from: "/c/$clusterId" });
  const navigate = useNavigate();
  const { namespace } = useUI();
  const openDrawer = useDrawer((s) => s.open);
  const caps = useCapabilities(clusterId);
  const [showSystem, setShowSystem] = useState(false);
  const [legend, setLegend] = useState(() => typeof window === "undefined" || window.innerWidth >= 768);
  const [index, setIndex] = useState<ThemesIndex | null>(null);
  const themeId = useRealmTheme((s) => s.themeId);
  const setThemeId = useRealmTheme((s) => s.setTheme);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // Live data. Every kind is a live watch; they all share one multiplexed WebSocket per
  // cluster (src/api/watchMux.ts), so the count of watches does not matter. columnsOnly
  // keeps payloads small and secrets are names only.
  const pods = useWatch(clusterId, g("", "v1", "pods"), "", { columnsOnly: true });
  const nodes = useWatch(clusterId, g("", "v1", "nodes"), "", { columnsOnly: true });
  const deployments = useWatch(clusterId, g("apps", "v1", "deployments"), "", { columnsOnly: true });
  const statefulsets = useWatch(clusterId, g("apps", "v1", "statefulsets"), "", { columnsOnly: true });
  const daemonsets = useWatch(clusterId, g("apps", "v1", "daemonsets"), "", { columnsOnly: true });
  const jobs = useWatch(clusterId, g("batch", "v1", "jobs"), "", { columnsOnly: true });
  const cronjobs = useWatch(clusterId, g("batch", "v1", "cronjobs"), "", { columnsOnly: true });
  const services = useWatch(clusterId, g("", "v1", "services"), "", { columnsOnly: true });
  const pvcs = useWatch(clusterId, g("", "v1", "persistentvolumeclaims"), "", { columnsOnly: true });
  const configmaps = useWatch(clusterId, g("", "v1", "configmaps"), "", { columnsOnly: true });
  const secrets = useWatch(clusterId, g("", "v1", "secrets"), "", { columnsOnly: true });
  const { catalog } = useCatalog(clusterId);

  const catalogLite = useMemo<CatalogLite[]>(
    () => (catalog?.entries ?? []).map((e) => ({ namespace: e.namespace, name: e.name, health: e.health as number, exposures: e.exposures.map((x) => ({ kind: x.kind, url: x.url, host: x.host, tls: x.tls })) })),
    [catalog],
  );

  const world = useMemo<World | null>(() => {
    if (!nodes.synced || !pods.synced) return null;
    return buildWorld({
      nodes: nodes.items, pods: pods.items, deployments: deployments.items, statefulsets: statefulsets.items, daemonsets: daemonsets.items,
      jobs: jobs.items, cronjobs: cronjobs.items, services: services.items, pvcs: pvcs.items, configmaps: configmaps.items, secrets: secrets.items,
      catalog: catalogLite, showSystem,
      footprint: theme ? (role, variant) => theme.footprint(role, variant) : undefined,
    });
  }, [theme, nodes.items, nodes.synced, pods.items, pods.synced, deployments.items, statefulsets.items, daemonsets.items, jobs.items, cronjobs.items, services.items, pvcs.items, configmaps.items, secrets.items, catalogLite, showSystem]);

  const handleRef = useRef<PixiHandle | null>(null);
  const rendererRef = useRef<RealmRenderer | null>(null);
  const fittedRef = useRef(false);
  const worldRef = useRef<World | null>(null);
  const themeRef = useRef<Theme | null>(null);
  const themeIdRef = useRef(themeId);
  themeIdRef.current = themeId;
  worldRef.current = world;

  const describe = useCallback((t: Target): string[] => {
    switch (t.type) {
      case "building": return [`${t.b.apiKind} ${t.b.name}`, `ns ${t.b.namespace}`, `${t.b.ready}/${t.b.desired} ready · ${t.b.health}`];
      case "actor": return [`Pod ${t.a.name}`, `ns ${t.a.namespace}${t.a.node ? ` · ${t.a.node}` : ""}`, t.a.statusText + (t.a.restarts ? ` · ${t.a.restarts} restarts` : "")];
      case "signpost": return [`Service ${t.s.service}`, `ns ${t.s.namespace} · ${t.s.type}`, t.s.exposed ? "exposed (see bridge)" : t.s.ready ? "healthy" : "no ready endpoints"];
      case "bridge": return [`${t.br.tls ? "https" : "http"} · ${t.br.service}`, t.br.url, "click to open"];
      case "island": return [`Node ${t.i.node}`, t.i.ready ? "Ready" : "NotReady", `${t.i.plots.length} plots${t.i.cordoned ? " · cordoned" : ""}${t.i.controlPlane ? " · control-plane" : ""}`];
      case "plot": return [`Namespace ${t.p.namespace}`, `${t.p.buildings.length} buildings · ${t.p.signposts.length} services`];
      case "prop": return [`${t.p.apiKind} ${t.p.name}`, `ns ${t.p.namespace}`, t.p.more ? `+${t.p.more} more ${t.p.apiKind}s · click to list` : t.p.apiKind === "Secret" ? "golden chest · values stay masked" : "click to open"];
    }
  }, []);

  const [diag, setDiag] = useState("");
  const onReady = useCallback(async (h: PixiHandle) => {
    handleRef.current = h;
    const idx = await loadThemesIndex();
    setIndex(idx);
    const available = idx.themes.filter((t) => t.available);
    if (!available.length) return;
    const wanted = available.find((t) => t.id === themeIdRef.current) ?? available.find((t) => t.id === idx.defaultTheme) ?? available[0]!;
    let th: Theme;
    try { th = await loadTheme(h.app, wanted.id); } catch (e) { console.error("[realm] theme load failed", e); return; }
    themeRef.current = th;
    setTheme(th);
    const r = new RealmRenderer(h.app, h.world, th, {
      isDrag: () => h.camera.wasDrag(),
      viewport: () => h.camera.viewport(),
      onHover: (t, sx, sy) => {
        if (!t) { r.hideTooltip(); setHover(null); return; }
        r.showTooltip(describe(t), sx, sy);
        setHover(t.type);
      },
      onClick: (t) => {
        switch (t.type) {
          case "building": if (t.b.gvr.resource) openDrawer({ gvr: t.b.gvr, namespace: t.b.namespace, name: t.b.name, kind: t.b.apiKind }); break;
          case "actor": openDrawer({ gvr: g("", "v1", "pods"), namespace: t.a.namespace, name: t.a.name, kind: "Pod" }); break;
          case "signpost": openDrawer({ gvr: g("", "v1", "services"), namespace: t.s.namespace, name: t.s.service, kind: "Service" }); break;
          case "bridge": platform.openExternal(t.br.url); break;
          case "island": openDrawer({ gvr: g("", "v1", "nodes"), namespace: "", name: t.i.node, kind: "Node" }); break;
          case "plot": openDrawer({ gvr: g("", "v1", "namespaces"), namespace: "", name: t.p.namespace, kind: "Namespace" }); break;
          case "prop":
            if (!t.p.apiKind) break;
            if (t.p.more) navigate({ to: `/c/${clusterId}/r/core/v1/${t.p.apiKind === "Secret" ? "secrets" : "configmaps"}` as string });
            else openDrawer({ gvr: g("", "v1", t.p.apiKind === "Secret" ? "secrets" : "configmaps"), namespace: t.p.namespace!, name: t.p.name!, kind: t.p.apiKind });
            break;
        }
      },
    });
    rendererRef.current = r;
    if (import.meta.env.DEV) (window as unknown as { __realm?: unknown }).__realm = { actors: () => r.actorSys.snapshot(), world: () => worldRef.current, camera: h.camera, app: h.app };
    // Text is rasterised at renderer resolution × zoom so glyphs stay sharp at every zoom level.
    const syncText = () => { r.setTextResolution(h.app.renderer.resolution * h.camera.zoom); r.setZoom(h.camera.zoom); };
    h.camera.onChange(syncText);
    syncText();
    const gl = (() => { try { const c = h.app.canvas as HTMLCanvasElement; const ctx = c.getContext("webgl2") ?? c.getContext("webgl"); const dbg = ctx?.getExtension("WEBGL_debug_renderer_info"); return dbg && ctx ? String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "n/a"; } catch { return "n/a"; } })();
    const updDiag = () => { const c = h.app.canvas as HTMLCanvasElement; setDiag(`dpr ${window.devicePixelRatio} · res ${h.app.renderer.resolution} · canvas ${c.width}×${c.height} for ${c.clientWidth}×${c.clientHeight} css · zoom ×${h.camera.zoom} · ${gl.slice(0, 40)}`); };
    h.camera.onChange(updDiag);
    updDiag();
    if (worldRef.current) {
      r.sync(worldRef.current);
      fitWorld(h, worldRef.current);
      fittedRef.current = true;
    }
  }, [describe, openDrawer, navigate, clusterId]);

  // live theme swap: load the art, hand it to the renderer, rebuild every sprite
  useEffect(() => {
    const h = handleRef.current, r = rendererRef.current;
    if (!h || !r || !themeId || themeId === themeRef.current?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const th = await loadTheme(h.app, themeId);
        if (cancelled) return;
        themeRef.current = th;
        setTheme(th);
        if (worldRef.current) r.setTheme(th, worldRef.current);
      } catch (e) { console.error("[realm] theme swap failed", e); }
    })();
    return () => { cancelled = true; };
  }, [themeId]);

  const onDispose = useCallback(() => { rendererRef.current?.destroy(); rendererRef.current = null; handleRef.current = null; fittedRef.current = false; }, []);

  useEffect(() => {
    const r = rendererRef.current, h = handleRef.current;
    if (!r || !h || !world) return;
    r.sync(world);
    if (!fittedRef.current) { fitWorld(h, world); fittedRef.current = true; }
  }, [world]);

  useEffect(() => { rendererRef.current?.setDim(namespace); }, [namespace, world]);

  // What the legend explains, in render order. The noun and the swatch both come
  // from the active theme, so switching themes re-labels and re-draws the key.
  const LEGEND_ROLES: Array<{ role: string; means: string }> = [
    { role: "building.deployment.t2", means: "Deployment" },
    { role: "building.statefulset.t2", means: "StatefulSet" },
    { role: "building.daemonset", means: "DaemonSet" },
    { role: "building.job", means: "Job" },
    { role: "building.cronjob", means: "CronJob" },
    { role: "building.custom", means: "other controller" },
    { role: "actor.villager", means: "pod" },
    { role: "monster.crash", means: "crashing pod" },
    { role: "decor.sign", means: "Service" },
    { role: "decor.bridge", means: "exposed URL" },
    { role: "prop.configmap", means: "ConfigMap" },
    { role: "prop.secret", means: "Secret" },
  ];

  // Render each legend role to a data URL once per theme so the key shows the real art.
  const [swatches, setSwatches] = useState<Record<string, string>>({});
  useEffect(() => {
    const h = handleRef.current;
    if (!h || !theme) { setSwatches({}); return; }
    const out: Record<string, string> = {};
    for (const { role } of LEGEND_ROLES) {
      if (!theme.has(role)) continue;
      try {
        const canvas = h.app.renderer.extract.canvas(theme.texture(role, "legend")) as HTMLCanvasElement;
        if (canvas.width && canvas.height) out[role] = canvas.toDataURL();
      } catch { /* a role without a drawable texture just shows its noun */ }
    }
    setSwatches(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  const activeInfo = index?.themes.find((t) => t.id === theme?.id) ?? null;

  const zoomIn = () => handleRef.current?.camera.zoomIn();
  const zoomOut = () => handleRef.current?.camera.zoomOut();
  const reset = () => { const h = handleRef.current; if (h && world) fitWorld(h, world); };

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden">
      {index && !index.themes.some((t) => t.available) && (
        <div className="absolute inset-x-0 top-0 z-10 p-4">
          <Callout variant="warning" title="No Realm theme available">
            No theme published any art. Run <code>pnpm realm:assets</code> (it also runs before <code>dev</code> and <code>build</code>). {index.themes.map((t) => t.reason).filter(Boolean).join(" · ")}
          </Callout>
        </div>
      )}
      {!caps.online && caps.known && (
        <div className="absolute inset-x-0 top-0 z-10 p-4"><Callout variant="neutral" title="Cluster offline">The realm shows the last known state. The agent is not connected.</Callout></div>
      )}
      <PixiCanvas onReady={onReady} onDispose={onDispose} className="h-full w-full" />

      {/* controls */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
        <Button size="icon" variant="secondary" onClick={zoomIn} aria-label="Zoom in"><Plus /></Button>
        <Button size="icon" variant="secondary" onClick={zoomOut} aria-label="Zoom out"><Minus /></Button>
        <Button size="icon" variant="secondary" onClick={reset} aria-label="Reset view"><Maximize2 /></Button>
      </div>

      {/* status strip */}
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 text-xs text-white/80 drop-shadow">
        <Castle className="size-4" />
        {world ? <span>{world.islands.length} islands · {world.counts.namespaces} villages · {world.counts.buildings} buildings · {world.counts.pods} villagers{world.shore.length ? ` · ${world.shore.length} waiting on the shore` : ""}</span> : <span>Surveying the realm…</span>}
        {diag && <span className="ml-3 text-[10px] text-muted-foreground/70" title="render diagnostics">{diag}</span>}
        {hover && <span className="text-white/50">· {hover}</span>}
      </div>

      {/* legend */}
      <Card className="absolute bottom-[4.25rem] left-3 z-10 w-72 md:bottom-3 max-w-[calc(100%-1.5rem)] bg-background/90 py-2 backdrop-blur">
        <CardContent className="px-3 text-xs">
          <button type="button" className="flex w-full items-center justify-between font-medium" onClick={() => setLegend((v) => !v)}>
            Legend {legend ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
          </button>
          {legend && (
            <div className="mt-2 space-y-1 text-muted-foreground">
              <div><b className="text-foreground">Island</b> = node · <b className="text-foreground">fenced village</b> = namespace</div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 py-1">
                {LEGEND_ROLES.filter((e) => theme?.has(e.role)).map((e) => (
                  <div key={e.role} className="flex items-center gap-1.5" title={theme?.label(e.role) || e.means}>
                    <span className="flex size-6 shrink-0 items-center justify-center">
                      {swatches[e.role] ? (
                        <img src={swatches[e.role]} alt={theme?.label(e.role) || e.means} className="max-h-6 max-w-6 object-contain" style={{ imageRendering: "pixelated" }} />
                      ) : (
                        <span className="size-2 rounded-full bg-muted-foreground/40" />
                      )}
                    </span>
                    <span className="truncate">{e.means}</span>
                  </div>
                ))}
              </div>
              <div>A bubble marks a not-ready or pending pod · a blue banner on a bridge means TLS</div>
              <div>Ring under a building: green all ready · amber partial · red none · grey scaled to 0</div>
              <div>Villagers are visible at every zoom level. Only realms with more than 1,500 pods hide them at ×1 and show a <b>ready/desired</b> badge on each house instead</div>
              <div className="flex items-center justify-between gap-2 pt-1">
                <label className="flex items-center gap-2"><Switch checked={showSystem} onCheckedChange={setShowSystem} /> show system villages</label>
                {index && index.themes.filter((t) => t.available).length > 1 && (
                  <Select value={theme?.id ?? ""} onValueChange={setThemeId}>
                    <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs" aria-label="Realm theme"><SelectValue placeholder="Theme" /></SelectTrigger>
                    <SelectContent>
                      {index.themes.filter((t) => t.available).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
              {activeInfo && (
                <div className="pt-0.5">
                  <a className="inline-flex items-center gap-1 hover:underline" href={activeInfo.url} target="_blank" rel="noreferrer">
                    Art: {activeInfo.name}{activeInfo.author ? ` by ${activeInfo.author}` : ""} <ExternalLink className="size-3" />
                  </a>
                  <div className="text-[10px] opacity-70">{activeInfo.license}</div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function fitWorld(h: PixiHandle, w: World) {
  const b = w.bounds;
  h.camera.fit(0, 0, b.w * TILE, b.h * TILE);
}
