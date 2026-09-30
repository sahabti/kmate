/**
 * Dev gallery: renders every manifest entry with its frame grid and declared
 * animations so sheet layouts can be verified visually.
 */
import { useState } from "react";
import { AnimatedSprite, Container, Graphics, Sprite, Text, TextStyle } from "pixi.js";
import { PixiCanvas, type PixiHandle } from "./PixiCanvas";
import { anchorOf, getAnim, getSprite, getTexture, gridOf, loadRealmAssets, type ManifestEntry } from "./assets";
import { Callout } from "@/components/callout";

const label = new TextStyle({ fontFamily: "monospace", fontSize: 10, fill: 0xffffff });
const tiny = new TextStyle({ fontFamily: "monospace", fontSize: 7, fill: 0xffee88 });

function drawEntry(e: ManifestEntry, y: number, root: Container): number {
  const c = new Container();
  c.position.set(8, y);
  root.addChild(c);
  const title = new Text({ text: `${e.id}  (${e.kind}, ${e.src})`, style: label });
  c.addChild(title);
  let h = 14;
  const tex = getTexture(e.id);
  if (e.kind === "image") {
    const s = new Sprite(tex);
    s.position.set(0, h);
    c.addChild(s);
    let x = tex.width + 8;
    for (const [name, r] of Object.entries(e.sprites ?? {})) {
      const sp = new Sprite(getSprite(e.id, name));
      sp.position.set(x, h);
      c.addChild(sp);
      const t = new Text({ text: name, style: tiny });
      t.position.set(x, h + r.h + 1);
      c.addChild(t);
      x += r.w + 8;
    }
    h += Math.max(tex.height, ...Object.values(e.sprites ?? {}).map((r) => r.h + 9)) + 6;
  } else if (e.kind === "sheet" || e.kind === "tiles") {
    const { cols, rows, fw, fh } = gridOf(e.id);
    const s = new Sprite(tex);
    s.position.set(0, h);
    c.addChild(s);
    const g = new Graphics();
    for (let r = 0; r < rows; r++)
      for (let col = 0; col < cols; col++) g.rect(col * fw, h + r * fh, fw, fh).stroke({ color: 0xff00ff, alpha: 0.35, width: 1 });
    c.addChild(g);
    for (let r = 0; r < rows; r++) {
      const t = new Text({ text: String(r), style: tiny });
      t.position.set(-8 + 2, h + r * fh);
      c.addChild(t);
    }
    // animations to the right of the sheet
    let x = tex.width + 16;
    const anchor = anchorOf(e.id);
    for (const name of Object.keys(e.anims ?? {})) {
      const a = getAnim(e.id, name);
      const as = new AnimatedSprite(a.frames);
      as.animationSpeed = a.fps / 60;
      as.loop = true;
      as.anchor.set(anchor.x, anchor.y);
      as.position.set(x + fw * anchor.x, h + fh * anchor.y);
      as.play();
      c.addChild(as);
      const box = new Graphics().rect(x, h, fw, fh).stroke({ color: 0x44ff88, alpha: 0.5, width: 1 });
      c.addChild(box);
      const t = new Text({ text: name, style: tiny });
      t.position.set(x, h + fh + 1);
      c.addChild(t);
      x += fw + 10;
    }
    for (const [name] of Object.entries(e.sprites ?? {})) {
      const sp = new Sprite(getSprite(e.id, name));
      sp.position.set(x, h);
      c.addChild(sp);
      const t = new Text({ text: name, style: tiny });
      t.position.set(x, h + sp.height + 1);
      c.addChild(t);
      x += sp.width + 10;
    }
    h += tex.height + 12;
  }
  return y + h + 10;
}

export function RealmGalleryPage() {
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  const [reason, setReason] = useState("");
  const params = new URLSearchParams(window.location.search);
  const [filter, setFilter] = useState(params.get("filter") ?? "");
  const zoom = Number(params.get("zoom") ?? 2);

  const onReady = async (h: PixiHandle) => {
    const idx = await loadRealmAssets();
    if (!idx.available) {
      setState("missing");
      setReason(idx.reason ?? "");
      return;
    }
    setState("ok");
    let y = 8;
    const entries = (idx.entries ?? []).filter((e) => e.kind !== "font" && (!filter || filter.split(",").some((f) => e.id.includes(f.trim()))));
    for (const e of entries) y = drawEntry(e, y, h.world);
    h.camera.zoom = [1, 2, 3, 4].includes(zoom) ? zoom : 2;
    h.camera.apply();
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
        Realm asset gallery — magenta grid = frames, green box = declared animation. Drag to pan, ⌘/Ctrl+wheel to zoom.
        <input className="ml-auto rounded border bg-background px-2 py-0.5" placeholder="filter id…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {state === "missing" && <div className="p-4"><Callout variant="warning" title="Realm assets not installed">{reason} Run <code>pnpm realm:assets</code> with KMATE_ASSETS_DIR pointing at the Cute Fantasy packs.</Callout></div>}
      <PixiCanvas key={filter} onReady={onReady} className="min-h-0 flex-1" />
    </div>
  );
}
