/**
 * Syncs a World model to Pixi display objects, layer by layer:
 * sea → islands → plots → props → buildings → actors → weather → ui.
 * Keeps an id → display object map so unchanged things keep their sprites.
 */
import { AnimatedSprite, Container, Graphics, NineSliceSprite, Sprite, Text, TextStyle, Texture, TilingSprite, type Application, type Ticker } from "pixi.js";
import { anchorOf, getAnim, getSprite, getTexture, getTile, hasAnim } from "./assets";
import { TILE, fnv1a, type Actor, type Building, type Bridge, type Health, type Island, type Plot, type Prop, type Rect, type Signpost, type World } from "./world";
import { ActorSystem } from "./actors";

export type Target =
  | { type: "building"; b: Building }
  | { type: "actor"; a: Actor }
  | { type: "signpost"; s: Signpost }
  | { type: "bridge"; br: Bridge }
  | { type: "island"; i: Island }
  | { type: "plot"; p: Plot }
  | { type: "prop"; p: Prop };

export interface RendererCallbacks {
  onHover(t: Target | null, sx: number, sy: number): void;
  onClick(t: Target): void;
  isDrag(): boolean;
  /** visible world rect in px (for culling) */
  viewport(): Rect;
}

const HEALTH_COLOR: Record<Health, number> = { ok: 0x3ddc84, warn: 0xf5b840, bad: 0xf05252, off: 0x8a94a3 };
const FONT = "\"Pixelify Sans\", CuteFantasy, monospace";
const labelStyle = () => new TextStyle({ fontFamily: FONT, fontSize: 12, fill: 0xfff6dc, stroke: { color: 0x1a1210, width: 2 }, letterSpacing: 0 });
const smallStyle = () => new TextStyle({ fontFamily: FONT, fontSize: 9, fill: 0xffffff, stroke: { color: 0x1a1210, width: 2 } });

interface Tween { obj: Container; fx: number; fy: number; sx: number; sy: number; t: number }

export class RealmRenderer {
  readonly sea = new Container();
  readonly ground = new Container();
  readonly plots = new Container();
  readonly props = new Container();
  readonly buildings = new Container();
  readonly actors = new Container();
  readonly fx = new Container();
  readonly weather = new Container();
  readonly ui = new Container();
  readonly actorSys: ActorSystem;
  private badges = new Set<Text>();
  private lodActors = true;
  private objs = new Map<string, Container>();
  private sig = new Map<string, string>();
  private tweens: Tween[] = [];
  private water: TilingSprite | null = null;
  private waterFrames: Texture[] = [];
  private waterT = 0;
  private tooltip: { box: NineSliceSprite | Graphics; text: Text; root: Container } | null = null;
  private dimNs = "";
  private texts = new Set<Text>();
  private textRes = 2;
  private tick = (t: Ticker) => this.update(t);

  /** Register a Text so its raster resolution tracks renderer resolution × camera zoom. */
  private track<T extends Text>(t: T): T {
    t.resolution = this.textRes;
    this.texts.add(t);
    t.on("destroyed", () => this.texts.delete(t));
    return t;
  }

  /** Re-rasterise all text at the given resolution (call on zoom / DPR change). */
  setTextResolution(res: number) {
    const r = Math.max(1, Math.round(res));
    if (r === this.textRes) return;
    this.textRes = r;
    for (const t of this.texts) t.resolution = r;
  }

  constructor(private app: Application, world: Container, private cb: RendererCallbacks) {
    this.actors.sortableChildren = true;
    this.buildings.sortableChildren = true;
    world.addChild(this.sea, this.ground, this.plots, this.props, this.buildings, this.actors, this.fx, this.weather);
    this.actorSys = new ActorSystem({
      layer: this.actors, fx: this.fx,
      track: (t) => this.track(t), smallStyle,
      onHover: (t, sx, sy) => this.cb.onHover(t, sx, sy), onClick: (t) => this.cb.onClick(t), isDrag: () => this.cb.isDrag(),
    });
    app.stage.addChild(this.ui);
    app.stage.eventMode = "static";
    app.stage.hitArea = app.screen;
    app.stage.on("pointermove", (e) => { if (this.tooltip?.root.visible) this.moveTooltip(e.global.x, e.global.y); });
    app.ticker.add(this.tick);
  }

  destroy() {
    this.app.ticker.remove(this.tick);
    this.actorSys.destroyAll();
    this.objs.clear();
  }

  setDim(ns: string) { this.dimNs = ns; this.applyDim(); }

  /** Above this many villagers the ×1 overview switches to ready/desired badges for performance. */
  static readonly LOD_ACTOR_LIMIT = 1500;

  /**
   * Level of detail. Villagers are visible at every zoom level; only very large
   * realms hide them at zoom ×1 (badges on houses take over) to keep 60 fps.
   */
  setZoom(zoom: number) {
    this.zoomLevel = zoom;
    this.applyLod();
  }

  private zoomLevel = 2;
  private applyLod() {
    const showActors = this.zoomLevel >= 2 || this.actorSys.count() <= RealmRenderer.LOD_ACTOR_LIMIT;
    if (showActors !== this.lodActors) {
      this.lodActors = showActors;
      this.actorSys.setVisible(showActors);
    }
    for (const b of this.badges) b.visible = !showActors;
  }

  /** Diff-sync the world. */
  sync(w: World) {
    const keep = new Set<string>();
    this.syncSea(w, keep);
    for (const isl of w.islands) {
      this.syncIsland(isl, keep);
      for (const plot of isl.plots) {
        this.syncPlot(plot, isl, keep);
        for (const b of plot.buildings) this.syncBuilding(b, keep);
        for (const s of plot.signposts) this.syncSignpost(s, keep);
        for (const a of plot.remote) this.syncActor(a, keep);
        for (const p of plot.props) this.syncProp(p, keep);
        for (const b of plot.buildings) {
          for (const a of b.actors) this.syncActor(a, keep);
          for (const p of b.props) this.syncProp(p, keep);
        }
      }
      for (const br of isl.bridges) this.syncBridge(br, keep);
    }
    for (const a of w.shore) this.syncActor(a, keep);
    this.actorSys.retireMissing(keep);
    // remove stale
    for (const [id, obj] of this.objs) {
      if (!keep.has(id)) {
        obj.parent?.removeChild(obj);
        obj.destroy({ children: true });
        this.objs.delete(id);
        this.sig.delete(id);
      }
    }
    this.applyDim();
  }

  // ---------- sea ----------
  private syncSea(w: World, keep: Set<string>) {
    keep.add("sea");
    const wpx = (w.bounds.w + 40) * TILE, hpx = (w.bounds.h + 40) * TILE;
    if (!this.water) {
      this.waterFrames = getAnim("water", "flow").frames;
      this.water = new TilingSprite({ texture: this.waterFrames[0]!, width: wpx, height: hpx });
      this.water.position.set(-20 * TILE, -20 * TILE);
      this.sea.addChild(this.water);
      this.objs.set("sea", this.water);
    } else {
      this.water.width = wpx; this.water.height = hpx;
    }
  }

  // ---------- islands ----------
  private syncIsland(isl: Island, keep: Set<string>) {
    const id = `island/${isl.id}`;
    keep.add(id);
    const s = `${isl.rect.x},${isl.rect.y},${isl.rect.w},${isl.rect.h},${isl.ready},${isl.cordoned},${isl.controlPlane}`;
    if (this.sig.get(id) === s) return;
    this.sig.set(id, s);
    this.objs.get(id)?.destroy({ children: true });
    const c = new Container();
    c.label = id;
    const { x, y, w, h } = isl.rect;
    // plateau tiles from the cliff sheet: block cols 1-3, rows 0-2 top, 3-4 wall, 5 foot
    const tileAt = (col: number, row: number, tx: number, ty: number) => {
      const sp = new Sprite(getTile("cliff", col, row));
      sp.position.set(tx * TILE, ty * TILE);
      c.addChild(sp);
    };
    for (let ty = 0; ty < h; ty++)
      for (let tx = 0; tx < w; tx++) {
        const col = tx === 0 ? 1 : tx === w - 1 ? 3 : 2;
        const row = ty === 0 ? 0 : ty === h - 1 ? 2 : 1;
        tileAt(col, row, x + tx, y + ty);
      }
    for (let tx = 0; tx < w; tx++) {
      const col = tx === 0 ? 1 : tx === w - 1 ? 3 : 2;
      tileAt(col, 3, x + tx, y + h);
      tileAt(col, 4, x + tx, y + h + 1);
      tileAt(col, 5, x + tx, y + h + 2);
    }
    // volcano overlay for NotReady nodes
    if (!isl.ready) {
      const g = new Graphics().rect(x * TILE, y * TILE, w * TILE, h * TILE).fill({ color: 0x5a1e12, alpha: 0.45 });
      c.addChild(g);
      const skull = new AnimatedSprite(getAnim("flying_skull", "fly").frames);
      skull.animationSpeed = 8 / 60; skull.play();
      skull.anchor.set(0.5, 0.6);
      skull.position.set((x + w / 2) * TILE, (y + 2) * TILE);
      c.addChild(skull);
    }
    // control plane lookout tower with flag (top-right corner)
    if (isl.controlPlane) {
      const t = new Sprite(getSprite("lookout_tower", "roof"));
      t.anchor.set(0.5, 0.95);
      t.position.set((x + w - 3) * TILE, (y + 8) * TILE);
      c.addChild(t);
      if (hasAnim("flags", "blue")) {
        const f = new AnimatedSprite(getAnim("flags", "blue").frames);
        f.animationSpeed = 6 / 60; f.play();
        f.anchor.set(0.5, 1);
        f.position.set((x + w - 3) * TILE + 20, (y + 0.6) * TILE);
        c.addChild(f);
      }
    }
    // cordon: palisade gate closed at the south-west + spikes tint
    if (isl.cordoned) {
      const g = new AnimatedSprite(getAnim("palisade_gate", "open").frames);
      g.gotoAndStop(0);
      g.anchor.set(0.5, 0.9);
      g.position.set((x + 4) * TILE, (y + h) * TILE);
      c.addChild(g);
    }
    // bake to a texture (islands are static)
    // Bake at the device resolution and keep nearest filtering: the default for
    // render textures is linear, which blurred every island on Retina screens.
    const tex = this.app.renderer.generateTexture({ target: c, resolution: this.app.renderer.resolution });
    tex.source.scaleMode = "nearest";
    tex.source.autoGenerateMipmaps = false;
    const baked = new Sprite(tex);
    const b = c.getLocalBounds();
    baked.position.set(b.x, b.y);
    c.destroy({ children: true });
    baked.label = id;
    baked.eventMode = "static";
    baked.on("pointerover", (e) => this.cb.onHover({ type: "island", i: isl }, e.global.x, e.global.y));
    baked.on("pointerout", () => this.cb.onHover(null, 0, 0));
    baked.on("pointertap", () => { if (!this.cb.isDrag()) this.cb.onClick({ type: "island", i: isl }); });
    this.ground.addChild(baked);
    this.objs.set(id, baked);
  }

  // ---------- plots ----------
  private syncPlot(plot: Plot, isl: Island, keep: Set<string>) {
    const id = `plot/${plot.id}`;
    keep.add(id);
    const s = `${plot.rect.x},${plot.rect.y},${plot.rect.w},${plot.rect.h},${plot.system},${plot.namespace}`;
    let c = this.objs.get(id);
    if (this.sig.get(id) === s && c) return;
    this.sig.set(id, s);
    c?.destroy({ children: true });
    c = new Container();
    c.label = id;
    (c as Container & { ns?: string }).ns = plot.namespace;
    const { x, y, w, h } = plot.rect;
    const fence = plot.system ? "hedge" : "fences";
    const tile = (col: number, row: number, tx: number, ty: number) => {
      const sp = new Sprite(getTile(fence, col, row));
      sp.position.set(tx * TILE, ty * TILE);
      c!.addChild(sp);
    };
    const gateL = Math.floor(w / 2) - 1, gateR = gateL + 2;
    for (let tx = 0; tx < w; tx++) {
      const top = tx === 0 ? [1, 1] : tx === w - 1 ? [3, 1] : [2, 0];
      tile(top[0]!, top[1]!, x + tx, y);
      if (tx >= gateL && tx < gateR) continue; // gate in the south fence
      const bot = tx === 0 ? [1, 3] : tx === w - 1 ? [3, 3] : [2, 0];
      tile(bot[0]!, bot[1]!, x + tx, y + h - 1);
    }
    for (let ty = 1; ty < h - 1; ty++) { tile(0, 1, x, y + ty); tile(0, 1, x + w - 1, y + ty); }
    // path along the south inside the fence + gate stub
    for (let tx = 1; tx < w - 1; tx++) { const p = new Sprite(getTexture("path_middle")); p.position.set((x + tx) * TILE, (y + h - 2) * TILE); c.addChild(p); }
    for (let tx = gateL; tx < gateR; tx++) { const p = new Sprite(getTexture("path_middle")); p.position.set((x + tx) * TILE, (y + h - 1) * TILE); c.addChild(p); }
    // namespace sign + label
    const post = new Sprite(getSprite("signs", "post_1"));
    post.anchor.set(0.5, 0.95);
    post.position.set((x + 2) * TILE, (y + 3) * TILE);
    c.addChild(post);
    const label = new Text({ text: plot.namespace + (plot.system ? " (system)" : ""), style: labelStyle() });
    this.track(label);
    label.anchor.set(0, 1);
    label.position.set((x + 3.2) * TILE, (y + 1.6) * TILE);
    c.addChild(label);
    const hit = new Graphics().rect(x * TILE, y * TILE, w * TILE, h * TILE).fill({ color: 0xffffff, alpha: 0.001 });
    hit.eventMode = "static";
    hit.on("pointerover", (e) => this.cb.onHover({ type: "plot", p: plot }, e.global.x, e.global.y));
    hit.on("pointerout", () => this.cb.onHover(null, 0, 0));
    c.addChildAt(hit, 0);
    this.plots.addChild(c);
    this.objs.set(id, c);
    void isl;
  }

  // ---------- buildings ----------
  private syncBuilding(b: Building, keep: Set<string>) {
    const id = `b/${b.id}`;
    keep.add(id);
    const s = `${b.sprite}|${b.spriteName ?? ""}|${b.x},${b.y}|${b.health}|${b.ready}/${b.desired}|${b.note ?? ""}`;
    let c = this.objs.get(id);
    if (this.sig.get(id) === s && c) return;
    const existed = !!c;
    const prev = c ? { x: c.x, y: c.y } : null;
    this.sig.set(id, s);
    c?.destroy({ children: true });
    c = new Container();
    c.label = id;
    (c as Container & { ns?: string }).ns = b.namespace;
    const tex = b.spriteName ? getSprite(b.sprite, b.spriteName) : getTexture(b.sprite);
    const sp = new Sprite(tex);
    const a = anchorOf(b.sprite);
    sp.anchor.set(a.x, b.spriteName ? 1 : a.y);
    // health ring under the building
    const ring = new Graphics().ellipse(0, 0, Math.max(24, tex.width * 0.45), 10).fill({ color: HEALTH_COLOR[b.health], alpha: 0.28 }).stroke({ color: HEALTH_COLOR[b.health], alpha: 0.7, width: 1 });
    ring.position.set(0, -2);
    c.addChild(ring, sp);
    if (b.sprite === "windmill") {
      const sail = new AnimatedSprite(getAnim("windmill_sail", "spin").frames);
      sail.anchor.set(0.5, 0.5);
      sail.position.set(6, -tex.height + 30);
      sail.animationSpeed = (b.ready > 0 ? 6 : 0) / 60;
      if (b.ready > 0) sail.play();
      c.addChild(sail);
    }
    if (b.note) {
      const rib = new Sprite(getSprite("ui_ribbons", "flat"));
      rib.anchor.set(0.5, 0.5);
      rib.scale.set(0.5);
      rib.position.set(0, -tex.height * (b.spriteName ? 1 : a.y) - 8);
      const t = new Text({ text: b.note, style: smallStyle() });
      this.track(t);
      t.anchor.set(0.5, 0.5);
      t.position.set(0, rib.y - 1);
      c.addChild(rib, t);
    }
    if (b.kind !== "Job" && b.kind !== "CronJob") {
      // LOD badge: replaces the villagers with a ready/desired count only when they are hidden (huge realms at ×1)
      const badge = this.track(new Text({ text: `${b.ready}/${b.desired}`, style: new TextStyle({ fontFamily: FONT, fontSize: 11, fill: 0xffffff, stroke: { color: HEALTH_COLOR[b.health], width: 3 } }) }));
      badge.anchor.set(0.5, 0);
      badge.position.set(0, 4);
      badge.visible = !this.lodActors;
      badge.on("destroyed", () => this.badges.delete(badge));
      this.badges.add(badge);
      c.addChild(badge);
    }
    c.position.set(b.x, b.y);
    c.zIndex = b.y;
    sp.eventMode = "static";
    sp.cursor = "pointer";
    sp.on("pointerover", (e) => { sp.tint = 0xfff2b0; this.cb.onHover({ type: "building", b }, e.global.x, e.global.y); });
    sp.on("pointerout", () => { sp.tint = 0xffffff; this.cb.onHover(null, 0, 0); });
    sp.on("pointertap", () => { if (!this.cb.isDrag()) this.cb.onClick({ type: "building", b }); });
    this.buildings.addChild(c);
    this.objs.set(id, c);
    if (existed && prev && (prev.x !== b.x || prev.y !== b.y)) this.tween(c, prev.x, prev.y, b.x, b.y);
  }

  // ---------- actors (animated; see actors.ts) ----------
  private syncActor(a: Actor, keep: Set<string>) {
    keep.add(`a/${a.id}`);
    this.actorSys.sync(a);
    this.applyLod(); // actor count may have crossed the LOD threshold
  }

  // ---------- props ----------
  private syncProp(prop: Prop, keep: Set<string>) {
    const { id: id0, kind, x, y } = prop;
    const id = `p/${id0}`;
    keep.add(id);
    const s = `${kind}|${x},${y}|${prop.more ?? 0}`;
    let c = this.objs.get(id);
    if (this.sig.get(id) === s && c) return;
    this.sig.set(id, s);
    c?.destroy({ children: true });
    let sp: Sprite;
    switch (kind) {
      case "chest": sp = new Sprite(getAnim("chest", "open").frames[0]!); sp.anchor.set(0.5, 0.9); break;
      case "golden_chest": sp = new Sprite(getAnim("golden_chest", "open").frames[0]!); sp.anchor.set(0.5, 0.9); break;
      case "barrel": sp = new Sprite(getSprite("barrels", "plain")); sp.anchor.set(0.5, 0.9); break;
      case "ores": sp = new Sprite(getTile("ores", 1 + (fnv1a(id0) % 3), fnv1a(id0) % 8)); sp.anchor.set(0.5, 0.9); break;
      case "gold": sp = new Sprite(getSprite("gold_piles", "big")); sp.anchor.set(0.5, 0.95); break;
      default: sp = new Sprite(getTexture("lantern")); sp.anchor.set(0.5, 1);
    }
    sp.position.set(x, y);
    sp.zIndex = y;
    c = sp;
    if (prop.apiKind) {
      // chests are real objects: hover shows the name, click opens the drawer
      sp.eventMode = "static";
      sp.cursor = "pointer";
      sp.on("pointerover", (e) => this.cb.onHover({ type: "prop", p: prop }, e.global.x, e.global.y));
      sp.on("pointerout", () => this.cb.onHover(null, 0, 0));
      sp.on("pointertap", () => { if (!this.cb.isDrag()) this.cb.onClick({ type: "prop", p: prop }); });
      if (prop.more) {
        const wrap = new Container();
        wrap.position.set(x, y);
        wrap.zIndex = y;
        sp.position.set(0, 0);
        wrap.addChild(sp);
        const t = this.track(new Text({ text: `+${prop.more}`, style: smallStyle() }));
        t.anchor.set(0.5, 1);
        t.position.set(0, -14);
        wrap.addChild(t);
        c = wrap;
      }
    }
    this.props.addChild(c);
    this.objs.set(id, c);
  }

  // ---------- signposts ----------
  private syncSignpost(sg: Signpost, keep: Set<string>) {
    const id = `s/${sg.id}`;
    keep.add(id);
    const s = `${sg.x},${sg.y}|${sg.ready}|${sg.exposed}|${sg.service}`;
    let c = this.objs.get(id);
    if (this.sig.get(id) === s && c) return;
    this.sig.set(id, s);
    c?.destroy({ children: true });
    c = new Container();
    c.label = id;
    (c as Container & { ns?: string }).ns = sg.namespace;
    const post = new Sprite(getSprite("signs", ["post_1", "post_2", "post_3"][fnv1a(sg.service) % 3]!));
    post.anchor.set(0.5, 0.95);
    if (!sg.ready) post.tint = 0xff9a9a;
    c.addChild(post);
    if (sg.exposed) {
      const l = new Sprite(getTexture("lantern"));
      l.anchor.set(0.5, 1);
      l.position.set(12, -2);
      c.addChild(l);
    }
    const t = new Text({ text: sg.service, style: smallStyle() });
    this.track(t);
    t.anchor.set(0.5, 1);
    t.position.set(0, -post.height * 0.95 - 1);
    c.addChild(t);
    c.position.set(sg.x, sg.y);
    c.zIndex = sg.y;
    post.eventMode = "static";
    post.cursor = "pointer";
    post.on("pointerover", (e) => this.cb.onHover({ type: "signpost", s: sg }, e.global.x, e.global.y));
    post.on("pointerout", () => this.cb.onHover(null, 0, 0));
    post.on("pointertap", () => { if (!this.cb.isDrag()) this.cb.onClick({ type: "signpost", s: sg }); });
    this.buildings.addChild(c);
    this.objs.set(id, c);
  }

  // ---------- bridges ----------
  private syncBridge(br: Bridge, keep: Set<string>) {
    const id = `br/${br.id}`;
    keep.add(id);
    const s = `${br.x},${br.y}|${br.tls}|${br.url}`;
    let c = this.objs.get(id);
    if (this.sig.get(id) === s && c) return;
    this.sig.set(id, s);
    c?.destroy({ children: true });
    c = new Container();
    c.label = id;
    (c as Container & { ns?: string }).ns = br.namespace;
    const bridge = new Sprite(getSprite("bridge_stone", "deck"));
    bridge.anchor.set(0, 0.5);
    bridge.position.set(-6, 0);
    c.addChild(bridge);
    const gate = new AnimatedSprite(getAnim("palisade_gate", "open").frames);
    gate.gotoAndStop(2);
    gate.anchor.set(0.5, 0.9);
    gate.scale.set(0.5);
    gate.position.set(-4, 12);
    c.addChild(gate);
    const pole = new Graphics().rect(0, 0, 2, 26).fill({ color: 0x5a3a1e });
    pole.position.set(bridge.width - 10, -30);
    const banner = new Graphics().poly([0, 0, 14, 4, 0, 8]).fill({ color: br.tls ? 0x3b8bff : 0xf05252 });
    banner.position.set(bridge.width - 8, -29);
    c.addChild(pole, banner);
    const t = new Text({ text: br.host, style: smallStyle() });
    this.track(t);
    t.anchor.set(0, 1);
    t.position.set(2, -14);
    c.addChild(t);
    c.position.set(br.x, br.y);
    c.zIndex = br.y;
    bridge.eventMode = "static";
    bridge.cursor = "pointer";
    bridge.on("pointerover", (e) => this.cb.onHover({ type: "bridge", br }, e.global.x, e.global.y));
    bridge.on("pointerout", () => this.cb.onHover(null, 0, 0));
    bridge.on("pointertap", () => { if (!this.cb.isDrag()) this.cb.onClick({ type: "bridge", br }); });
    this.buildings.addChild(c);
    this.objs.set(id, c);
  }

  // ---------- dimming ----------
  private applyDim() {
    const dim = (cont: Container) => {
      for (const ch of cont.children) {
        const ns = (ch as Container & { ns?: string }).ns;
        ch.alpha = this.dimNs && ns && ns !== this.dimNs ? 0.3 : 1;
      }
    };
    dim(this.plots); dim(this.buildings); dim(this.actors);
  }

  // ---------- tooltip ----------
  showTooltip(lines: string[], sx: number, sy: number) {
    if (!this.tooltip) {
      const root = new Container();
      // Parchment box drawn with Graphics: crisp at every zoom and readable on any biome.
      // (A nine-slice from UI_Frames can replace it once a frame region is verified.)
      const box: NineSliceSprite | Graphics = new Graphics();
      const text = new Text({ text: "", style: new TextStyle({ fontFamily: FONT, fontSize: 13, fill: 0x2a1c12, lineHeight: 16 }) });
      this.track(text);
      root.addChild(box, text);
      root.visible = false;
      this.ui.addChild(root);
      this.tooltip = { box, text, root };
    }
    const tt = this.tooltip;
    tt.text.text = lines.join("\n");
    tt.text.position.set(12, 10);
    const w = Math.ceil(tt.text.width + 24), h = Math.ceil(tt.text.height + 20);
    if (tt.box instanceof NineSliceSprite) { tt.box.width = w; tt.box.height = h; tt.box.scale.set(1); }
    else tt.box.clear().roundRect(0, 0, w, h, 4).fill({ color: 0xf0d9a8 }).stroke({ color: 0x5a3a1e, width: 2 }).roundRect(3, 3, w - 6, h - 6, 3).stroke({ color: 0xb98a55, width: 1 });
    tt.root.visible = true;
    this.moveTooltip(sx, sy);
  }
  hideTooltip() { if (this.tooltip) this.tooltip.root.visible = false; }
  private moveTooltip(sx: number, sy: number) {
    if (!this.tooltip) return;
    const w = this.tooltip.box.width, h = this.tooltip.box.height;
    let x = sx + 14, y = sy + 14;
    if (x + w > this.app.screen.width - 4) x = sx - w - 8;
    if (y + h > this.app.screen.height - 4) y = sy - h - 8;
    this.tooltip.root.position.set(Math.round(x), Math.round(y));
  }

  // ---------- animation ----------
  private tween(obj: Container, sx: number, sy: number, fx: number, fy: number) {
    obj.position.set(sx, sy);
    this.tweens.push({ obj, sx, sy, fx, fy, t: 0 });
  }
  private update(ticker: Ticker) {
    const ms = ticker.deltaMS;
    this.actorSys.update(ticker, this.cb.viewport());
    // water
    if (this.water && this.waterFrames.length) {
      this.waterT += ms;
      const i = Math.floor(this.waterT / 250) % this.waterFrames.length;
      if (this.water.texture !== this.waterFrames[i]) this.water.texture = this.waterFrames[i]!;
    }
    // tweens
    if (this.tweens.length) {
      const keep: Tween[] = [];
      for (const t of this.tweens) {
        if (t.obj.destroyed) continue; // re-synced building/actor was rebuilt mid-tween
        t.t = Math.min(1, t.t + ms / 300);
        const e = 1 - Math.pow(1 - t.t, 3);
        t.obj.position.set(t.sx + (t.fx - t.sx) * e, t.sy + (t.fy - t.sy) * e);
        if (t.t < 1) keep.push(t);
      }
      this.tweens = keep;
    }
  }
}
