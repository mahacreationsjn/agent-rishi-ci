import { Box3, type Camera, Ray, Vector3 } from "three";

/**
 * Between the scene and the screen (#476): where a point in the hall shows on the canvas (for
 * the DOM thought bubbles, name tags and cards over it) and which figure a pointer is on (a ray
 * against an invisible box around each figure). Pure: give it a camera and the viewport.
 */

export interface Viewport {
  /** CSS pixels. */
  width: number;
  height: number;
}

export interface ScreenPoint {
  /** CSS pixels from the canvas's top left. */
  x: number;
  y: number;
  /** Inside the viewport (with a small margin). */
  inView: boolean;
}

const v = new Vector3();

/** Where world point `p` shows on the canvas. */
export function screenAnchor(
  camera: Camera,
  view: Viewport,
  p: { x: number; y: number; z: number },
): ScreenPoint {
  v.set(p.x, p.y, p.z).project(camera);
  const x = ((v.x + 1) / 2) * view.width;
  const y = ((1 - v.y) / 2) * view.height;
  const m = 24;
  return { x, y, inView: x >= -m && x <= view.width + m && y >= -m && y <= view.height + m };
}

/** A figure's pick box: its feet and how far the box reaches around them. */
export interface PickTarget {
  key: string;
  x: number;
  y: number;
  z: number;
}

/** Half the pick box's width and depth, and its height; coarse pointers get a bigger one. */
export function pickBox(coarse: boolean): { half: number; height: number } {
  return coarse ? { half: 0.42, height: 1 } : { half: 0.28, height: 0.82 };
}

const box = new Box3();
const hit = new Vector3();

/** The figure whose box `ray` meets first (nearest the camera), or null. */
export function pickFigure(
  ray: Ray,
  targets: readonly PickTarget[],
  size = pickBox(false),
): string | null {
  let best: string | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const t of targets) {
    box.min.set(t.x - size.half, t.y, t.z - size.half);
    box.max.set(t.x + size.half, t.y + size.height, t.z + size.half);
    if (!ray.intersectBox(box, hit)) continue;
    const d = hit.distanceToSquared(ray.origin);
    if (d < bestD) {
      bestD = d;
      best = t.key;
    }
  }
  return best;
}

/** The ray under a canvas point, from `camera`. */
export function rayAt(camera: Camera, view: Viewport, x: number, y: number): Ray {
  const ndc = new Vector3((x / view.width) * 2 - 1, 1 - (y / view.height) * 2, -1);
  const origin = ndc.clone().unproject(camera);
  const far = ndc.clone().setZ(1).unproject(camera);
  return new Ray(origin, far.sub(origin).normalize());
}
