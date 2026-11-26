import {
  type BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from "three";
import type { Rgb } from "@/lib/oklch";
import { DESK, type WorkshopLayout } from "../scene/layout";
import { type DeskProp, deskProps, type SeatUse, seatKey } from "./desk-props";
import { at, colour, type Kit } from "./kit";
import type { FloorPalette } from "./palette";
import { whiteboardCanvas } from "./textures";

/**
 * The step props on Floor mode's occupied desks (which ones: `deskProps`). They share the desk
 * with its laptop (centred, 0.3 wide, its lid at the front edge): tall props stand to the right
 * of it or, for the whiteboard, to the left, where they don't hide the figure from the camera;
 * flat ones lie in front. Every box is one instanced mesh with a colour each, every cylinder
 * another, the jars' glass a third and the whiteboards' faces a fourth, however many desks.
 * Built with the live props, so they follow each agent's step.
 */

/** The centre of a desk's top. */
interface DeskTop {
  x: number;
  y: number;
  z: number;
}

/** Lays a cylinder's axis (y) along x. */
const LAY = new Matrix4().makeRotationZ(Math.PI / 2);

/** Every part's instances, by mesh. */
class Parts {
  readonly boxes: Matrix4[] = [];
  readonly boxColours: Rgb[] = [];
  readonly cylinders: Matrix4[] = [];
  readonly cylinderColours: Rgb[] = [];
  readonly glass: Matrix4[] = [];
  readonly boards: Matrix4[] = [];

  /** A box centred at (x, y, z), turned around y. */
  box(rgb: Rgb, x: number, y: number, z: number, size: [number, number, number], turn = 0) {
    this.boxes.push(at(x, y, z, turn, size));
    this.boxColours.push(rgb);
  }

  /** An upright cylinder of radius `r` and height `h`, centred at (x, y, z). */
  upright(rgb: Rgb, x: number, y: number, z: number, r: number, h: number) {
    this.cylinders.push(at(x, y, z, 0, [2 * r, h, 2 * r]));
    this.cylinderColours.push(rgb);
  }

  /** A cylinder lying along x, turned around y, of radius `r` and length `len`. */
  lying(rgb: Rgb, x: number, y: number, z: number, r: number, len: number, turn: number) {
    this.cylinders.push(
      at(x, y, z, turn)
        .multiply(LAY)
        .scale(new Vector3(2 * r, len, 2 * r)),
    );
    this.cylinderColours.push(rgb);
  }
}

/** The point `lx` along and `lz` across something at (x, z) turned `turn` around y. */
function offset(x: number, z: number, turn: number, lx: number, lz: number) {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  return { x: x + lx * c + lz * s, z: z - lx * s + lz * c };
}

const shade = (rgb: Rgb, k: number): Rgb => [rgb[0] * k, rgb[1] * k, rgb[2] * k];

/** The whiteboard's face, and where it stands: left of the laptop, turned to the camera. */
const BOARD = { w: 0.24, h: 0.17, dx: -0.28, lift: 0.03, turn: 0.5 };

type PropBuilder = (parts: Parts, d: DeskTop, p: FloorPalette, bench: Rgb) => void;

const BUILD: Record<DeskProp, PropBuilder> = {
  // A big glass jar right of the laptop (the glass is its own mesh), with a red bug inside.
  jar: (parts, d, p) => {
    const x = d.x + 0.26;
    const z = d.z - 0.03;
    const r = 0.082;
    const h = 0.21;
    parts.glass.push(at(x, d.y + h / 2, z, 0, [2 * r, h, 2 * r]));
    parts.upright(p.chrome, x, d.y + h + 0.012, z, r + 0.006, 0.024);
    // The bug faces the camera: a round red back with a dark stripe, a dark head, three legs.
    const turn = Math.PI / 4;
    parts.upright(p.red, x, d.y + 0.03, z, 0.044, 0.034);
    parts.box(p.ink, x, d.y + 0.048, z, [0.006, 0.004, 0.086], turn);
    const head = offset(x, z, turn, 0, 0.054);
    parts.box(p.ink, head.x, d.y + 0.028, head.z, [0.042, 0.026, 0.028], turn);
    for (const lz of [-0.024, 0, 0.024]) {
      const leg = offset(x, z, turn, 0, lz);
      parts.box(p.ink, leg.x, d.y + 0.01, leg.z, [0.11, 0.006, 0.009], turn);
    }
  },
  // A magnifier lying in front of the jar: a dark rim, a pale lens, a dark handle.
  magnifier: (parts, d, p) => {
    const x = d.x + 0.2;
    const z = d.z + 0.16;
    const turn = -0.4;
    parts.upright(p.ink, x, d.y + 0.006, z, 0.05, 0.012);
    parts.upright(p.glass, x, d.y + 0.0125, z, 0.042, 0.004);
    const grip = offset(x, z, turn, 0.09, 0);
    parts.box(p.ink, grip.x, d.y + 0.008, grip.z, [0.08, 0.016, 0.02], turn);
  },
  // The whiteboard on little feet left of the laptop, two sticky notes on its right half.
  whiteboard: (parts, d, p) => {
    const x = d.x + BOARD.dx;
    const z = d.z;
    const t = BOARD.turn;
    const cy = d.y + BOARD.lift + BOARD.h / 2;
    const face = offset(x, z, t, 0, 0.0075);
    parts.boards.push(at(face.x, cy, face.z, t));
    parts.box(p.steel, x, cy, z, [BOARD.w + 0.02, BOARD.h + 0.02, 0.012], t);
    for (const lx of [-0.09, 0.09]) {
      const foot = offset(x, z, t, lx, 0);
      parts.box(p.steel, foot.x, d.y + BOARD.lift / 2, foot.z, [0.012, BOARD.lift, 0.06], t);
    }
    for (const [i, ly] of [0.05, -0.05].entries()) {
      const note = offset(x, z, t, 0.085, 0.0095);
      parts.box(p.notes[i] ?? p.paper, note.x, cy + ly, note.z, [0.042, 0.042, 0.003], t);
    }
  },
  // Sticky notes scattered right of the laptop.
  notes: (parts, d, p) => {
    const spots: [number, number, number][] = [
      [0.23, -0.06, 0.2],
      [0.31, 0.02, -0.35],
      [0.24, 0.12, 0.6],
    ];
    spots.forEach(([dx, dz, turn], i) => {
      const rgb = p.notes[i % p.notes.length] ?? p.paper;
      parts.box(rgb, d.x + dx, d.y + 0.003 + i * 0.001, d.z + dz, [0.06, 0.005, 0.06], turn);
    });
  },
  // A toolbox right of the laptop, in the builder's colour, with a dark handle and a latch.
  toolbox: (parts, d, p) => {
    const x = d.x + 0.27;
    const z = d.z + 0.02;
    const t = -0.12;
    const body = p.accent.builder;
    parts.box(body, x, d.y + 0.04, z, [0.19, 0.08, 0.11], t);
    parts.box(shade(body, 0.72), x, d.y + 0.0855, z, [0.195, 0.011, 0.115], t);
    for (const lx of [-0.045, 0.045]) {
      const post = offset(x, z, t, lx, 0);
      parts.box(p.ink, post.x, d.y + 0.1, post.z, [0.012, 0.022, 0.012], t);
    }
    parts.box(p.ink, x, d.y + 0.112, z, [0.11, 0.012, 0.016], t);
    const latch = offset(x, z, t, 0, 0.057);
    parts.box(p.chrome, latch.x, d.y + 0.07, latch.z, [0.03, 0.02, 0.006], t);
  },
  // A wrench lying in front left of the laptop: an open jaw at one end, a ring at the other.
  wrench: (parts, d, p, bench) => {
    const x = d.x - 0.27;
    const z = d.z + 0.14;
    const t = 0.45;
    const y = d.y + 0.005;
    parts.box(p.chrome, x, y, z, [0.12, 0.01, 0.022], t);
    const jaw = offset(x, z, t, 0.068, 0);
    parts.box(p.chrome, jaw.x, y, jaw.z, [0.02, 0.01, 0.05], t);
    for (const lz of [-0.017, 0.017]) {
      const prong = offset(x, z, t, 0.088, lz);
      parts.box(p.chrome, prong.x, y, prong.z, [0.022, 0.01, 0.014], t);
    }
    const ring = offset(x, z, t, -0.07, 0);
    parts.upright(p.chrome, ring.x, y, ring.z, 0.021, 0.01);
    parts.upright(bench, ring.x, y + 0.0005, ring.z, 0.011, 0.011);
  },
  // A blueprint roll lying in front left of the laptop, with two paper bands.
  blueprint: (parts, d, p) => {
    const x = d.x - 0.27;
    const z = d.z + 0.14;
    const t = 0.35;
    const r = 0.026;
    parts.lying(p.blueprint, x, d.y + r, z, r, 0.22, t);
    for (const lx of [-0.06, 0.06]) {
      const band = offset(x, z, t, lx, 0);
      parts.lying(p.paper, band.x, d.y + r, band.z, r + 0.002, 0.012, t);
    }
  },
  // The review clipboard right of the laptop: a board, its paper and a bright clip.
  clipboard: (parts, d, p) => {
    const t = -0.25;
    parts.box(p.wood, d.x + 0.3, d.y + 0.006, d.z + 0.04, [0.13, 0.012, 0.18], t);
    parts.box(p.paper, d.x + 0.3, d.y + 0.014, d.z + 0.05, [0.11, 0.004, 0.14], t);
    const clip = offset(d.x + 0.3, d.z + 0.04, t, 0, -0.075);
    parts.box(p.chrome, clip.x, d.y + 0.018, clip.z, [0.055, 0.012, 0.022], t);
  },
  // A red pen lying across the clipboard's paper, its cap dark.
  pen: (parts, d, p) => {
    const c = offset(d.x + 0.3, d.z + 0.04, -0.25, 0, 0.025);
    const t = 0.5;
    const r = 0.008;
    parts.lying(p.red, c.x, d.y + 0.016 + r, c.z, r, 0.13, t);
    const cap = offset(c.x, c.z, t, 0.055, 0);
    parts.lying(p.ink, cap.x, d.y + 0.016 + r, cap.z, r + 0.0006, 0.026, t);
  },
};

/** The step props on every occupied desk, as a few instanced meshes. */
export function buildDeskProps(
  layout: WorkshopLayout,
  p: FloorPalette,
  kit: Kit,
  unit: BoxGeometry,
  occupied: ReadonlyMap<string, SeatUse>,
): Group {
  const group = new Group();
  const parts = new Parts();
  for (const seat of [...layout.seats.prep, ...layout.seats.bench, ...layout.seats.review]) {
    if (!seat.desk) continue;
    const top = { x: seat.desk.x, y: seat.floorY + DESK.h, z: seat.desk.z };
    const deskRgb = seat.station === "bench" ? p.bench : p.desk;
    for (const prop of deskProps(seat.station, occupied.get(seatKey(seat))))
      BUILD[prop](parts, top, p, deskRgb);
  }

  const matte = kit.matte(null, { roughness: 0.55 });
  const solid = [
    kit.instanced(unit, matte, parts.boxes, parts.boxColours),
    parts.cylinders.length > 0
      ? kit.instanced(
          kit.own(new CylinderGeometry(0.5, 0.5, 1, 16)),
          matte,
          parts.cylinders,
          parts.cylinderColours,
        )
      : null,
  ];
  for (const mesh of solid) if (mesh) group.add(mesh);

  if (parts.glass.length > 0) {
    const glass = kit.own(
      new MeshStandardMaterial({
        color: colour(p.glass),
        // A faint glow of its own, so the glass reads as glass on a dark floor too.
        emissive: colour(p.glass),
        emissiveIntensity: 0.18,
        transparent: true,
        opacity: 0.34,
        roughness: 0.1,
        depthWrite: false,
      }),
    );
    const jars = kit.instanced(
      kit.own(new CylinderGeometry(0.5, 0.5, 1, 20)),
      glass,
      parts.glass,
      undefined,
      { cast: false, receive: false },
    );
    if (jars) {
      jars.renderOrder = 1;
      group.add(jars);
    }
  }

  if (parts.boards.length > 0) {
    const face = kit.matte(null, { map: kit.canvasTexture(whiteboardCanvas(p)), roughness: 0.4 });
    const boards = kit.instanced(
      kit.own(new PlaneGeometry(BOARD.w, BOARD.h)),
      face,
      parts.boards,
      undefined,
      { cast: false, receive: true },
    );
    if (boards) group.add(boards);
  }
  return group;
}
