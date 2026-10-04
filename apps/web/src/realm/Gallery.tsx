/**
 * Dev gallery: renders every role of every available theme with its animations,
 * so a new theme can be checked without opening a cluster.
 * Route: /c/:clusterId/realm/gallery
 */
import { useCallback, useState } from "react";
import { AnimatedSprite, Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { PixiCanvas, type PixiHandle } from "./PixiCanvas";
import { loadTheme, loadThemesIndex, type Theme, type ThemeEntry } from "./theme";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";

const label = new TextStyle({ fontFamily: "monospace", fontSize: 11, fill: 0xffffff });
const tiny = new TextStyle({ fontFamily: "monospace", fontSize: 8, fill: 0xffee88 });

const ANIM_NAMES = ["idle_down", "idle_side", "walk_down", "walk_side", "work", "hurt", "death", "jump", "flow", "open", "spin", "fly", "puff", "fuse", "explode", "blue"];

function drawRole(theme: Theme, role: string, y: number, root: Container): number {
  const c = new Container();
  c.position.set(8, y);
  root.addChild(c);
  const def = theme.def.roles[role];
  const variants: ThemeEntry[] = Array.isArray(def) ? def : def ? [def] : [];
  const title = new Text({ text: `${role}   (${variants.length} variant${variants.length === 1 ? "" : "s"})`, style: label });
  c.addChild(title);
  let h = 15;
  let x = 0, rowH = 0;

  // one still per variant, seeded so each variant is reached.
  // Parts-only roles (fences, cliffs) have no single sprite: show just the parts.
  const partsOnly = variants.every((e) => e.parts && !e.at && !e.rect && !e.compose && !e.frame);
  for (let i = 0; !partsOnly && i < variants.length; i++) {
    const seed = `v${i}`;
    const sp = new Sprite(theme.texture(role, seed));
    sp.scale.set(theme.scale(role, seed));
    sp.position.set(x, h);
    c.addChild(sp);
    x += sp.width + 10;
    rowH = Math.max(rowH, sp.height);
  }
  // named parts
  const parts = variants[0]?.parts ? Object.keys(variants[0].parts!) : [];
  for (const p of parts.slice(0, 20)) {
    const sp = new Sprite(theme.part(role, p));
    sp.position.set(x, h);
    sp.scale.set(2);
    c.addChild(sp);
    const t = new Text({ text: p, style: tiny });
    t.position.set(x, h + sp.height + 1);
    c.addChild(t);
    x += sp.width + 8;
    rowH = Math.max(rowH, sp.height + 10);
  }
  // animations
  for (const name of ANIM_NAMES) {
    if (!theme.hasAnim(role, name)) continue;
    const def2 = theme.anim(role, name)!;
    const a = new AnimatedSprite(def2.frames);
    a.animationSpeed = def2.fps / 60;
    a.play();
    a.position.set(x, h);
    c.addChild(a);
    const t = new Text({ text: name, style: tiny });
    t.position.set(x, h + a.height + 1);
    c.addChild(t);
    x += a.width + 8;
    rowH = Math.max(rowH, a.height + 10);
  }
  if (x === 0) {
    const t = new Text({ text: "(placeholder)", style: tiny });
    t.position.set(0, h);
    c.addChild(t);
    rowH = 14;
  }
  h += rowH + 8;
  const line = new Graphics().moveTo(0, h - 4).lineTo(900, h - 4).stroke({ color: 0x3a4450, width: 1 });
  c.addChild(line);
  return y + h;
}

export function RealmGalleryPage() {
  const [error, setError] = useState<string | null>(null);
  const [themes, setThemes] = useState<string[]>([]);
  const [active, setActive] = useState<string>("");
  const handleRef = useState<{ h: PixiHandle | null }>({ h: null })[0];

  const render = useCallback(async (h: PixiHandle, id: string) => {
    h.world.removeChildren().forEach((c) => c.destroy({ children: true }));
    const theme = await loadTheme(h.app, id);
    const root = new Container();
    h.world.addChild(root);
    let y = 8;
    for (const role of theme.roleNames()) y = drawRole(theme, role, y, root);
    // show the top-left of the list rather than centring on it
    h.camera.fit(0, 0, 960, Math.max(400, y));
  }, []);

  const onReady = useCallback(async (h: PixiHandle) => {
    handleRef.h = h;
    const idx = await loadThemesIndex();
    const ok = idx.themes.filter((t) => t.available).map((t) => t.id);
    setThemes(ok);
    if (!ok.length) { setError("No theme has any art published. Run pnpm realm:assets."); return; }
    const first = ok[0]!;
    setActive(first);
    await render(h, first);
  }, [handleRef, render]);

  return (
    <div className="relative h-[calc(100vh-3.5rem)] w-full overflow-hidden">
      {error && <div className="absolute inset-x-0 top-0 z-10 p-4"><Callout variant="warning" title="Realm gallery">{error}</Callout></div>}
      <div className="absolute left-3 top-3 z-10 flex gap-1">
        {themes.map((t) => (
          <Button key={t} size="sm" variant={t === active ? "default" : "secondary"} onClick={() => { setActive(t); if (handleRef.h) void render(handleRef.h, t); }}>{t}</Button>
        ))}
      </div>
      <PixiCanvas onReady={onReady} className="h-full w-full" />
    </div>
  );
}
