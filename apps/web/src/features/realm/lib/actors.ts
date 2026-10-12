/**
 * Living actors (pods) for the Realm renderer — docs/11-realm-view.md §2.3.
 *
 * Every pod is an AnimatedSprite with a small state machine:
 *   idle ⇄ wander (villagers, knights, templars) · work (creating, miners, lumberjacks)
 *   hurt (slimes attacking a crashing pod) · dying → fading (terminating / removed)
 *   walkin (new pod walks in from the plot gate) · leaving (evicted skeleton walks off)
 *
 * All actors advance from one ticker call (`update`), off-screen actors are culled
 * (hidden and not updated) and animation phases are staggered by a hash so a
 * thousand villagers never step in sync.
 */
import { AnimatedSprite, Container, Graphics, Sprite, Text, TextStyle, type Texture, type Ticker } from "pixi.js";
import type { Theme } from "@/features/realm/lib/theme";
import { TILE, fnv1a, type Actor, type ActorState, type Rect } from "@/features/realm/lib/world";

export interface ActorTarget { type: "actor"; a: Actor }

export interface ActorHost {
  layer: Container;
  /** effects drawn above actors (gas clouds, ribbons) */
  fx: Container;
  track<T extends Text>(t: T): T;
  smallStyle(): TextStyle;
  /** Active theme; read per call so a live theme swap is picked up. */
  theme(): Theme;
  onHover(t: ActorTarget | null, sx: number, sy: number): void;
  onClick(t: ActorTarget): void;
  isDrag(): boolean;
}

type Mode = "idle" | "wander" | "walkin" | "walk" | "work" | "hurt" | "dying" | "fading" | "leaving" | "gone";

/** Tunables (documented in docs/11-realm-view.md §10). */
export const WANDER = {
  speedPxPerSec: 12,      // ≈ 0.75 tiles/s stroll
  idleMinMs: 2000,
  idleMaxMs: 8000,
  radiusPx: 5 * TILE,     // stay near the house
  fadeMs: 2000,           // terminating fade after the death animation
  removeFadeMs: 900,      // pod vanished without a Terminating phase
  hurtEveryMs: 3000,
  slimeCap: 3,
  cullMarginPx: 96,
};

interface Slime { sp: AnimatedSprite; phase: number; r: number }

interface Rt {
  a: Actor;
  c: Container;
  body: AnimatedSprite;
  bubble: Container | null;
  label: Text | null;
  slimes: Slime[];
  scorch: Graphics | null;
  bomb: AnimatedSprite | null;
  gas: AnimatedSprite | null;
  pos: { x: number; y: number };
  home: { x: number; y: number };
  target: { x: number; y: number } | null;
  mode: Mode;
  waitMs: number;
  hurtInMs: number;
  fadeMs: number;
  seed: number;
  rng: () => number;
  anim: string;
  facing: "down" | "side" | "up";
  flip: boolean;
  t: number; // local clock ms
  /** Motion substituted for a missing animation in static themes. */
  proc: "none" | "bob" | "hop";
  deathT: number;
  onScreen: boolean;
  removeAfterFade: boolean;
}

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const BUBBLE_ROLE = { question: "ui.icon.question", hourglass: "ui.icon.wait", exclaim: "ui.icon.alert", star: "ui.icon.star" } as const;
const BUBBLE_GLYPH = { question: "?", hourglass: "\u2026", exclaim: "!", star: "*" } as const;

const inRect = (x: number, y: number, r: Rect, pad = 0) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;

export class ActorSystem {
  private rts = new Map<string, Rt>();
  private showActors = true;
  private firstSyncDone = false;

  constructor(private host: ActorHost) {}

  private get theme() { return this.host.theme(); }
  /** Theme role for an actor, e.g. "actor.villager". */
  private roleOf(a: Actor) { return `actor.${a.role}`; }
  private framesOf(a: Actor, name: string): { frames: Texture[]; fps: number; loop: boolean } | null {
    return this.theme.anim(this.roleOf(a), name, a.variant);
  }
  private stillOf(a: Actor): Texture { return this.theme.texture(this.roleOf(a), a.variant); }

  count() { return this.rts.size; }

  /** Debug snapshot (exposed as window.__realm.actors() in dev). */
  snapshot() {
    return [...this.rts.values()].map((rt) => ({ id: rt.a.id, state: rt.a.state, mode: rt.mode, x: Math.round(rt.pos.x), y: Math.round(rt.pos.y), alpha: +rt.c.alpha.toFixed(2), visible: this.showActors && rt.c.visible && rt.onScreen, anim: rt.anim, slimes: rt.slimes.length, bubble: !!rt.bubble, label: rt.label?.text ?? "", target: rt.target ? { x: Math.round(rt.target.x), y: Math.round(rt.target.y) } : null, playing: rt.body.playing }));
  }

  /** LOD: hide every actor (zoom ×1). */
  setVisible(show: boolean) {
    this.showActors = show;
    this.host.layer.visible = show;
    this.host.fx.visible = show;
  }

  /** Create or update the runtime for an actor. */
  sync(a: Actor) {
    const id = `a/${a.id}`;
    let rt = this.rts.get(id);
    if (!rt) {
      rt = this.create(a);
      this.rts.set(id, rt);

      return;
    }
    const prev = rt.a;
    rt.a = a;
    rt.removeAfterFade = false;
    (rt.c as Container & { ns?: string }).ns = a.namespace;
    const moved = prev.x !== a.x || prev.y !== a.y;
    const stateChanged = prev.state !== a.state || prev.role !== a.role || prev.variant !== a.variant || prev.restarts !== a.restarts || prev.initProgress !== a.initProgress;
    // A pod that was waiting on the shore (Pending, unscheduled) got a node: it enters the
    // village through the gate and walks to its house instead of teleporting.
    if (prev.state === "pending" && a.state !== "pending" && a.state !== "terminating" && a.spawn && this.firstSyncDone) {
      rt.home = { x: a.x, y: a.y };
      rt.pos = { x: a.spawn.x, y: a.spawn.y };
      rt.c.position.set(rt.pos.x, rt.pos.y);
      rt.target = { x: a.x, y: a.y };
      rt.mode = "walkin";
      this.applyState(rt, prev.state);

      return;
    }
    if (moved) {
      rt.home = { x: a.x, y: a.y };
      if (rt.mode !== "dying" && rt.mode !== "fading" && rt.mode !== "leaving" && rt.mode !== "gone") {
        rt.target = { x: a.x, y: a.y };
        rt.mode = "walk";
      }
    }
    if (prev.role !== a.role || prev.variant !== a.variant) {
      this.rebuildBody(rt);
    }
    if (stateChanged) this.applyState(rt, prev.state);
  }

  /** Called after a sync with the ids that still exist; the rest leave the realm. */
  retireMissing(keep: Set<string>) {
    this.firstSyncDone = true;
    for (const [id, rt] of this.rts) {
      if (keep.has(id)) continue;
      if (rt.mode === "gone") { this.destroy(id, rt); continue; }
      if (rt.mode === "dying" || rt.mode === "fading" || rt.mode === "leaving") { rt.removeAfterFade = true; continue; }
      // vanished without a Terminating phase (e.g. force delete): quick fade
      rt.removeAfterFade = true;
      rt.mode = "fading";
      rt.fadeMs = WANDER.removeFadeMs;
      this.stopEffects(rt);
    }
  }

  destroyAll() {
    for (const [id, rt] of this.rts) this.destroy(id, rt);
  }

  // ---------- creation ----------
  private create(a: Actor): Rt {
    const c = new Container();
    c.label = `a/${a.id}`;
    c.sortableChildren = true; // slimes go behind/in front of the villager as they orbit
    (c as Container & { ns?: string }).ns = a.namespace;
    const seed = fnv1a(a.uid);
    const rng = mulberry32(seed);
    const body = new AnimatedSprite(this.framesOf(a, "idle_down")?.frames ?? [this.stillOf(a)]);
    body.autoUpdate = false;
    const an = this.theme.anchor(this.roleOf(a), a.variant);
    body.anchor.set(an.x, an.y);
    body.scale.set(this.theme.scale(this.roleOf(a), a.variant));
    c.addChild(body);
    const rt: Rt = {
      a, c, body, bubble: null, label: null, slimes: [], scorch: null, bomb: null, gas: null,
      pos: { x: a.x, y: a.y }, home: { x: a.x, y: a.y }, target: null, mode: "idle",
      waitMs: WANDER.idleMinMs + rng() * (WANDER.idleMaxMs - WANDER.idleMinMs), hurtInMs: 0, fadeMs: 0,
      seed, rng, anim: "", facing: (["down", "side", "up"] as const)[seed % 3]!, flip: seed % 2 === 1, t: seed % 1000,
      proc: "none", deathT: 0, onScreen: true, removeAfterFade: false,
    };
    body.eventMode = "static";
    body.cursor = "pointer";
    body.on("pointerover", (e) => { body.tint = rt.a.state === "unknown" ? 0x999999 : 0xfff2b0; this.host.onHover({ type: "actor", a: rt.a }, e.global.x, e.global.y); });
    body.on("pointerout", () => { body.tint = rt.a.state === "unknown" ? 0x777777 : 0xffffff; this.host.onHover(null, 0, 0); });
    body.on("pointertap", () => { if (!this.host.isDrag()) this.host.onClick({ type: "actor", a: rt.a }); });
    // walk in from the gate when this pod appeared after the first sync
    if (this.firstSyncDone && a.spawn && a.state !== "pending" && a.state !== "terminating") {
      rt.pos = { x: a.spawn.x, y: a.spawn.y };
      rt.target = { x: a.x, y: a.y };
      rt.mode = "walkin";
    }
    c.position.set(rt.pos.x, rt.pos.y);
    c.zIndex = rt.pos.y;
    this.host.layer.addChild(c);
    this.applyState(rt, null);

    return rt;
  }

  private rebuildBody(rt: Rt) {
    const a = rt.a;
    const old = rt.body;
    const body = new AnimatedSprite(this.framesOf(a, "idle_down")?.frames ?? [this.stillOf(a)]);
    body.autoUpdate = false;
    const an = this.theme.anchor(this.roleOf(a), a.variant);
    body.anchor.set(an.x, an.y);
    body.scale.set(this.theme.scale(this.roleOf(a), a.variant));
    body.eventMode = "static";
    body.cursor = "pointer";
    body.on("pointerover", (e) => { body.tint = 0xfff2b0; this.host.onHover({ type: "actor", a: rt.a }, e.global.x, e.global.y); });
    body.on("pointerout", () => { body.tint = 0xffffff; this.host.onHover(null, 0, 0); });
    body.on("pointertap", () => { if (!this.host.isDrag()) this.host.onClick({ type: "actor", a: rt.a }); });
    rt.c.addChildAt(body, rt.c.getChildIndex(old));
    old.destroy();
    rt.body = body;
    rt.anim = "";
  }

  // ---------- state → visuals ----------
  private applyState(rt: Rt, prevState: ActorState | null) {
    const a = rt.a;
    this.clearBubble(rt);
    this.clearLabel(rt);
    rt.body.tint = 0xffffff;
    rt.body.alpha = 1;
    rt.body.visible = true;
    const busy = rt.mode === "walkin" || rt.mode === "walk";
    switch (a.state) {
      case "idle":
        this.stopEffects(rt);
        if (!busy) rt.mode = this.worksWhenIdle(rt) ? "work" : "idle";
        break;
      case "notready":
        this.stopEffects(rt);
        if (!busy) rt.mode = "idle";
        this.bubble(rt, "question");
        break;
      case "pending":
        this.stopEffects(rt);
        rt.mode = "idle";
        this.bubble(rt, "hourglass");
        break;
      case "creating":
        this.stopEffects(rt);
        if (!busy) rt.mode = "work";
        this.ribbon(rt, a.initProgress ? `Init:${a.initProgress}` : a.statusText);
        break;
      case "crash":
        if (!busy) rt.mode = "idle";
        this.ensureSlimes(rt, Math.min(WANDER.slimeCap, Math.max(1, a.restarts)));
        this.clearOom(rt);
        rt.hurtInMs = 300;
        break;
      case "oom":
        if (!busy) rt.mode = "idle";
        this.ensureSlimes(rt, 0);
        if (prevState !== "oom" || !rt.scorch) this.explode(rt);
        this.bubble(rt, "exclaim");
        break;
      case "evicted":
        this.stopEffects(rt);
        rt.a = { ...a, role: "skeleton" };
        this.rebuildBody(rt);
        rt.a = a;
        rt.mode = "leaving";
        rt.target = a.exit ?? { x: rt.home.x + 8 * TILE, y: rt.home.y };
        break;
      case "terminating":
        this.stopEffects(rt);
        if (rt.mode !== "dying" && rt.mode !== "fading") { rt.mode = "dying"; this.play(rt, "death", false); }
        break;
      case "succeeded":
        this.stopEffects(rt);
        rt.mode = "idle";
        this.bubble(rt, "star");
        break;
      case "unknown":
        this.stopEffects(rt);
        rt.mode = "idle";
        rt.body.tint = 0x777777;
        break;
    }
    // restarts ribbon: also while crashing (slimes show the count too, capped) — hidden only while creating/terminating
    if (a.restarts > 0 && a.state !== "creating" && a.state !== "terminating") this.ribbon(rt, `!${a.restarts}`);
    if (rt.mode === "idle") this.play(rt, `idle_${rt.facing}`, true);
    else if (rt.mode === "work") this.play(rt, "work", true);
  }

  private worksWhenIdle(rt: Rt) {
    return rt.a.role === "miner" || rt.a.role === "lumberjack";
  }

  private canWander(rt: Rt) {
    const r = rt.a.role;

    return !!rt.a.bounds && rt.a.state === "idle" && (r === "villager" || r === "knight" || r === "templar");
  }

  // ---------- effects ----------
  /** Status bubble: the theme's icon when it has one, otherwise a drawn glyph. */
  private bubble(rt: Rt, icon: "question" | "hourglass" | "exclaim" | "star") {
    this.clearBubble(rt);
    const role = BUBBLE_ROLE[icon];
    let node: Container;
    if (this.theme.has(role)) {
      const ic = new Sprite(this.theme.texture(role));
      const a = this.theme.anchor(role);
      ic.anchor.set(a.x, a.y);
      ic.scale.set(this.theme.scale(role));
      node = ic;
    } else {
      node = new Container();
      const box = new Graphics().roundRect(-7, -14, 14, 14, 3).fill({ color: 0xf0d9a8 }).roundRect(-7, -14, 14, 14, 3).stroke({ color: 0x3a2a18, width: 1 });
      const t = this.host.track(new Text({ text: BUBBLE_GLYPH[icon], style: this.host.smallStyle() }));
      t.anchor.set(0.5, 0.5);
      t.position.set(0, -7);
      t.style.fill = 0x2a1c12;
      t.style.stroke = { color: 0xf0d9a8, width: 1 };
      node.addChild(box, t);
    }
    node.position.set(0, -this.headY(rt) - 2);
    rt.c.addChild(node);
    rt.bubble = node;
  }
  private clearBubble(rt: Rt) { rt.bubble?.destroy(); rt.bubble = null; }
  private ribbon(rt: Rt, text: string) {
    this.clearLabel(rt);
    const t = this.host.track(new Text({ text, style: this.host.smallStyle() }));
    t.anchor.set(0.5, 1);
    t.position.set(0, -this.headY(rt) - (rt.bubble ? 14 : 2));
    rt.c.addChild(t);
    rt.label = t;
  }
  private clearLabel(rt: Rt) { rt.label?.destroy(); rt.label = null; }
  private headY(rt: Rt) { return rt.body.height * this.theme.anchor(this.roleOf(rt.a), rt.a.variant).y; }

  private ensureSlimes(rt: Rt, n: number) {
    while (rt.slimes.length > n) rt.slimes.pop()!.sp.destroy();
    while (rt.slimes.length < n) {
      const def = this.theme.anim("monster.crash", "jump");
      const sp = new AnimatedSprite(def?.frames ?? [this.theme.texture("monster.crash")]);
      sp.autoUpdate = false;
      sp.animationSpeed = 10 / 60;
      const ma = this.theme.anchor("monster.crash");
      sp.anchor.set(ma.x, ma.y);
      sp.scale.set(this.theme.scale("monster.crash"));
      if (sp.totalFrames > 1) sp.gotoAndPlay((rt.seed + rt.slimes.length * 3) % sp.totalFrames);
      rt.c.addChild(sp);
      rt.slimes.push({ sp, phase: (rt.seed % 628) / 100 + rt.slimes.length * 2.1, r: 12 + rt.slimes.length * 3 });
    }
  }
  private clearOom(rt: Rt) {
    rt.bomb?.destroy(); rt.bomb = null;
    rt.gas?.destroy(); rt.gas = null;
    rt.scorch?.destroy(); rt.scorch = null;
  }
  private stopEffects(rt: Rt) {
    this.ensureSlimes(rt, 0);
    this.clearOom(rt);
  }
  /** Bombschroom walks up, explodes, leaves gas and a scorch mark. */
  private explode(rt: Rt) {
    this.clearOom(rt);
    const oomA = this.theme.anchor("monster.oom");
    const oomS = this.theme.scale("monster.oom");
    const fuse = this.theme.anim("monster.oom", "fuse");
    const bomb = new AnimatedSprite(fuse?.frames ?? [this.theme.texture("monster.oom")]);
    bomb.autoUpdate = false;
    bomb.animationSpeed = 10 / 60;
    bomb.loop = false;
    bomb.anchor.set(oomA.x, oomA.y);
    bomb.scale.set(oomS);
    bomb.position.set(16, 1);
    // Static themes have no fuse animation: detonate on the next frame instead.
    if (!fuse) setTimeout(() => { if (!bomb.destroyed) bomb.onComplete?.(); }, 400);
    bomb.onComplete = () => {
      if (bomb.destroyed) return;
      const expl = this.theme.anim("monster.oom", "explode");
      const boom = new AnimatedSprite(expl?.frames ?? [this.theme.texture("fx.gas")]);
      boom.autoUpdate = false;
      boom.animationSpeed = 10 / 60;
      boom.loop = false;
      boom.anchor.set(oomA.x, oomA.y);
      boom.position.copyFrom(bomb.position);
      boom.scale.set(2 * oomS);
      rt.c.addChild(boom);
      bomb.destroy();
      rt.bomb = boom;
      const scorch = new Graphics().ellipse(0, 0, 14, 6).fill({ color: 0x1a1210, alpha: 0.55 });
      scorch.position.set(16, 2);
      rt.c.addChildAt(scorch, 0);
      rt.scorch = scorch;
      const gasDef = this.theme.anim("fx.gas", "puff");
      const gas = new AnimatedSprite(gasDef?.frames ?? [this.theme.texture("fx.gas")]);
      gas.autoUpdate = false;
      gas.animationSpeed = 8 / 60;
      gas.loop = false;
      const ga = this.theme.anchor("fx.gas");
      gas.anchor.set(ga.x, ga.y);
      gas.scale.set(this.theme.scale("fx.gas"));
      if (!gasDef) setTimeout(() => { if (!gas.destroyed) gas.onComplete?.(); }, 900);
      gas.position.set(rt.pos.x + 16, rt.pos.y - 4);
      gas.onComplete = () => { gas.destroy(); if (rt.gas === gas) rt.gas = null; };
      this.host.fx.addChild(gas);
      rt.gas = gas;
      boom.onComplete = () => { boom.destroy(); if (rt.bomb === boom) rt.bomb = null; };
      if (expl) boom.play(); else setTimeout(() => { if (!boom.destroyed) boom.onComplete?.(); }, 600);
      this.play(rt, "hurt", false, () => this.play(rt, `idle_${rt.facing}`, true));
    };
    rt.c.addChild(bomb);
    rt.bomb = bomb;
    if (fuse) bomb.play();
  }

  // ---------- animation ----------
  /**
   * Play an animation. A theme made of static tiles has none, so the motion is
   * substituted procedurally: walking bobs, working hops, hurt flashes red and
   * death shrinks away. `rt.proc` carries the substitution to `step`.
   */
  private play(rt: Rt, name: string, loop: boolean, onComplete?: () => void) {
    const a = rt.a;
    const n = name;
    const has = (x: string) => this.theme.hasAnim(this.roleOf(a), x, a.variant);
    if (!has(n)) {
      if (n === "hurt") { // flash instead
        rt.body.tint = 0xff8080;
        setTimeout(() => { if (!rt.body.destroyed && rt.a.state !== "unknown") rt.body.tint = 0xffffff; }, 250);
        onComplete?.();

        return;
      }
      if (n === "death") { onComplete?.(); rt.mode = "fading"; rt.fadeMs = WANDER.fadeMs; rt.deathT = 0;

 return; }
      // static substitute + procedural motion
      rt.proc = n.startsWith("walk") ? "bob" : n === "work" ? "hop" : "none";
      const key = `still|${n}`;
      if (rt.anim === key) return;
      rt.anim = key;
      rt.body.textures = [this.stillOf(a)];
      rt.body.loop = false;
      rt.body.stop();
      rt.body.scale.x = Math.abs(rt.body.scale.x) * (rt.flip && n.endsWith("_side") ? -1 : 1);

      return;
    }
    rt.proc = "none";
    const key = `${n}|${loop}`;
    if (rt.anim === key && !onComplete) return;
    rt.anim = key;
    const def = this.framesOf(a, n)!;
    rt.body.textures = def.frames;
    rt.body.loop = loop;
    rt.body.animationSpeed = def.fps / 60;
    rt.body.onComplete = onComplete ?? undefined;
    rt.body.scale.x = Math.abs(rt.body.scale.x) * (rt.flip && n.endsWith("_side") ? -1 : 1);
    if (loop) rt.body.gotoAndPlay(rt.seed % def.frames.length);
    else rt.body.gotoAndPlay(0);
  }

  private faceTowards(rt: Rt, dx: number, dy: number) {
    if (Math.abs(dy) > Math.abs(dx)) { rt.facing = dy < 0 ? "up" : "down"; rt.flip = false; }
    else { rt.facing = "side"; rt.flip = dx < 0; }
  }

  private pickWanderTarget(rt: Rt): { x: number; y: number } | null {
    const b = rt.a.bounds!;
    for (let i = 0; i < 10; i++) {
      const ang = rt.rng() * Math.PI * 2, r = 1.5 * TILE + rt.rng() * (WANDER.radiusPx - 1.5 * TILE);
      const x = Math.round(rt.home.x + Math.cos(ang) * r), y = Math.round(rt.home.y + Math.sin(ang) * r * 0.6);
      if (!inRect(x, y, b)) continue;
      if (rt.a.avoid && (inRect(x, y, rt.a.avoid, 4) || inRect((x + rt.pos.x) / 2, (y + rt.pos.y) / 2, rt.a.avoid, 4))) continue;

      return { x, y };
    }

    return null;
  }

  // ---------- per-frame ----------
  update(ticker: Ticker, viewport: Rect) {
    if (!this.showActors) return;
    const ms = ticker.deltaMS;
    const m = WANDER.cullMarginPx;
    const gone: string[] = [];
    for (const [id, rt] of this.rts) {
      const on = rt.pos.x >= viewport.x - m && rt.pos.x <= viewport.x + viewport.w + m && rt.pos.y >= viewport.y - m && rt.pos.y <= viewport.y + viewport.h + m;
      if (on !== rt.onScreen) { rt.onScreen = on; rt.c.visible = on; }
      if (!on) {
        // keep only the timeline that matters while off screen
        if (rt.mode === "fading") { rt.fadeMs -= ms; if (rt.fadeMs <= 0) { rt.mode = "gone"; if (rt.removeAfterFade) gone.push(id); } }
        continue;
      }
      rt.t += ms;
      this.step(rt, ms);
      rt.body.update(ticker);
      for (const s of rt.slimes) s.sp.update(ticker);
      rt.bomb?.update(ticker);
      rt.gas?.update(ticker);
      if (rt.mode === "gone" && rt.removeAfterFade) gone.push(id);
    }
    for (const id of gone) { const rt = this.rts.get(id); if (rt) this.destroy(id, rt); }
  }

  private step(rt: Rt, ms: number) {
    const a = rt.a;
    // movement
    if (rt.target && (rt.mode === "wander" || rt.mode === "walkin" || rt.mode === "walk" || rt.mode === "leaving")) {
      const dx = rt.target.x - rt.pos.x, dy = rt.target.y - rt.pos.y;
      const dist = Math.hypot(dx, dy);
      const sp = (rt.mode === "leaving" ? 1.6 : rt.mode === "walkin" || rt.mode === "walk" ? 1.8 : 1) * WANDER.speedPxPerSec * ms / 1000;
      if (dist <= sp) {
        rt.pos = { ...rt.target };
        rt.target = null;
        if (rt.mode === "leaving") { rt.mode = "fading"; rt.fadeMs = 800; }
        else {
          rt.mode = a.state === "creating" || this.worksWhenIdle(rt) ? "work" : "idle";
          rt.waitMs = WANDER.idleMinMs + rt.rng() * (WANDER.idleMaxMs - WANDER.idleMinMs);
          this.play(rt, rt.mode === "work" ? "work" : `idle_${rt.facing}`, true);
        }
      } else {
        this.faceTowards(rt, dx, dy);
        rt.pos = { x: rt.pos.x + dx / dist * sp, y: rt.pos.y + dy / dist * sp };
        this.play(rt, `walk_${rt.facing}`, true);
      }
      rt.c.position.set(Math.round(rt.pos.x), Math.round(rt.pos.y));
      rt.c.zIndex = rt.pos.y;
    } else if (rt.mode === "idle") {
      rt.waitMs -= ms;
      if (rt.waitMs <= 0 && this.canWander(rt)) {
        const t = this.pickWanderTarget(rt);
        if (t) { rt.target = t; rt.mode = "wander"; }
        else rt.waitMs = WANDER.idleMinMs;
      }
    } else if (rt.mode === "dying") {
      if (!rt.body.playing) { rt.mode = "fading"; rt.fadeMs = WANDER.fadeMs; }
    } else if (rt.mode === "fading") {
      rt.fadeMs -= ms;
      const total = rt.removeAfterFade && a.state !== "terminating" ? WANDER.removeFadeMs : WANDER.fadeMs;
      rt.c.alpha = Math.max(0, Math.min(1, rt.fadeMs / total));
      if (rt.fadeMs <= 0) { rt.mode = "gone"; rt.c.visible = false; }
    }
    // crash: slimes orbit and the villager gets hurt every few seconds
    if (rt.slimes.length) {
      const tt = rt.t / 1000;
      for (const s of rt.slimes) {
        s.sp.position.set(Math.cos(tt * 1.6 + s.phase) * s.r, Math.sin(tt * 1.6 + s.phase) * (s.r * 0.45) + 3);
        s.sp.zIndex = s.sp.y > 0 ? 1 : -1;
      }
      rt.hurtInMs -= ms;
      if (rt.hurtInMs <= 0) {
        rt.hurtInMs = WANDER.hurtEveryMs;
        this.play(rt, "hurt", false, () => this.play(rt, `idle_${rt.facing}`, true));
      }
    }
    // procedural motion for themes without animation frames
    if (rt.proc === "bob") rt.body.y = -Math.abs(Math.sin(rt.t / 110) * 2);
    else if (rt.proc === "hop") rt.body.y = -Math.abs(Math.sin(rt.t / 190) * 3);
    else if (a.role !== "angel") rt.body.y = 0;
    if (rt.mode === "fading" && rt.proc !== "none") { /* keep the substituted pose while fading */ }
    // a death with no animation shrinks away instead
    if (rt.mode === "fading" && !this.theme.hasAnim(this.roleOf(a), "death", a.variant) && a.state === "terminating") {
      rt.deathT += ms;
      const k = Math.max(0.2, 1 - rt.deathT / WANDER.fadeMs);
      rt.c.scale.set(k);
    }
    // angels hover, bubbles bob
    if (a.role === "angel") rt.body.y = Math.round(Math.sin(rt.t / 400) * 3) - 6;
    if (rt.bubble) rt.bubble.y = -this.headY(rt) - 2 + Math.round(Math.sin(rt.t / 300) * 1.5);
  }

  private destroy(id: string, rt: Rt) {
    rt.gas?.destroy();
    rt.c.parent?.removeChild(rt.c);
    rt.c.destroy({ children: true });
    this.rts.delete(id);
  }
}
