import {
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  LatheGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  Vector2,
  Vector3,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BlockedIcon, Mouth } from "./figure-look";

/**
 * The crew figure's parts (#420, #476), built from primitives (no model files): a soft
 * upside-down droplet on two feet with a light on its tip. Parts that move on their own (feet,
 * hands, eyes, mouths) are separate geometries placed per frame; the rest sits in the body's
 * frame. Origin on the floor between the feet; +z is the front.
 */

/** The body's profile: (radius, height), widest in the lower third. */
const PROFILE: [number, number][] = [
  [0, 0.06],
  [0.15, 0.07],
  [0.21, 0.13],
  [0.22, 0.2],
  [0.2, 0.3],
  [0.16, 0.4],
  [0.1, 0.5],
  [0.04, 0.58],
  [0, 0.6],
];
export const DEPTH = 0.9;
/** The tip light's centre. */
export const TIP_Y = 0.68;
/** The eyes' centre height, which blinking squashes toward. */
export const EYE_Y = 0.4;
/** The top of the figure, for its bubble. */
export const HEAD_Y = 0.75;

/** The body's radius at height y, from the profile. */
function radiusAt(y: number): number {
  for (let i = 1; i < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i - 1] as [number, number];
    const [r1, y1] = PROFILE[i] as [number, number];
    if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return 0;
}

/** Where the front surface is at (x, y), for the face and badge. */
export const frontZ = (x: number, y: number) =>
  Math.sqrt(Math.max(0, radiusAt(y) ** 2 - x * x)) * DEPTH;

/** Moves a fresh geometry into place and returns it. */
export function placed(
  g: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rot?: [number, number, number],
  scale?: [number, number, number],
) {
  if (scale) g.scale(...scale);
  if (rot) {
    g.rotateX(rot[0]);
    g.rotateY(rot[1]);
    g.rotateZ(rot[2]);
  }
  g.translate(x, y, z);
  return g;
}

/** A thin rod from one point to another. */
export function rod(from: [number, number, number], to: [number, number, number], r: number) {
  const a = new Vector3(...from);
  const b = new Vector3(...to);
  const dir = b.clone().sub(a);
  const g = new CylinderGeometry(r, r, dir.length(), 6);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()));
  const mid = a.add(b).multiplyScalar(0.5);
  return g.translate(mid.x, mid.y, mid.z);
}

export function merged(parts: BufferGeometry[]): BufferGeometry {
  // Some primitives come without an index (or without uvs); give every part both so they merge.
  const indexed = parts.map((g) => {
    if (!g.index) {
      const count = g.getAttribute("position").count;
      g.setIndex(Array.from({ length: count }, (_, i) => i));
    }
    return g;
  });
  const out = mergeGeometries(indexed) as BufferGeometry;
  for (const g of indexed) g.dispose();
  return out;
}

/** An arc of a ring in the face's plane: a smile (`up` false) or a frown, centred on (0, y). */
function arc(r: number, tube: number, sweep: number, y: number, z: number, up = false) {
  const start = up ? Math.PI / 2 - sweep / 2 : -Math.PI / 2 - sweep / 2;
  return placed(new TorusGeometry(r, tube, 6, 16, sweep), 0, y, z, [0, 0, start]);
}

/** A short horizontal bar on the face. */
function bar(length: number, y: number, z: number) {
  return placed(new CylinderGeometry(0.007, 0.007, length, 8), 0, y, z, [0, 0, Math.PI / 2]);
}

function mouths(): Record<Mouth, BufferGeometry> {
  const z = frontZ(0, 0.345) - 0.004;
  return {
    smile: arc(0.03, 0.007, Math.PI * 0.7, 0.37, z),
    "wide-smile": arc(0.045, 0.009, Math.PI * 0.85, 0.375, z),
    "flat-short": bar(0.03, 0.352, z),
    flat: bar(0.055, 0.352, z),
    // A small "o": a full ring, radius 0.015.
    o: placed(new TorusGeometry(0.015, 0.006, 6, 16), 0, 0.352, z),
    frown: arc(0.03, 0.007, Math.PI * 0.65, 0.325, z, true),
  };
}

function icons(): Record<BlockedIcon, BufferGeometry> {
  return {
    // Two cones point to point between two caps.
    hourglass: merged([
      placed(new ConeGeometry(0.035, 0.05, 10), 0, 0.025, 0, [Math.PI, 0, 0]),
      placed(new ConeGeometry(0.035, 0.05, 10), 0, -0.025, 0),
      placed(new CylinderGeometry(0.04, 0.04, 0.008, 12), 0, 0.054, 0),
      placed(new CylinderGeometry(0.04, 0.04, 0.008, 12), 0, -0.054, 0),
    ]),
    // A knotted loop of cable.
    cable: placed(new TorusKnotGeometry(0.03, 0.008, 40, 6, 2, 3), 0, 0, 0),
    ticket: merged([
      placed(new BoxGeometry(0.09, 0.055, 0.006), 0, 0, 0, [0, 0, 0.2]),
      placed(new CylinderGeometry(0.008, 0.008, 0.008, 8), 0.03, 0.006, 0.002, [Math.PI / 2, 0, 0]),
    ]),
    person: merged([
      placed(new SphereGeometry(0.02, 10, 8), 0, 0.03, 0),
      placed(new SphereGeometry(0.032, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, -0.03, 0),
    ]),
    // An empty chair: seat, back and four legs.
    chair: merged([
      placed(new BoxGeometry(0.06, 0.008, 0.06), 0, 0, 0),
      placed(new BoxGeometry(0.06, 0.06, 0.008), 0, 0.03, -0.026),
      ...[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) =>
          placed(new BoxGeometry(0.007, 0.045, 0.007), sx * 0.026, -0.024, sz * 0.026),
        ),
      ),
    ]),
  };
}

/** The figure's parts, each one geometry. */
export function crewGeometry() {
  const eyeZ = frontZ(0.07, EYE_Y) - 0.006;
  const body = new LatheGeometry(
    PROFILE.map(([r, y]) => new Vector2(r, y)),
    24,
  ).scale(1, 1, DEPTH);
  return {
    body: merged([body, placed(new CylinderGeometry(0.012, 0.012, 0.05, 8), 0, 0.625, 0)]),
    tip: placed(new SphereGeometry(0.045, 16, 12), 0, TIP_Y, 0),
    /** One foot, at the origin. */
    foot: placed(new SphereGeometry(0.07, 12, 8), 0, 0, 0, undefined, [1, 0.5, 1.4]),
    /** One hand, at the origin. */
    hand: new SphereGeometry(0.05, 12, 8),
    eyes: merged(
      [-0.07, 0.07].map((x) =>
        placed(new SphereGeometry(0.03, 12, 8), x, EYE_Y, eyeZ, undefined, [1, 1, 0.45]),
      ),
    ),
    catchlights: merged(
      [-0.07, 0.07].map((x) =>
        placed(new SphereGeometry(0.009, 8, 6), x - 0.01, EYE_Y + 0.012, eyeZ + 0.011),
      ),
    ),
    rim: placed(new CylinderGeometry(0.078, 0.078, 0.008, 24), 0, 0.17, frontZ(0, 0.17) - 0.002, [
      Math.PI / 2,
      0,
      0,
    ]),
    badge: placed(new CircleGeometry(0.07, 24), 0, 0.17, frontZ(0, 0.17) + 0.0025),
    shadow: placed(new CircleGeometry(0.24, 24), 0, 0.004, 0.02, [-Math.PI / 2, 0, 0]),
    // Builder: a knotted neckerchief.
    neckerchief: merged([
      placed(new TorusGeometry(0.17, 0.03, 8, 24), 0, 0.33, 0, [Math.PI / 2, 0, 0], [1, DEPTH, 1]),
      ...[-1, 1].map((side) =>
        placed(new ConeGeometry(0.03, 0.09, 8), side * 0.035, 0.27, frontZ(0, 0.3) + 0.025, [
          Math.PI + 0.3,
          0,
          side * 0.4,
        ]),
      ),
    ]),
    // Reviewer: round glasses.
    glasses: merged([
      ...[-0.07, 0.07].map((x) =>
        placed(new TorusGeometry(0.04, 0.006, 6, 20), x, EYE_Y, eyeZ + 0.01),
      ),
      placed(new CylinderGeometry(0.005, 0.005, 0.06, 6), 0, EYE_Y + 0.005, eyeZ + 0.016, [
        0,
        0,
        Math.PI / 2,
      ]),
    ]),
    // Rebaser and integrator: a collar, and a wrench in the right hand.
    collar: placed(
      new TorusGeometry(0.19, 0.02, 8, 24),
      0,
      0.29,
      0,
      [Math.PI / 2, 0, 0],
      [1, DEPTH, 1],
    ),
    wrench: merged([
      placed(new CylinderGeometry(0.012, 0.012, 0.15, 8), 0.02, 0.07, 0.03),
      placed(new TorusGeometry(0.028, 0.011, 6, 12, Math.PI * 1.5), 0.02, 0.165, 0.03, [
        0,
        0,
        -Math.PI * 0.25,
      ]),
    ]),
    // PM: a headset over the dome, below the stem, with a mic boom.
    headset: merged([
      placed(new TorusGeometry(0.125, 0.012, 6, 20, Math.PI), 0, 0.47, 0),
      ...[-0.125, 0.125].map((x) => placed(new SphereGeometry(0.035, 10, 8), x, 0.46, 0)),
    ]),
    mic: merged([
      rod([-0.13, 0.44, 0.03], [-0.05, 0.355, frontZ(-0.05, 0.355) + 0.01], 0.006),
      placed(new SphereGeometry(0.016, 8, 6), -0.05, 0.355, frontZ(-0.05, 0.355) + 0.01),
    ]),
    // Scout: a spyglass in the right hand. Area reviewers: a magnifier.
    spyglass: merged([
      placed(new CylinderGeometry(0.018, 0.024, 0.16, 10), 0.02, 0.06, 0.04, [0.5, 0, 0]),
      placed(new CylinderGeometry(0.026, 0.026, 0.02, 10), 0.02, 0.13, 0.08, [0.5, 0, 0]),
    ]),
    magnifier: merged([
      placed(new CylinderGeometry(0.01, 0.01, 0.09, 8), 0.02, 0.05, 0.03),
      placed(new TorusGeometry(0.04, 0.008, 6, 20), 0.02, 0.135, 0.03),
    ]),
    lens: placed(new CircleGeometry(0.036, 20), 0.02, 0.135, 0.032),
    // Status extras: thinking dots round the tip, the approval beacon's ring, the idle mug.
    dots: merged(
      [0, 1, 2].map((i) => {
        const a = (i * Math.PI * 2) / 3;
        return placed(new SphereGeometry(0.014, 8, 6), Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1);
      }),
    ),
    halo: placed(new TorusGeometry(0.07, 0.008, 6, 32), 0, 0, 0, [Math.PI / 2, 0, 0]),
    mug: merged([
      placed(new CylinderGeometry(0.035, 0.032, 0.075, 14), 0.03, 0.035, 0.03),
      placed(new TorusGeometry(0.02, 0.006, 6, 12, Math.PI), 0.068, 0.035, 0.03, [
        0,
        0,
        -Math.PI / 2,
      ]),
    ]),
    // Carried things: a ticket (paper) and a PR crate (wood).
    ticket: placed(new BoxGeometry(0.2, 0.012, 0.14), 0, 0, 0),
    crate: placed(new BoxGeometry(0.22, 0.17, 0.22), 0, 0, 0),
    // Confetti and smoke (moments).
    confetti: new BoxGeometry(0.03, 0.004, 0.018),
    puff: new SphereGeometry(0.05, 10, 8),
    ring: dashedRing(0.32, 0.36, 18),
    ...prefixed(mouths()),
    ...prefixedIcons(icons()),
  };
}

function prefixed(m: Record<Mouth, BufferGeometry>) {
  const out = {} as Record<`mouth:${Mouth}`, BufferGeometry>;
  for (const [k, g] of Object.entries(m)) out[`mouth:${k as Mouth}`] = g;
  return out;
}

function prefixedIcons(m: Record<BlockedIcon, BufferGeometry>) {
  const out = {} as Record<`icon:${BlockedIcon}`, BufferGeometry>;
  for (const [k, g] of Object.entries(m)) out[`icon:${k as BlockedIcon}`] = g;
  return out;
}

/** A dashed ring flat on the floor: `n` dashes with gaps between them. */
export function dashedRing(inner: number, outer: number, n: number): BufferGeometry {
  const step = (Math.PI * 2) / n;
  return merged(
    Array.from({ length: n }, (_, i) =>
      placed(new RingGeometry(inner, outer, 4, 1, i * step, step * 0.6), 0, 0.006, 0, [
        -Math.PI / 2,
        0,
        0,
      ]),
    ),
  );
}

export type CrewGeometry = ReturnType<typeof crewGeometry>;
export type Part = keyof CrewGeometry;
