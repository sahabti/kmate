/**
 * Realm asset loader. Reads /realm/index.json (written by scripts/realm-assets.mjs),
 * loads textures with nearest-neighbour scaling and exposes frame/animation lookups.
 * Art: Cute Fantasy by Kenmi — not redistributable, never committed.
 */
import { Assets, Rectangle, Texture, TextureSource, type TextureSourceOptions } from "pixi.js";

export interface AnimDef { row: number; from: number; to: number; fps: number; loop?: boolean }
export interface RectDef { x: number; y: number; w: number; h: number }
export interface NineSliceDef extends RectDef { left: number; top: number; right: number; bottom: number }
export interface ManifestEntry {
  id: string;
  src: string;
  url: string;
  kind: "sheet" | "image" | "tiles" | "font";
  frame?: { w: number; h: number };
  anchor?: { x: number; y: number };
  anims?: Record<string, AnimDef>;
  sprites?: Record<string, RectDef>;
  nineSlice?: NineSliceDef;
}
export interface RealmIndex { available: boolean; reason?: string; attribution?: string; entries?: ManifestEntry[] }

const textures = new Map<string, Texture>();
const frameCache = new Map<string, Texture>();
let index: RealmIndex | null = null;
let loading: Promise<RealmIndex> | null = null;

export function realmIndex(): RealmIndex | null {
  return index;
}

/** Load index.json + every texture once. Safe to call repeatedly. */
export function loadRealmAssets(): Promise<RealmIndex> {
  if (loading) return loading;
  loading = (async () => {
    const res = await fetch("/realm/index.json", { cache: "no-cache" });
    const idx: RealmIndex = res.ok ? await res.json() : { available: false, reason: `index.json ${res.status}` };
    if (idx.available && idx.entries) {
      const pngs = idx.entries.filter((e) => e.kind !== "font");
      const font = idx.entries.find((e) => e.kind === "font");
      const opts: Partial<TextureSourceOptions> = { scaleMode: "nearest" };
      await Promise.all(
        pngs.map(async (e) => {
          const tex = await Assets.load<Texture>({ alias: `realm:${e.id}`, src: e.url, data: opts });
          tex.source.scaleMode = "nearest";
          tex.source.autoGenerateMipmaps = false;
          textures.set(e.id, tex);
        }),
      );
      try { await (document.fonts as FontFaceSet).load('12px "Pixelify Sans"'); } catch { /* fallback fonts */ }
      if (font) {
        try {
          const ff = new FontFace("CuteFantasy", `url(${font.url})`);
          await ff.load();
          (document.fonts as FontFaceSet).add(ff);
        } catch (err) {
          console.warn("realm: font failed", err);
        }
      }
    }
    index = idx;
    return idx;
  })();
  return loading;
}

export function entry(id: string): ManifestEntry | undefined {
  return index?.entries?.find((e) => e.id === id);
}

export function getTexture(id: string): Texture {
  const t = textures.get(id);
  if (!t) throw new Error(`realm: texture ${id} not loaded`);
  return t;
}

function sub(base: Texture, key: string, r: RectDef): Texture {
  const k = `${key}`;
  let t = frameCache.get(k);
  if (!t) {
    t = new Texture({ source: base.source as TextureSource, frame: new Rectangle(r.x, r.y, r.w, r.h) });
    frameCache.set(k, t);
  }
  return t;
}

/** Frame (col,row) of a sheet/tiles entry. */
export function getTile(id: string, col: number, row: number): Texture {
  const e = entry(id);
  const base = getTexture(id);
  const fw = e?.frame?.w ?? 16;
  const fh = e?.frame?.h ?? 16;
  return sub(base, `${id}#${col},${row}`, { x: col * fw, y: row * fh, w: fw, h: fh });
}

/** Named sub-rect of an entry (manifest.sprites). */
export function getSprite(id: string, name: string): Texture {
  const e = entry(id);
  const r = e?.sprites?.[name];
  if (!r) return getTexture(id);
  return sub(getTexture(id), `${id}@${name}`, r);
}

/** Frames for a declared animation. */
export function getAnim(id: string, name: string): { frames: Texture[]; fps: number; loop: boolean } {
  const e = entry(id);
  const a = e?.anims?.[name];
  if (!a) {
    // fall back to the first frame so a bad manifest still renders something
    return { frames: [getTile(id, 0, 0)], fps: 1, loop: true };
  }
  const frames: Texture[] = [];
  for (let c = a.from; c <= a.to; c++) frames.push(getTile(id, c, a.row));
  return { frames, fps: a.fps, loop: a.loop !== false };
}

export function hasAnim(id: string, name: string): boolean {
  return !!entry(id)?.anims?.[name];
}

export function anchorOf(id: string): { x: number; y: number } {
  return entry(id)?.anchor ?? { x: 0.5, y: 1 };
}

export function nineSliceOf(id: string): { texture: Texture; def: NineSliceDef } | null {
  const e = entry(id);
  if (!e?.nineSlice) return null;
  const d = e.nineSlice;
  return { texture: sub(getTexture(id), `${id}@9`, d), def: d };
}

/** Frame grid dimensions of a sheet. */
export function gridOf(id: string): { cols: number; rows: number; fw: number; fh: number } {
  const e = entry(id);
  const t = getTexture(id);
  const fw = e?.frame?.w ?? t.width;
  const fh = e?.frame?.h ?? t.height;
  return { cols: Math.floor(t.width / fw), rows: Math.floor(t.height / fh), fw, fh };
}
