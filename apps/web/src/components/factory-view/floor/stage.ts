import { PCFShadowMap, Scene as ThreeScene, WebGLRenderer } from "three";
import type { StoreyFocus } from "../scene/storeys";
import { CameraRig } from "./camera";
import { HEAD_Y } from "./crew-geometry";
import type { FigureStatus } from "./figure-look";
import { bindInput } from "./input";
import { BAY_CRATE } from "./props";
import { pickBox, pickFigure, rayAt, type ScreenPoint, screenAnchor } from "./screen";
import { FloorWorld, type WorldContent } from "./world";

/**
 * Floor mode's stage (#420, #476): one WebGL renderer for the world (the Workshop, the Lookout,
 * the crew), its camera and input. It draws continuously only while something animates: at
 * most 30 frames a second for the crew's idle loops, every display frame while the camera moves,
 * and on demand once nothing does (reduced motion, a stopped factory). Never while the tab is
 * hidden or the canvas is off screen. The pixel ratio is capped at 2. Throws when WebGL can't
 * start; calls `onLost` when the context is lost and doesn't come back.
 */

export type StageContent = WorldContent;

/** A figure (or a repair bay crate, `bay:<kind>`) on screen this frame, for the DOM layer. */
export interface ScreenFigure {
  key: string;
  /** The figure's status; null for a crate. */
  status: FigureStatus | null;
  /** Its feet, and the top of its head. */
  foot: ScreenPoint;
  head: ScreenPoint;
}

export interface StageEvents {
  /** WebGL's context was lost and didn't come back. */
  onLost: () => void;
  /** The pointer is over this figure or crate now (null: none), at this canvas point. */
  onHover: (key: string | null, at: { x: number; y: number } | null) => void;
  /** A tap or click on a figure or crate, or on the empty floor (null). */
  onTap: (key: string | null) => void;
  /** After each frame: where every figure and crate is on screen, and the zoom in px per unit. */
  onFrame: (figures: readonly ScreenFigure[], pxPerUnit: number, width: number) => void;
}

const MAX_DPR = 2;
/** How long a lost context may take to come back before the view gives up on it. */
const RESTORE_MS = 3000;
/** Idle loops draw at most this often. */
export const IDLE_FPS = 30;

export class FloorStage {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new ThreeScene();
  private readonly rig = new CameraRig();
  private readonly world = new FloorWorld();
  private content: StageContent | null = null;
  private framing = "";
  private focus: StoreyFocus = "both";
  private selected: string | null = null;
  private reducedMotion = false;
  private coarse = false;
  private raf = 0;
  private timer = 0;
  private last = 0;
  private lastDrawn = 0;
  private dirty = true;
  private onScreen = true;
  private lostTimer = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly unbind: () => void;
  private readonly resize: ResizeObserver;
  private readonly intersect: IntersectionObserver | null;
  private viewport = { width: 1, height: 1 };
  /** Frames drawn, for the dev stats overlay. */
  drawn = 0;
  private timed = { ms: 0, frames: 0 };
  private lastShadow = 0;
  /** The scene changed (data, focus, size): redraw the shadows with the next frame. */
  private shadowsDirty = true;

  /**
   * Draws into a canvas of its own inside `host` (decorative: hidden from assistive tech), so
   * handing its context back on dispose never touches the next stage's.
   */
  constructor(
    private readonly host: HTMLElement,
    private readonly events: StageEvents,
  ) {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.className = "absolute inset-0 block size-full touch-none select-none";
    canvas.dataset.testid = "factory-view-floor-canvas";
    this.canvas = canvas;
    try {
      this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      throw e instanceof Error ? e : new Error("WebGL is not available");
    }
    host.prepend(canvas);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    // Soft: PCF with a blur radius (three folded its soft variant into this one).
    this.renderer.shadowMap.type = PCFShadowMap;
    // Shadows follow the crew at its idle rate; a moving camera alone doesn't redraw them.
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.add(this.world.root);

    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
    document.addEventListener("visibilitychange", this.visibility);
    this.unbind = bindInput(canvas, this.rig, {
      moved: this.invalidate,
      fit: () => this.fit(true),
      hover: (at) => this.events.onHover(at ? this.pick(at.x, at.y) : null, at),
      tap: (at) => this.events.onTap(this.pick(at.x, at.y)),
    });
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(host);
    this.intersect =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.onScreen = entries.some((e) => e.isIntersecting);
            this.schedule();
          });
    this.intersect?.observe(canvas);
    this.measure();
    // Development builds: the stage is reachable from the console for debugging.
    if (import.meta.env.DEV) (globalThis as { __floorStage?: FloorStage }).__floorStage = this;
  }

  set reduced(on: boolean) {
    this.reducedMotion = on;
    this.rig.reduced = on;
    this.invalidate();
  }

  /** Touch screens: bigger pick boxes. */
  set coarsePointer(on: boolean) {
    this.coarse = on;
  }

  /** Keeps the fit clear of `px` CSS pixels on the left (the open roster), and refits. */
  setInset(px: number): void {
    if (this.rig.insetPx === px) return;
    this.rig.insetPx = px;
    if (this.framing) this.fit(true);
  }

  /** Shows `content`, rebuilding only what changed. */
  update(content: StageContent): void {
    this.content = content;
    this.world.update(content, this.clock(), this.reducedMotion);
    this.shadowsDirty = true;
    this.frame3d(false);
    const { scene } = content;
    if (this.selected && !scene.agents.some((a) => a.key === this.selected)) this.selected = null;
    this.invalidate();
  }

  /** Focuses a storey, or both: the other slides aside and dims, and the camera refits. */
  setFocus(focus: StoreyFocus): void {
    if (focus === this.focus) return;
    this.focus = focus;
    this.world.storeys.set(focus, this.clock(), this.reducedMotion);
    this.shadowsDirty = true;
    this.frame3d(true);
    this.invalidate();
  }

  /** Frames what the focus shows; the first framing jumps, later ones ease. */
  private frame3d(changed: boolean): void {
    const boxes = this.world.boxes(this.focus);
    const key = JSON.stringify(boxes);
    if (key === this.framing && !changed) return;
    const first = this.framing === "";
    this.framing = key;
    this.rig.setBoxes(boxes);
    this.rig.fit(!first);
  }

  /** Selects an agent (null: none); it hops, gets a ring, and the camera flies to it. */
  select(key: string | null): void {
    this.selected = key;
    if (key) {
      this.world.crew.select(key, this.clock());
      const at = this.world.crew.anchor(key) ?? this.world.frames.find((f) => f.key === key);
      if (at) this.rig.flyTo({ x: at.x, y: at.y + 0.35, z: at.z });
    }
    this.invalidate();
  }

  /** Brings a figure into view when it's off screen (keyboard focus moved to it). */
  reveal(key: string): void {
    const s = this.screenOf(key);
    const at = this.world.crew.anchor(key);
    if (!s || !at || (s.foot.inView && s.head.inView)) return;
    this.rig.flyTo({ x: at.x, y: at.y + 0.35, z: at.z });
    this.invalidate();
  }

  /** Frames everything the focus shows again. */
  fit(animate: boolean): void {
    this.rig.fit(animate);
    this.invalidate();
  }

  /** Where a figure is on screen now, if it's drawn. */
  screenOf(key: string): { foot: ScreenPoint; head: ScreenPoint } | null {
    const at = this.world.crew.anchor(key);
    if (!at) return null;
    return {
      foot: screenAnchor(this.rig.camera, this.viewport, at),
      head: screenAnchor(this.rig.camera, this.viewport, { x: at.x, y: at.y + HEAD_Y, z: at.z }),
    };
  }

  /**
   * Draw calls and triangles of the last frame, frames drawn, and the main thread's time per
   * frame in milliseconds, averaged since the last call (the dev stats overlay).
   */
  stats(): { calls: number; triangles: number; drawn: number; ms: number } {
    const r = this.renderer.info.render;
    const ms = this.timed.frames ? this.timed.ms / this.timed.frames : 0;
    this.timed = { ms: 0, frames: 0 };
    return { calls: r.calls, triangles: r.triangles, drawn: this.drawn, ms };
  }

  /** The figure under a canvas point, else the repair bay crate, if any. */
  private pick(x: number, y: number): string | null {
    const ray = rayAt(this.rig.camera, this.viewport, x, y);
    const targets = this.world.frames
      .filter((f) => !f.ghost)
      .map((f) => {
        const at = this.world.crew.anchor(f.key) ?? f;
        return { key: f.key, x: at.x, y: at.y, z: at.z };
      });
    const figure = pickFigure(ray, targets, pickBox(this.coarse));
    if (figure) return figure;
    const half = Math.max(BAY_CRATE.w / 2, pickBox(this.coarse).half);
    return pickFigure(ray, this.world.crateTargets(), { half, height: BAY_CRATE.h + 0.05 });
  }

  private clock(): number {
    return performance.now() / 1000;
  }

  /** Asks for a frame now (the data, camera, size or theme changed). */
  readonly invalidate = (): void => {
    this.dirty = true;
    this.schedule();
  };

  private canDraw(): boolean {
    return this.onScreen && document.visibilityState === "visible" && !this.lostTimer;
  }

  /** The next frame: now when something changed or the camera moves, else at the idle rate. */
  private schedule(): void {
    if (this.raf || !this.canDraw()) return;
    if (this.dirty || this.rig.moving || this.world.storeys.moving(this.clock())) {
      window.clearTimeout(this.timer);
      this.timer = 0;
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    if (this.timer || !this.world.animating(this.clock(), this.reducedMotion)) return;
    const wait = Math.max(0, 1000 / IDLE_FPS - (performance.now() - this.lastDrawn) - 4);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      if (!this.raf && this.canDraw()) this.raf = requestAnimationFrame(this.frame);
    }, wait);
  }

  private readonly frame = (now: number): void => {
    this.raf = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    this.rig.step(dt);
    this.draw();
    this.dirty = false;
    this.lastDrawn = performance.now();
    if (!this.rig.moving && !this.world.animating(this.clock(), this.reducedMotion)) this.last = 0;
    this.schedule();
  };

  private draw(): void {
    const start = performance.now();
    this.drawFrame();
    this.timed.ms += performance.now() - start;
    this.timed.frames += 1;
  }

  private drawFrame(): void {
    if (this.content) this.world.draw(this.clock(), this.reducedMotion, this.selected);
    const now = performance.now();
    if (this.shadowsDirty || now - this.lastShadow >= 1000 / IDLE_FPS - 4) {
      this.renderer.shadowMap.needsUpdate = true;
      this.lastShadow = now;
      this.shadowsDirty = false;
    }
    this.renderer.render(this.scene, this.rig.camera);
    this.world.flushRetired();
    this.drawn += 1;
    const figures: ScreenFigure[] = [];
    for (const f of this.world.frames) {
      if (f.ghost) continue;
      const s = this.screenOf(f.key);
      if (s) figures.push({ key: f.key, status: f.status, ...s });
    }
    for (const crate of this.world.crateTargets()) {
      const foot = screenAnchor(this.rig.camera, this.viewport, crate);
      const head = screenAnchor(this.rig.camera, this.viewport, {
        ...crate,
        y: crate.y + BAY_CRATE.h,
      });
      figures.push({ key: crate.key, status: null, foot, head });
    }
    this.events.onFrame(figures, this.rig.pxPerUnit(), this.viewport.width);
  }

  private measure(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.viewport = { width: w, height: h };
    this.renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.rig.setViewport(w, h);
    if (this.framing) this.rig.fit(false);
    this.invalidate();
  }

  private readonly visibility = (): void => {
    this.schedule();
  };

  private readonly lost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.lostTimer);
    this.lostTimer = window.setTimeout(() => this.events.onLost(), RESTORE_MS);
  };

  private readonly restored = (): void => {
    window.clearTimeout(this.lostTimer);
    this.lostTimer = 0;
    this.invalidate();
  };

  /** Frees the GPU resources and the context, and unhooks everything. */
  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.lostTimer);
    this.unbind();
    this.resize.disconnect();
    this.intersect?.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    this.world.dispose();
    this.renderer.dispose();
    // Hand the context back now (browsers allow only a few at once), and drop the canvas.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
