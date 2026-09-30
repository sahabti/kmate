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
import { loadRealmAssets, type RealmIndex } from "./assets";
import { RealmRenderer, type Target } from "./renderer";
import { buildWorld, TILE, type CatalogLite, type World } from "./world";
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
  const [index, setIndex] = useState<RealmIndex | null>(null);
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
    });
  }, [nodes.items, nodes.synced, pods.items, pods.synced, deployments.items, statefulsets.items, daemonsets.items, jobs.items, cronjobs.items, services.items, pvcs.items, configmaps.items, secrets.items, catalogLite, showSystem]);

  const handleRef = useRef<PixiHandle | null>(null);
  const rendererRef = useRef<RealmRenderer | null>(null);
  const fittedRef = useRef(false);
  const worldRef = useRef<World | null>(null);
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
    const idx = await loadRealmAssets();
    setIndex(idx);
    if (!idx.available) return;
    const r = new RealmRenderer(h.app, h.world, {
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

  const onDispose = useCallback(() => { rendererRef.current?.destroy(); rendererRef.current = null; handleRef.current = null; fittedRef.current = false; }, []);

  useEffect(() => {
    const r = rendererRef.current, h = handleRef.current;
    if (!r || !h || !world) return;
    r.sync(world);
    if (!fittedRef.current) { fitWorld(h, world); fittedRef.current = true; }
  }, [world]);

  useEffect(() => { rendererRef.current?.setDim(namespace); }, [namespace, world]);

  const zoomIn = () => handleRef.current?.camera.zoomIn();
  const zoomOut = () => handleRef.current?.camera.zoomOut();
  const reset = () => { const h = handleRef.current; if (h && world) fitWorld(h, world); };

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden">
      {index && !index.available && (
        <div className="absolute inset-x-0 top-0 z-10 p-4">
          <Callout variant="warning" title="Realm assets not installed">
            The Cute Fantasy art is not redistributable, so it is not in the repository. Set <code>KMATE_ASSETS_DIR</code> to your copy of the packs and run <code>pnpm realm:assets</code> (it also runs before <code>dev</code>/<code>build</code>). {index.reason}
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
              <div><b className="text-foreground">Wooden house</b> = Deployment · <b className="text-foreground">stone house</b> = StatefulSet · <b className="text-foreground">tent</b> = DaemonSet</div>
              <div><b className="text-foreground">Mine</b> = Job · <b className="text-foreground">windmill</b> = CronJob · <b className="text-foreground">mushroom house</b> = other controller</div>
              <div><b className="text-foreground">Villagers</b> = pods; a red slime attacks a crashing pod, a bubble marks not-ready/pending</div>
              <div><b className="text-foreground">Signpost</b> = Service · <b className="text-foreground">bridge</b> = exposed URL (blue banner = TLS) · <b className="text-foreground">chests</b> = ConfigMaps/Secrets</div>
              <div>Ring under a building: green all ready · amber partial · red none · grey scaled to 0</div>
              <div>Villagers are visible at every zoom level. Only realms with more than 1,500 pods hide them at ×1 and show a <b>ready/desired</b> badge on each house instead</div>
              <div className="flex items-center justify-between pt-1">
                <label className="flex items-center gap-2"><Switch checked={showSystem} onCheckedChange={setShowSystem} /> show system villages</label>
                <a className="inline-flex items-center gap-1 hover:underline" href="https://kenmi-art.itch.io/cute-fantasy-rpg" target="_blank" rel="noreferrer">Art: Cute Fantasy by Kenmi <ExternalLink className="size-3" /></a>
              </div>
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
