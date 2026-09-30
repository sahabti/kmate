import { useEffect, useRef } from "react";
import { Application, Container, TextureStyle } from "pixi.js";
import { Camera } from "./camera";

export interface PixiHandle { app: Application; world: Container; camera: Camera }

/**
 * Owns a Pixi Application sized to its parent. `onReady` is called once with the
 * app, a world container (camera target) and the camera; `onDispose` before teardown.
 */
export function PixiCanvas({ onReady, onDispose, className }: { onReady: (h: PixiHandle) => void | Promise<void>; onDispose?: (h: PixiHandle) => void; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  const disposeRef = useRef(onDispose);
  readyRef.current = onReady;
  disposeRef.current = onDispose;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let handle: PixiHandle | null = null;
    let ro: ResizeObserver | null = null;
    const app = new Application();
    (async () => {
      // Pixel art everywhere: every texture created from now on (incl. render textures) uses nearest filtering.
      TextureStyle.defaultOptions.scaleMode = "nearest";
      await app.init({
        background: 0x1b2838,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        roundPixels: true, // snap sprites to device pixels so pixel art never lands on half pixels
        preference: "webgl",
        powerPreference: "high-performance",
        width: Math.max(1, host.clientWidth),
        height: Math.max(1, host.clientHeight),
      });
      if (cancelled) { app.destroy(true); return; }
      app.canvas.style.display = "block";
      app.canvas.style.imageRendering = "pixelated";
      host.appendChild(app.canvas);
      const world = new Container();
      world.sortableChildren = false;
      app.stage.addChild(world);
      const camera = new Camera(world, app.canvas, () => ({ w: app.screen.width, h: app.screen.height }));
      camera.attach();
      handle = { app, world, camera };
      ro = new ResizeObserver(() => {
        const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
        app.renderer.resize(w, h);
        camera.apply();
      });
      ro.observe(host);
      await readyRef.current(handle);
    })().catch((e) => console.error("[pixi-canvas] failed", e));
    return () => {
      cancelled = true;
      ro?.disconnect();
      if (handle) {
        disposeRef.current?.(handle);
        handle.camera.detach();
        try { handle.app.destroy(true, { children: true }); } catch { /* ignore */ }
      }
    };
  }, []);

  return <div ref={hostRef} className={className ?? "h-full w-full"} />;
}
