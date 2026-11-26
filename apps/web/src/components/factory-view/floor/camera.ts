import { OrthographicCamera, Vector3 } from "three";
import type { Box } from "../scene/layout";

/**
 * Floor mode's camera (#420): orthographic, looking down 30° from the horizontal and turned 45°
 * around the vertical, so the pipeline runs from the back-left corner to the front-right one. It
 * fits the Workshop with 8% margins; dragging pans, the wheel or a pinch zooms (between 0.6× and
 * 4× the fit). Movement eases out over about a quarter of a second; with reduced motion it jumps.
 * Selecting an agent flies to it in about 1.5 s, easing in and out (#476); any pan or zoom takes
 * over from a flight at once.
 */

const PITCH = (30 * Math.PI) / 180;
const YAW = (45 * Math.PI) / 180;
const MARGIN = 0.08;
export const ZOOM_MIN = 0.6;
export const ZOOM_MAX = 4;
/** Easing time constant: within 2% of the goal after about 0.25 s. */
const TAU = 0.064;
const DISTANCE = 60;
/** A flight to a selected agent takes this long. */
export const FLIGHT_S = 1.5;
/** A flight zooms in to at least this much of the fit, so the figure reads. */
const FLIGHT_ZOOM = 1.8;

/** Ease in and out (cubic). */
export const easeInOut = (k: number): number => {
  const x = Math.min(1, Math.max(0, k));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** From the target toward the camera. */
const BACK = new Vector3(
  Math.cos(PITCH) * Math.sin(YAW),
  Math.sin(PITCH),
  Math.cos(PITCH) * Math.cos(YAW),
);
const FORWARD = BACK.clone().negate();
const RIGHT = new Vector3().crossVectors(FORWARD, new Vector3(0, 1, 0)).normalize();
const UP = new Vector3().crossVectors(RIGHT, FORWARD).normalize();

interface View {
  /** The view's centre, on screen axes (world units along RIGHT and UP). */
  x: number;
  y: number;
  zoom: number;
}

/** A box in the world: what the camera frames (a storey, with its walls). */
export interface Box3D {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** Boxes in screen axes: their corners, projected. */
function screenBox(boxes: readonly Box3D[]) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const p = new Vector3();
  for (const box of boxes)
    for (const x of [box.x0, box.x1])
      for (const y of [box.y0, box.y1])
        for (const z of [box.z0, box.z1]) {
          p.set(x, y, z);
          const sx = p.dot(RIGHT);
          const sy = p.dot(UP);
          minX = Math.min(minX, sx);
          maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy);
          maxY = Math.max(maxY, sy);
        }
  return { minX, maxX, minY, maxY };
}

export class CameraRig {
  readonly camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, DISTANCE * 2);
  private aspect = 1;
  private heightPx = 1;
  private bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  private fitZoom = 1;
  private goal: View = { x: 0, y: 0, zoom: 1 };
  private now: View = { x: 0, y: 0, zoom: 1 };
  private flight: { from: View; to: View; elapsed: number } | null = null;
  reduced = false;
  /** CSS pixels on the left that something covers (the open roster): the fit keeps clear. */
  insetPx = 0;

  /** The viewport's size in CSS pixels. */
  setViewport(width: number, height: number): void {
    this.aspect = Math.max(0.01, width / Math.max(1, height));
    this.heightPx = Math.max(1, height);
    this.camera.left = -this.aspect / 2;
    this.camera.right = this.aspect / 2;
    this.camera.top = 0.5;
    this.camera.bottom = -0.5;
  }

  /** The hall to frame, `height` tall (its walls). */
  setScene(box: Box, height: number): void {
    this.setBoxes([{ ...box, y0: 0, y1: height }]);
  }

  /** What to frame: one storey, or both. */
  setBoxes(boxes: readonly Box3D[]): void {
    this.bounds = screenBox(boxes);
  }

  /** Frames the whole hall; `animate` eases there, else it jumps. */
  fit(animate: boolean): void {
    const { minX, maxX, minY, maxY } = this.bounds;
    const room = 1 - 2 * MARGIN;
    const inset = Math.min(this.insetPx, this.aspect * this.heightPx * 0.5);
    const usable = (this.aspect * this.heightPx - inset) / this.heightPx;
    this.fitZoom = Math.min((usable * room) / (maxX - minX), room / (maxY - minY));
    // Centre the hall in the part of the view that isn't covered.
    const k = 1 / (this.fitZoom * this.heightPx);
    this.goal = {
      x: (minX + maxX) / 2 - (inset / 2) * k,
      y: (minY + maxY) / 2,
      zoom: this.fitZoom,
    };
    this.flight = null;
    if (!animate || this.reduced) this.now = { ...this.goal };
    this.apply();
  }

  /** Flies to world point p (centred in the uncovered part of the view), zooming in a little. */
  flyTo(p: { x: number; y: number; z: number }): void {
    const zoom = Math.min(
      this.fitZoom * ZOOM_MAX,
      Math.max(this.goal.zoom, this.fitZoom * FLIGHT_ZOOM),
    );
    const inset = Math.min(this.insetPx, this.aspect * this.heightPx * 0.5);
    const k = 1 / (zoom * this.heightPx);
    const at = new Vector3(p.x, p.y, p.z);
    const to = this.clamp({ x: at.dot(RIGHT) - (inset / 2) * k, y: at.dot(UP), zoom });
    this.goal = to;
    if (this.reduced) {
      this.flight = null;
      this.now = { ...to };
      this.apply();
      return;
    }
    this.flight = { from: { ...this.now }, to, elapsed: 0 };
  }

  /** CSS pixels per world unit on screen, at the current zoom. */
  pxPerUnit(): number {
    return this.now.zoom * this.heightPx;
  }

  /** Whether the view still moves toward its goal. */
  get moving(): boolean {
    return (
      this.flight !== null ||
      this.now.x !== this.goal.x ||
      this.now.y !== this.goal.y ||
      this.now.zoom !== this.goal.zoom
    );
  }

  /** Pans by a pointer movement in CSS pixels. */
  pan(dxPx: number, dyPx: number): void {
    this.takeOver();
    const k = 1 / (this.goal.zoom * this.heightPx);
    this.goal = this.clamp({ ...this.goal, x: this.goal.x - dxPx * k, y: this.goal.y + dyPx * k });
  }

  /** Zooms by `factor` around a point given in CSS pixels from the viewport's centre (y down). */
  zoomAt(factor: number, ox: number, oy: number): void {
    this.takeOver();
    const zoom = Math.min(
      this.fitZoom * ZOOM_MAX,
      Math.max(this.fitZoom * ZOOM_MIN, this.goal.zoom * factor),
    );
    const before = 1 / (this.goal.zoom * this.heightPx);
    const after = 1 / (zoom * this.heightPx);
    // Keep the point under the pointer where it is.
    this.goal = this.clamp({
      x: this.goal.x + ox * (before - after),
      y: this.goal.y - oy * (before - after),
      zoom,
    });
  }

  /** A pan or zoom during a flight starts from where the flight is now. */
  private takeOver(): void {
    if (!this.flight) return;
    this.flight = null;
    this.goal = { ...this.now };
  }

  /** Keeps the view's centre over the hall. */
  private clamp(v: View): View {
    const { minX, maxX, minY, maxY } = this.bounds;
    return {
      zoom: v.zoom,
      x: Math.min(maxX, Math.max(minX, v.x)),
      y: Math.min(maxY, Math.max(minY, v.y)),
    };
  }

  /** Moves toward the goal; returns whether it still moves (and wants another frame). */
  step(dt: number): boolean {
    if (this.flight) {
      const f = this.flight;
      f.elapsed += Math.max(0, dt);
      const k = easeInOut(f.elapsed / FLIGHT_S);
      this.now = {
        x: f.from.x + (f.to.x - f.from.x) * k,
        y: f.from.y + (f.to.y - f.from.y) * k,
        // Zoom eases on a log scale, so it feels even.
        zoom: f.from.zoom * (f.to.zoom / f.from.zoom) ** k,
      };
      if (f.elapsed >= FLIGHT_S) {
        this.flight = null;
        this.now = { ...f.to };
      }
      this.apply();
      return this.flight !== null;
    }
    if (this.reduced) this.now = { ...this.goal };
    else {
      const a = 1 - Math.exp(-Math.max(0, dt) / TAU);
      this.now = {
        x: this.now.x + (this.goal.x - this.now.x) * a,
        y: this.now.y + (this.goal.y - this.now.y) * a,
        zoom: this.now.zoom + (this.goal.zoom - this.now.zoom) * a,
      };
    }
    const settled =
      Math.abs(this.goal.x - this.now.x) * this.now.zoom * this.heightPx < 0.25 &&
      Math.abs(this.goal.y - this.now.y) * this.now.zoom * this.heightPx < 0.25 &&
      Math.abs(this.goal.zoom - this.now.zoom) / this.goal.zoom < 0.001;
    if (settled) this.now = { ...this.goal };
    this.apply();
    return !settled;
  }

  private apply(): void {
    const target = RIGHT.clone().multiplyScalar(this.now.x).addScaledVector(UP, this.now.y);
    this.camera.position.copy(target).addScaledVector(BACK, DISTANCE);
    this.camera.up.copy(UP);
    this.camera.lookAt(target);
    this.camera.zoom = this.now.zoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }
}
