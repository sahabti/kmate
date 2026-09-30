import { Container, type FederatedPointerEvent } from "pixi.js";

/** Integer-zoom pan/zoom camera over a world container. */
export class Camera {
  zoom = 2;
  readonly zooms = [1, 2, 3, 4];
  x = 0; // world offset in screen px
  y = 0;
  private dragging = false;
  private last = { x: 0, y: 0 };
  private pinchDist = 0;
  private moved = 0;
  private listeners: Array<() => void> = [];

  constructor(public world: Container, private view: HTMLCanvasElement, private size: () => { w: number; h: number }) {}

  attach() {
    const v = this.view;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      this.dragging = true;
      this.moved = 0;
      this.last = { x: e.clientX, y: e.clientY };
      v.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.last.x;
      const dy = e.clientY - this.last.y;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.last = { x: e.clientX, y: e.clientY };
      this.x += dx;
      this.y += dy;
      this.apply();
    };
    const onUp = (e: PointerEvent) => {
      this.dragging = false;
      try { v.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
      } else {
        this.x -= e.deltaX;
        this.y -= e.deltaY;
        this.apply();
      }
    };
    const touches = new Map<number, { x: number; y: number }>();
    const onTouchDown = (e: PointerEvent) => { if (e.pointerType === "touch") touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); };
    const onTouchMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (this.pinchDist && Math.abs(d - this.pinchDist) > 40) {
          this.zoomAt(d > this.pinchDist ? 1 : -1, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
          this.pinchDist = d;
        } else if (!this.pinchDist) this.pinchDist = d;
      }
    };
    const onTouchUp = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) this.pinchDist = 0; };
    v.addEventListener("pointerdown", onDown);
    v.addEventListener("pointerdown", onTouchDown);
    v.addEventListener("pointermove", onMove);
    v.addEventListener("pointermove", onTouchMove);
    v.addEventListener("pointerup", onUp);
    v.addEventListener("pointerup", onTouchUp);
    v.addEventListener("pointercancel", onUp);
    v.addEventListener("wheel", onWheel, { passive: false });
    v.style.touchAction = "none";
    this.listeners.push(() => {
      v.removeEventListener("pointerdown", onDown);
      v.removeEventListener("pointerdown", onTouchDown);
      v.removeEventListener("pointermove", onMove);
      v.removeEventListener("pointermove", onTouchMove);
      v.removeEventListener("pointerup", onUp);
      v.removeEventListener("pointerup", onTouchUp);
      v.removeEventListener("pointercancel", onUp);
      v.removeEventListener("wheel", onWheel);
    });
    this.apply();
  }

  detach() { for (const l of this.listeners) l(); this.listeners = []; }

  /** True if the last pointer sequence was a drag (suppress click). */
  wasDrag() { return this.moved > 6; }

  zoomAt(dir: 1 | -1, sx: number, sy: number) {
    const i = this.zooms.indexOf(this.zoom);
    const next = this.zooms[Math.min(this.zooms.length - 1, Math.max(0, i + dir))]!;
    if (next === this.zoom) return;
    // keep the world point under the cursor fixed
    const wx = (sx - this.x) / this.zoom;
    const wy = (sy - this.y) / this.zoom;
    this.zoom = next;
    this.x = sx - wx * next;
    this.y = sy - wy * next;
    this.apply();
  }

  zoomIn() { const s = this.size(); this.zoomAt(1, s.w / 2, s.h / 2); }
  zoomOut() { const s = this.size(); this.zoomAt(-1, s.w / 2, s.h / 2); }

  /** Center the camera on world coords (px) with optional zoom. */
  centerOn(wx: number, wy: number, zoom?: number) {
    if (zoom && this.zooms.includes(zoom)) this.zoom = zoom;
    const s = this.size();
    this.x = s.w / 2 - wx * this.zoom;
    this.y = s.h / 2 - wy * this.zoom;
    this.apply();
  }

  /** Fit a world rect (px) into the view. */
  fit(x: number, y: number, w: number, h: number) {
    const s = this.size();
    let z = 1;
    for (const c of this.zooms) if (w * c <= s.w && h * c <= s.h) z = c;
    this.zoom = z;
    this.x = Math.round((s.w - w * z) / 2 - x * z);
    this.y = Math.round((s.h - h * z) / 2 - y * z);
    this.apply();
  }

  toWorld(sx: number, sy: number) { return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom }; }

  /** Visible world rect in px. */
  viewport() { const s = this.size(); return { x: -this.x / this.zoom, y: -this.y / this.zoom, w: s.w / this.zoom, h: s.h / this.zoom }; }

  onChange(fn: () => void) { this.changeFns.push(fn); }
  private changeFns: Array<() => void> = [];

  apply() {
    this.world.scale.set(this.zoom);
    this.world.position.set(Math.round(this.x), Math.round(this.y));
    for (const f of this.changeFns) f();
  }

  /** Helper for Pixi events: screen coords relative to the canvas. */
  static local(e: FederatedPointerEvent) { return { x: e.global.x, y: e.global.y }; }
}
