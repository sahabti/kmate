/**
 * Realm View theme engine.
 *
 * The world builder and the renderer only ever ask for **semantic roles**
 * ("building.deployment.t2", "actor.villager", "prop.secret"). A theme maps those
 * roles onto its own art. Swapping themes therefore never touches engine code, and
 * the public repository can ship a CC0 theme while a licensed theme stays local.
 *
 * Contract rules (docs/11-realm-view.md §6):
 *  - Every role is optional. A missing role renders a drawn placeholder sized to the
 *    role's footprint, so a partial theme still works and never crashes.
 *  - Animations are optional. Themes made of static tiles get procedural motion
 *    (bob / flash / shrink / hop) from the renderer instead.
 *  - A role may declare several variants; callers pass a seed string and get a
 *    stable pick, which is how namespaces keep distinct house colours.
 */
import { Assets, Container, Graphics, Rectangle, Sprite, Texture, type Application } from "pixi.js";
import { TILE, fnv1a } from "./world";

export interface AnimDef { row: number; from: number; to: number; fps: number; loop?: boolean }
export interface RectDef { x: number; y: number; w: number; h: number }
export interface Footprint { w: number; h: number; yard: number }

/** One way to draw a role. A role is either a single entry or an array of variants. */
export interface ThemeEntry {
  /** Image file. Relative to the theme directory (bundled) or to KMATE_ASSETS_DIR (external). */
  src?: string;
  /** Sub-rectangle of `src` in pixels. */
  rect?: RectDef;
  /** Grid cell size for `at` / `parts` / `compose`; defaults to the theme tileSize. */
  tile?: { w: number; h: number };
  /** Single grid cell [col, row]. */
  at?: [number, number];
  /** Animation frame size; presence makes this a sheet. */
  frame?: { w: number; h: number };
  anchor?: { x: number; y: number };
  anims?: Record<string, AnimDef>;
  /** Named sub-pieces, e.g. fence corners or cliff edges. */
  parts?: Record<string, [number, number] | RectDef>;
  /** Build one texture from a grid of cells (rows of [col,row] refs). Cell `null` = gap. */
  compose?: Array<Array<[number, number] | null>>;
  /** Footprint in tiles; the world builder uses it for packing. */
  footprint?: Footprint;
  /** Draw scale, for themes whose art is smaller than the realm grid. */
  scale?: number;
  /** Multiply colour, e.g. to recolour a shared sprite per variant. */
  tint?: number;
  /** Solid colour tile instead of art: lets a minimal theme fill sea/ground. */
  color?: number;
}

export interface ThemeDef {
  /** Human nouns for what this theme draws, keyed by role; used by the legend. */
  labels?: Record<string, string>;
  id: string;
  name: string;
  author?: string;
  license?: string;
  url?: string;
  /** Source tile size in px; the engine scales to the realm's 16 px grid. */
  tileSize?: number;
  /** bundled = art committed next to theme.json · external = art from KMATE_ASSETS_DIR */
  source?: "bundled" | "external";
  /** Font file served next to the theme (optional). */
  font?: string;
  roles: Record<string, ThemeEntry | ThemeEntry[]>;
}

export interface ThemeInfo { id: string; name: string; author?: string; license?: string; url?: string; available: boolean; reason?: string }
export interface ThemesIndex { themes: ThemeInfo[]; defaultTheme?: string }

const DEFAULT_FOOTPRINT: Footprint = { w: 6, h: 8, yard: 3 };
const PLACEHOLDER_COLORS = [0x5b6b7c, 0x6d5f7a, 0x4f6b5d, 0x7a6a4f];

/** A resolved, drawable role variant. */
interface Resolved {
  entry: ThemeEntry;
  base: Texture | null;
  tileW: number;
  tileH: number;
}

export class Theme {
  readonly def: ThemeDef;
  private textures = new Map<string, Texture>();
  private frames = new Map<string, Texture>();
  private composed = new Map<string, Texture>();
  private placeholders = new Map<string, Texture>();
  private missing = new Set<string>();
  private app: Application;

  constructor(app: Application, def: ThemeDef, textures: Map<string, Texture>) {
    this.app = app;
    this.def = def;
    this.textures = textures;
  }

  get id() { return this.def.id; }
  get tileSize() { return this.def.tileSize ?? TILE; }

  /** Roles declared by this theme (for the gallery). */
  roleNames(): string[] { return Object.keys(this.def.roles).sort(); }

  has(role: string): boolean {
    const r = this.def.roles[role];
    return Array.isArray(r) ? r.length > 0 : !!r;
  }

  private variants(role: string): ThemeEntry[] {
    const r = this.def.roles[role];
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  }

  /** Pick a variant deterministically from a seed string. */
  private resolve(role: string, seed = "", wantAnim?: string): Resolved | null {
    const vs = this.variants(role);
    if (!vs.length) {
      if (!this.missing.has(role)) {
        this.missing.add(role);
        console.warn(`[realm] theme "${this.def.id}" has no role "${role}" — drawing a placeholder`);
      }
      return null;
    }
    // When an animation is required, prefer a variant that actually has it. This is how
    // a "creating" pod picks a villager that can swing a hammer instead of hopping.
    let pool = vs;
    if (wantAnim) {
      const withAnim = vs.filter((e) => e.anims?.[wantAnim]);
      if (withAnim.length) pool = withAnim;
    }
    const e = pool[fnv1a(seed) % pool.length]!;
    const base = e.src ? this.textures.get(e.src) ?? null : null;
    return { entry: e, base, tileW: e.tile?.w ?? this.tileSize, tileH: e.tile?.h ?? this.tileSize };
  }

  // ---------- textures ----------
  private sub(base: Texture, key: string, r: RectDef): Texture {
    let t = this.frames.get(key);
    if (!t) {
      t = new Texture({ source: base.source, frame: new Rectangle(r.x, r.y, r.w, r.h) });
      this.frames.set(key, t);
    }
    return t;
  }

  private placeholder(role: string): Texture {
    const key = role;
    let t = this.placeholders.get(key);
    if (t) return t;
    const fp = this.footprint(role);
    const w = Math.max(8, Math.min(fp.w, 8) * TILE), h = Math.max(8, Math.min(fp.h, 8) * TILE);
    const color = PLACEHOLDER_COLORS[fnv1a(role) % PLACEHOLDER_COLORS.length]!;
    const g = new Graphics().roundRect(0, 0, w, h, 3).fill({ color, alpha: 0.85 }).roundRect(0.5, 0.5, w - 1, h - 1, 3).stroke({ color: 0x0d1117, width: 1, alpha: 0.8 });
    t = this.app.renderer.generateTexture({ target: g, resolution: 1 });
    t.source.scaleMode = "nearest";
    g.destroy();
    this.placeholders.set(key, t);
    return t;
  }

  private composeTexture(role: string, r: Resolved): Texture {
    const key = `${role}|${r.entry.src}|compose`;
    let t = this.composed.get(key);
    if (t) return t;
    const rows = r.entry.compose!;
    const c = new Container();
    rows.forEach((row, y) =>
      row.forEach((cell, x) => {
        if (!cell || !r.base) return;
        const tex = this.sub(r.base, `${r.entry.src}#${cell[0]},${cell[1]}@${r.tileW}x${r.tileH}`, { x: cell[0] * r.tileW, y: cell[1] * r.tileH, w: r.tileW, h: r.tileH });
        const sp = new Sprite(tex);
        sp.position.set(x * r.tileW, y * r.tileH);
        c.addChild(sp);
      }),
    );
    t = this.app.renderer.generateTexture({ target: c, resolution: 1 });
    t.source.scaleMode = "nearest";
    t.source.autoGenerateMipmaps = false;
    c.destroy({ children: true });
    this.composed.set(key, t);
    return t;
  }

  /** Main texture for a role (first animation frame for sheets). */
  texture(role: string, seed = ""): Texture {
    const r = this.resolve(role, seed);
    if (!r) return this.placeholder(role);
    return this.textureOf(role, r);
  }

  /** Solid colour tile, for themes that fill sea or ground with a flat colour. */
  private colorTile(color: number): Texture {
    const key = `#${color}`;
    let t = this.placeholders.get(key);
    if (t) return t;
    const g = new Graphics().rect(0, 0, TILE, TILE).fill({ color });
    t = this.app.renderer.generateTexture({ target: g, resolution: 1 });
    t.source.scaleMode = "nearest";
    g.destroy();
    this.placeholders.set(key, t);
    return t;
  }

  private textureOf(role: string, r: Resolved): Texture {
    const e = r.entry;
    if (e.color !== undefined && !e.src) return this.colorTile(e.color);
    if (e.compose) return this.composeTexture(role, r);
    if (!r.base) return this.placeholder(role);
    if (e.rect) return this.sub(r.base, `${e.src}@${e.rect.x},${e.rect.y},${e.rect.w},${e.rect.h}`, e.rect);
    if (e.at) return this.sub(r.base, `${e.src}#${e.at[0]},${e.at[1]}@${r.tileW}x${r.tileH}`, { x: e.at[0] * r.tileW, y: e.at[1] * r.tileH, w: r.tileW, h: r.tileH });
    if (e.frame) return this.sub(r.base, `${e.src}#0,0@${e.frame.w}x${e.frame.h}`, { x: 0, y: 0, w: e.frame.w, h: e.frame.h });
    return r.base;
  }

  /** Named sub-piece of a role (fence corners, cliff edges, sign posts…). */
  part(role: string, part: string, seed = ""): Texture {
    const r = this.resolve(role, seed);
    if (r && r.entry.color !== undefined && !r.base) return this.colorTile(r.entry.color);
    if (!r?.base) return this.placeholder(role);
    const p = r.entry.parts?.[part];
    if (!p) return this.textureOf(role, r);
    if (Array.isArray(p)) return this.sub(r.base, `${r.entry.src}#${p[0]},${p[1]}@${r.tileW}x${r.tileH}`, { x: p[0] * r.tileW, y: p[1] * r.tileH, w: r.tileW, h: r.tileH });
    return this.sub(r.base, `${r.entry.src}@${p.x},${p.y},${p.w},${p.h}`, p);
  }

  hasPart(role: string, part: string): boolean {
    return this.variants(role).some((e) => !!e.parts?.[part]);
  }

  /** Animation frames, or null when this theme has no such animation (use procedural motion). */
  anim(role: string, name: string, seed = ""): { frames: Texture[]; fps: number; loop: boolean } | null {
    const r = this.resolve(role, seed, name);
    if (!r?.base) return null;
    const a = r.entry.anims?.[name];
    if (!a || !r.entry.frame) return null;
    const fw = r.entry.frame.w, fh = r.entry.frame.h;
    const frames: Texture[] = [];
    for (let c = a.from; c <= a.to; c++) frames.push(this.sub(r.base, `${r.entry.src}#${c},${a.row}@${fw}x${fh}`, { x: c * fw, y: a.row * fh, w: fw, h: fh }));
    return { frames, fps: a.fps, loop: a.loop !== false };
  }

  hasAnim(role: string, name: string, seed = ""): boolean {
    const r = this.resolve(role, seed, name);
    return !!r?.entry.anims?.[name];
  }

  /** Static single-frame texture to stand in for an animation this theme lacks. */
  still(role: string, seed = ""): Texture {
    return this.texture(role, seed);
  }

  anchor(role: string, seed = ""): { x: number; y: number } {
    return this.resolve(role, seed)?.entry.anchor ?? { x: 0.5, y: 1 };
  }

  scale(role: string, seed = ""): number {
    const e = this.resolve(role, seed)?.entry;
    if (e?.scale) return e.scale;
    return TILE / this.tileSize;
  }

  tint(role: string, seed = ""): number | undefined {
    return this.resolve(role, seed)?.entry.tint;
  }

  /** Footprint in tiles; falls back to a house-sized default. */
  /** The theme's own noun for a role ("stone keep"), or "" when it declares none. */
  label(role: string): string { return this.def.labels?.[role] ?? ""; }

  footprint(role: string, seed = ""): Footprint {
    const e = this.resolve(role, seed)?.entry;
    if (e?.footprint) return e.footprint;
    if (e?.compose) {
      const h = e.compose.length, w = Math.max(...e.compose.map((r) => r.length));
      return { w, h, yard: 3 };
    }
    return DEFAULT_FOOTPRINT;
  }
}

// ---------- loading ----------
let themesIndex: ThemesIndex | null = null;
let indexPromise: Promise<ThemesIndex> | null = null;
const loaded = new Map<string, Theme>();

export function themesIndexSync(): ThemesIndex | null { return themesIndex; }

export function loadThemesIndex(): Promise<ThemesIndex> {
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    try {
      const res = await fetch("/themes/index.json", { cache: "no-cache" });
      themesIndex = res.ok ? await res.json() : { themes: [] };
    } catch {
      themesIndex = { themes: [] };
    }
    return themesIndex!;
  })();
  return indexPromise;
}

/** Load a theme and every texture it references. Safe to call repeatedly. */
export async function loadTheme(app: Application, id: string): Promise<Theme> {
  const cached = loaded.get(id);
  if (cached) return cached;
  const res = await fetch(`/themes/${id}/theme.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`theme ${id}: ${res.status}`);
  const def: ThemeDef = await res.json();
  const srcs = new Set<string>();
  for (const r of Object.values(def.roles)) for (const e of Array.isArray(r) ? r : [r]) if (e.src) srcs.add(e.src);
  const textures = new Map<string, Texture>();
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        const tex = await Assets.load<Texture>({ alias: `theme:${id}:${src}`, src: `/themes/${id}/${src}`, data: { scaleMode: "nearest" } });
        tex.source.scaleMode = "nearest";
        tex.source.autoGenerateMipmaps = false;
        textures.set(src, tex);
      } catch (err) {
        console.warn(`[realm] theme "${id}": ${src} failed to load`, err);
      }
    }),
  );
  if (def.font) {
    try {
      const ff = new FontFace(`RealmFont-${id}`, `url(/themes/${id}/${def.font})`);
      await ff.load();
      (document.fonts as FontFaceSet).add(ff);
    } catch { /* the UI font is the fallback */ }
  }
  const t = new Theme(app, def, textures);
  loaded.set(id, t);
  return t;
}
