import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Rgb } from "@/lib/oklch";
import {
  BOOTH,
  CURB_H,
  DESK,
  type LayoutSeat,
  type LayoutZone,
  SEAT_PITCH,
  WALL_H,
  type WorkshopLayout,
} from "../scene/layout";
import { hasLaptop } from "./desk-props";
import { at, type Kit, setColour } from "./kit";
import type { FloorPalette } from "./palette";
import { floorCanvas, signAtlas, slatsCanvas } from "./textures";

/**
 * Floor mode's hall (#420): everything that stays put while the layout does. A concrete floor
 * with painted lanes and zone names, the back and left walls at full height and the front and
 * right ones as a low curb (a cutaway, no roof), the zone signs, desks, workbenches and laptops,
 * the merge conveyors, the repair bay's fence, the PM's glass booth and the doors.
 * Repeated parts are instanced. Rebuilt when the layout grows or the theme changes.
 */

/** A box: centre and size, with an optional turn around y. */
export interface BoxSpec {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  turn?: number;
}

/** Many boxes in one draw call: a unit cube scaled per instance. */
export function boxes(
  kit: Kit,
  unit: BoxGeometry,
  material: Material,
  specs: BoxSpec[],
  colours?: Rgb[],
) {
  return kit.instanced(
    unit,
    material,
    specs.map((b) => at(b.x, b.y, b.z, b.turn ?? 0, [b.w, b.h, b.d])),
    colours,
  );
}

/** The sign labels, in atlas order: the zones, then the PM's booth. */
function signLabels(layout: WorkshopLayout): string[] {
  return [...layout.zones.map((z) => z.label), "PM BOOTH"];
}

/** Planes that each show one row of a vertical atlas, merged into one geometry. */
function atlasPlanes(rows: { w: number; h: number; m: Matrix4 }[]): BufferGeometry {
  const n = rows.length;
  const parts = rows.map((r, i) => {
    const g = new PlaneGeometry(r.w, r.h);
    const uv = g.getAttribute("uv");
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (i + 1) / n + uv.getY(k) / n);
    g.applyMatrix4(r.m);
    return g;
  });
  const merged = mergeGeometries(parts) as BufferGeometry;
  for (const g of parts) g.dispose();
  return merged;
}

const add = (group: Group, ...things: (Mesh | null)[]) => {
  for (const t of things) if (t) group.add(t);
};

export function buildWorkshop(layout: WorkshopLayout, p: FloorPalette, kit: Kit): Group {
  const group = new Group();
  const unit = kit.own(new BoxGeometry(1, 1, 1));
  const { x0, x1, z0, z1 } = layout.bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;

  // The floor, painted in one texture.
  const floorTex = kit.canvasTexture(floorCanvas(layout, p));
  const floor = new Mesh(
    kit.own(new PlaneGeometry(w, d)),
    kit.matte(null, { map: floorTex, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(cx, 0, cz);
  floor.receiveShadow = true;
  group.add(floor);

  // Walls: the back and left at full height, the front and right a curb (with the dock door).
  const wall = kit.matte(p.wall, { roughness: 0.95 });
  const door = layout.shipDoor;
  const walls: BoxSpec[] = [
    { x: cx - 0.06, y: WALL_H / 2, z: z0 - 0.06, w: w + 0.12, h: WALL_H, d: 0.12 },
    { x: x0 - 0.06, y: WALL_H / 2, z: cz, w: 0.12, h: WALL_H, d: d },
    { x: cx, y: CURB_H / 2, z: z1 + 0.06, w: w + 0.24, h: CURB_H, d: 0.12 },
  ];
  const doorBack = door.z - door.w / 2;
  const doorFront = door.z + door.w / 2;
  walls.push(
    { x: x1 + 0.06, y: CURB_H / 2, z: (z0 + doorBack) / 2, w: 0.12, h: CURB_H, d: doorBack - z0 },
    { x: x1 + 0.06, y: CURB_H / 2, z: (doorFront + z1) / 2, w: 0.12, h: CURB_H, d: z1 - doorFront },
  );
  add(group, boxes(kit, unit, wall, walls));

  const steel = kit.matte(p.steel, { roughness: 0.5, metalness: 0.3 });
  const steelParts: BoxSpec[] = [];
  const woodParts: BoxSpec[] = [];
  const darkParts: BoxSpec[] = [];

  // Zone signs on the back wall, and the booth's sign; their text comes from one atlas.
  const labels = signLabels(layout);
  const signRows = layout.zones.map((zone: LayoutZone) => ({
    w: 1.36,
    h: 0.34,
    m: at((zone.x0 + zone.x1) / 2, 1.3, z0 + 0.045),
  }));
  const booth = layout.booth;
  const boothTop = BOOTH.h + 1.05;
  signRows.push({
    w: 1,
    h: 0.25,
    m: at((booth.x0 + booth.x1) / 2, boothTop + 0.16, booth.z1 + 0.03),
  });
  for (const r of signRows) {
    const e = r.m.elements;
    darkParts.push({
      x: e[12] as number,
      y: e[13] as number,
      z: (e[14] as number) - 0.025,
      w: r.w + 0.04,
      h: r.h + 0.04,
      d: 0.04,
    });
  }
  const atlas = kit.canvasTexture(signAtlas(labels, p));
  group.add(
    new Mesh(kit.own(atlasPlanes(signRows)), kit.matte(null, { map: atlas, roughness: 0.6 })),
  );

  // Desks and workbenches, with legs, and a laptop on every desk where an agent works at a
  // computer, seated or not; the props for each step come with the live props.
  const tops: BoxSpec[] = [];
  const topColours: Rgb[] = [];
  const legs: BoxSpec[] = [];
  const laptops: BoxSpec[] = [];
  const desks: LayoutSeat[] = [
    ...layout.seats.prep,
    ...layout.seats.bench,
    ...layout.seats.review,
    ...layout.seats.pm,
  ];
  for (const seat of desks) {
    if (!seat.desk) continue;
    const { x, z } = seat.desk;
    const y = seat.floorY;
    tops.push({ x, y: y + DESK.h - 0.02, z, w: DESK.w, h: 0.04, d: DESK.d });
    topColours.push(seat.station === "bench" ? p.bench : p.desk);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        legs.push({
          x: x + sx * 0.36,
          y: y + (DESK.h - 0.04) / 2,
          z: z + sz * 0.21,
          w: 0.04,
          h: DESK.h - 0.04,
          d: 0.04,
        });
    if (hasLaptop(seat.station)) {
      const top = y + DESK.h;
      laptops.push({ x, y: top + 0.006, z: z - 0.02, w: 0.3, h: 0.012, d: 0.2 });
      // The lid stands at the far edge, its screen facing the figure behind the desk.
      const tilt = 0.21;
      const lid = new Matrix4()
        .makeRotationX(tilt)
        .setPosition(x, top + 0.012 + 0.0575 * Math.cos(tilt), z + 0.08 + 0.0575 * Math.sin(tilt));
      laptops.push({
        x: lid.elements[12] as number,
        y: lid.elements[13] as number,
        z: lid.elements[14] as number,
        w: 0.3,
        h: 0.115,
        d: 0.008,
      });
    }
  }
  add(
    group,
    boxes(kit, unit, kit.matte(null, { roughness: 0.6 }), tops, topColours),
    boxes(kit, unit, steel, legs),
    boxes(kit, unit, kit.matte(p.laptop, { roughness: 0.4, metalness: 0.2 }), laptops),
  );

  // The merge conveyors: one belt per row of seats, a slot per seat, the signal tower's pole.
  const merge = layout.seats.merge;
  const rows = new Map<number, LayoutSeat[]>();
  for (const seat of merge) {
    const z = seat.desk?.z ?? 0;
    rows.set(z, [...(rows.get(z) ?? []), seat]);
  }
  const belts: BoxSpec[] = [];
  const marks: BoxSpec[] = [];
  for (const [z, seats] of rows) {
    const xs = seats.map((s) => s.desk?.x ?? 0);
    const left = Math.min(...xs) - SEAT_PITCH / 2;
    const right = Math.max(...xs) + SEAT_PITCH / 2;
    steelParts.push({ x: (left + right) / 2, y: 0.11, z, w: right - left, h: 0.22, d: 0.44 });
    belts.push({ x: (left + right) / 2, y: 0.23, z, w: right - left - 0.04, h: 0.02, d: 0.36 });
    for (let k = 1; k < seats.length; k++)
      marks.push({ x: left + k * SEAT_PITCH, y: 0.242, z, w: 0.02, h: 0.004, d: 0.36 });
  }
  const tower = layout.signalTower;
  steelParts.push(
    { x: tower.x, y: 0.02, z: tower.z, w: 0.2, h: 0.04, d: 0.2 },
    { x: tower.x, y: 0.5, z: tower.z, w: 0.05, h: 0.96, d: 0.05 },
  );
  add(
    group,
    boxes(kit, unit, kit.matte(p.belt, { roughness: 0.9 }), belts),
    boxes(kit, unit, kit.matte(p.paper), marks),
  );

  // The repair bay's fence: short posts along its back and right edges, a gap to walk in.
  const bay = layout.bay;
  const posts: BoxSpec[] = [];
  for (let x = bay.x0 + 0.15; x <= bay.x1; x += 0.4)
    posts.push({ x, y: 0.18, z: bay.z0, w: 0.05, h: 0.36, d: 0.05 });
  for (let z = bay.z0 + 0.4; z <= bay.z1 - 0.7; z += 0.4)
    posts.push({ x: bay.x1, y: 0.18, z, w: 0.05, h: 0.36, d: 0.05 });
  const rails: BoxSpec[] = [0.3, 0.16].flatMap((y) => [
    { x: (bay.x0 + bay.x1) / 2 + 0.07, y, z: bay.z0, w: bay.x1 - bay.x0 - 0.1, h: 0.025, d: 0.025 },
    { x: bay.x1, y, z: (bay.z0 + bay.z1 - 0.7) / 2, w: 0.025, h: 0.025, d: bay.z1 - 0.7 - bay.z0 },
  ]);
  add(
    group,
    boxes(
      kit,
      unit,
      kit.matte(null, { roughness: 0.5 }),
      [...posts, ...rails],
      [...posts, ...rails].map(() => p.hazard),
    ),
  );

  // The PM's booth: a raised platform with glass walls on its open sides and a step up.
  const bx = (booth.x0 + booth.x1) / 2;
  const bz = (booth.z0 + booth.z1) / 2;
  darkParts.push({ x: bx, y: BOOTH.h / 2, z: bz, w: BOOTH.w, h: BOOTH.h, d: BOOTH.d });
  steelParts.push({ x: booth.x0 + 0.45, y: 0.075, z: booth.z1 + 0.15, w: 0.6, h: 0.15, d: 0.3 });
  const glassH = 1.0;
  const gy = BOOTH.h + glassH / 2;
  const glass: BoxSpec[] = [
    {
      x: (booth.x0 + 0.8 + booth.x1) / 2,
      y: gy,
      z: booth.z1,
      w: booth.x1 - booth.x0 - 0.8,
      h: glassH,
      d: 0.02,
    },
    { x: booth.x0, y: gy, z: bz, w: 0.02, h: glassH, d: BOOTH.d },
    { x: booth.x1, y: gy, z: bz, w: 0.02, h: glassH, d: BOOTH.d },
  ];
  for (const [x, z] of [
    [booth.x0, booth.z1],
    [booth.x1, booth.z1],
    [booth.x0, booth.z0],
    [booth.x1, booth.z0],
    [booth.x0 + 0.8, booth.z1],
  ] as const)
    steelParts.push({ x, y: gy, z, w: 0.05, h: glassH, d: 0.05 });
  steelParts.push(
    { x: bx, y: BOOTH.h + glassH, z: booth.z1, w: BOOTH.w, h: 0.05, d: 0.05 },
    { x: booth.x0, y: BOOTH.h + glassH, z: bz, w: 0.05, h: 0.05, d: BOOTH.d },
    { x: booth.x1, y: BOOTH.h + glassH, z: bz, w: 0.05, h: 0.05, d: BOOTH.d },
  );
  const glassMat = kit.own(
    new MeshStandardMaterial({
      roughness: 0.1,
      metalness: 0,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    }),
  );
  setColour(glassMat.color, p.glass);
  const glassMesh = boxes(kit, unit, glassMat, glass);
  if (glassMesh) {
    glassMesh.castShadow = false;
    glassMesh.renderOrder = 2;
  }
  add(group, glassMesh);

  // Intake's roll-up door and its ticket pallet; the dock door's frame in the right wall.
  const slats = kit.canvasTexture(slatsCanvas(p));
  const inDoor = new Mesh(unit, kit.matte(null, { map: slats, roughness: 0.6, metalness: 0.2 }));
  inDoor.scale.set(layout.inDoor.w, 1.25, 0.04);
  inDoor.position.set(layout.inDoor.x, 0.625, z0 + 0.02);
  inDoor.receiveShadow = true;
  group.add(inDoor);
  darkParts.push({
    x: layout.inDoor.x,
    y: 1.34,
    z: z0 + 0.07,
    w: layout.inDoor.w + 0.15,
    h: 0.18,
    d: 0.14,
  });
  const pallet = layout.pallet;
  woodParts.push(
    {
      x: (pallet.x0 + pallet.x1) / 2,
      y: 0.03,
      z: (pallet.z0 + pallet.z1) / 2,
      w: pallet.x1 - pallet.x0,
      h: 0.06,
      d: pallet.z1 - pallet.z0,
    },
    {
      x: (pallet.x0 + pallet.x1) / 2,
      y: 0.1,
      z: (pallet.z0 + pallet.z1) / 2,
      w: pallet.x1 - pallet.x0,
      h: 0.03,
      d: pallet.z1 - pallet.z0,
    },
  );
  steelParts.push({
    x: layout.countSign.x,
    y: 0.4,
    z: layout.countSign.z,
    w: 0.04,
    h: 0.8,
    d: 0.04,
  });
  for (const z of [doorBack, doorFront])
    steelParts.push({ x: x1 + 0.06, y: 0.6, z, w: 0.1, h: 1.2, d: 0.1 });
  darkParts.push({ x: x1 + 0.06, y: 1.22, z: door.z, w: 0.16, h: 0.14, d: door.w + 0.12 });
  const drum = new Mesh(kit.own(new CylinderGeometry(0.09, 0.09, door.w, 16)), steel);
  drum.rotation.x = Math.PI / 2;
  drum.position.set(x1 + 0.06, 1.08, door.z);
  group.add(drum);

  add(
    group,
    boxes(kit, unit, steel, steelParts),
    boxes(kit, unit, kit.matte(p.wood), woodParts),
    boxes(kit, unit, kit.matte(p.sign, { roughness: 0.6 }), darkParts),
  );
  return group;
}

/** The y of the merge belt's top, where crates sit. */
export const BELT_TOP = 0.24;
