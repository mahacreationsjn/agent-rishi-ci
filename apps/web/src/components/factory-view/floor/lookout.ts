import {
  type BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Rgb } from "@/lib/oklch";
import { LOOKOUT_WALL_H, type LookoutLayout, POD, SLAB_H, TABLE } from "../scene/lookout";
import { at, colour, type Kit } from "./kit";
import type { FloorPalette } from "./palette";
import { mapCanvas, signAtlas } from "./textures";
import { type BoxSpec, boxes } from "./workshop";

/**
 * The Lookout storey's build (#476): a slab with a back and left wall and glass railings on the
 * open sides, eight pods (a console with its area's name and a lamp, lit while that area's
 * reviewer works this round), the scout's map table and the hopper the filing chute starts
 * from. Built in the storey's own frame (its floor at y = 0); the stage lifts it into place.
 * The chute itself spans both storeys, so it's built apart (`buildChute`).
 */

/** What the Lookout shows, to tell whether it needs rebuilding. */
export function lookoutKey(l: LookoutLayout, lit: ReadonlySet<string>, p: FloorPalette): string {
  return JSON.stringify([l.bounds, l.y, [...lit].sort(), p]);
}

export function buildLookout(
  l: LookoutLayout,
  lit: ReadonlySet<string>,
  p: FloorPalette,
  kit: Kit,
  unit: BoxGeometry,
): Group {
  const group = new Group();
  const { x0, x1, z0, z1 } = l.bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const add = (...meshes: (Mesh | null)[]) => {
    for (const m of meshes) if (m) group.add(m);
  };
  const slab = boxes(kit, unit, kit.matte(p.floor, { roughness: 0.9 }), [
    { x: cx, y: -SLAB_H / 2, z: cz, w, h: SLAB_H, d },
  ]);
  if (slab) slab.receiveShadow = true;
  const steel: BoxSpec[] = [];
  const walls: BoxSpec[] = [
    { x: cx - 0.05, y: LOOKOUT_WALL_H / 2, z: z0 - 0.05, w: w + 0.1, h: LOOKOUT_WALL_H, d: 0.1 },
    { x: x0 - 0.05, y: LOOKOUT_WALL_H / 2, z: cz, w: 0.1, h: LOOKOUT_WALL_H, d },
  ];
  // Glass railings on the open sides, with a steel top rail.
  const railH = 0.32;
  const glass: BoxSpec[] = [
    { x: cx, y: railH / 2, z: z1, w, h: railH, d: 0.02 },
    { x: x1, y: railH / 2, z: cz, w: 0.02, h: railH, d },
  ];
  steel.push(
    { x: cx, y: railH, z: z1, w: w + 0.04, h: 0.03, d: 0.04 },
    { x: x1, y: railH, z: cz, w: 0.04, h: 0.03, d: d + 0.04 },
  );
  // The slab's edge, under the railings, in the lane colour.
  const trim: BoxSpec[] = [
    { x: cx, y: -SLAB_H / 2, z: z1 + 0.01, w: w + 0.02, h: SLAB_H + 0.01, d: 0.02 },
    { x: x1 + 0.01, y: -SLAB_H / 2, z: cz, w: 0.02, h: SLAB_H + 0.01, d: d + 0.02 },
  ];

  // Pods: a console with its label facing the hall, a lamp on a short post.
  const consoles: BoxSpec[] = [];
  const lampsOn: [number, number, number][] = [];
  const lampsOff: [number, number, number][] = [];
  const screens: BoxSpec[] = [];
  const litScreens: BoxSpec[] = [];
  for (const pod of l.pods) {
    const { x, z } = pod.console;
    consoles.push({ x, y: POD.h / 2, z, w: POD.w, h: POD.h, d: POD.d });
    (lit.has(pod.area) ? litScreens : screens).push({
      x,
      y: POD.h + 0.09,
      z: z - 0.05,
      w: 0.36,
      h: 0.18,
      d: 0.02,
    });
    steel.push({
      x: x + POD.w / 2 - 0.08,
      y: POD.h + 0.12,
      z: z + 0.05,
      w: 0.025,
      h: 0.24,
      d: 0.025,
    });
    (lit.has(pod.area) ? lampsOn : lampsOff).push([x + POD.w / 2 - 0.08, POD.h + 0.27, z + 0.05]);
  }
  // Labels: one atlas row per pod, on each console's front.
  const atlas = kit.canvasTexture(
    signAtlas(
      l.pods.map((pod) => pod.label.toUpperCase()),
      p,
      4,
    ),
  );
  const labelRows = l.pods.map((pod, i) => {
    const g = new PlaneGeometry(POD.w - 0.08, (POD.w - 0.08) / 4);
    const uv = g.getAttribute("uv");
    const n = l.pods.length;
    for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (i + 1) / n + uv.getY(k) / n);
    g.applyMatrix4(at(pod.console.x, POD.h * 0.55, pod.console.z + POD.d / 2 + 0.004));
    return g;
  });
  const labels = mergeGeometries(labelRows);
  for (const g of labelRows) g.dispose();
  if (labels) add(new Mesh(kit.own(labels), kit.matte(null, { map: atlas, roughness: 0.6 })));

  const lampGeo = kit.own(new CylinderGeometry(0.065, 0.065, 0.09, 16));
  const lamp = (rgb: Rgb, on: boolean) =>
    kit.own(
      new MeshStandardMaterial({
        color: colour(on ? rgb : ([rgb[0] * 0.35, rgb[1] * 0.35, rgb[2] * 0.35] as Rgb)),
        emissive: colour(rgb),
        emissiveIntensity: on ? 1.8 : 0.02,
        roughness: 0.3,
      }),
    );
  add(
    kit.instanced(
      lampGeo,
      lamp(p.lamp.green, true),
      lampsOn.map((v) => at(...v)),
      undefined,
      {
        cast: false,
      },
    ),
    kit.instanced(
      lampGeo,
      lamp(p.lamp.green, false),
      lampsOff.map((v) => at(...v)),
      undefined,
      {
        cast: false,
      },
    ),
    // A working pod's screen glows.
    boxes(
      kit,
      unit,
      kit.matte(p.glass, { emissive: colour(p.accent.area), emissiveIntensity: 0.9 }),
      litScreens,
    ),
  );

  // The map table: a top with the map, on a steel base.
  const map = new Mesh(
    kit.own(new PlaneGeometry(TABLE.w - 0.08, TABLE.d - 0.08)),
    kit.matte(null, { map: kit.canvasTexture(mapCanvas(p)), roughness: 0.7 }),
  );
  map.rotation.x = -Math.PI / 2;
  map.position.set(l.table.x, TABLE.h + 0.026, l.table.z);
  add(map);
  const woods: BoxSpec[] = [
    { x: l.table.x, y: TABLE.h + 0.01, z: l.table.z, w: TABLE.w, h: 0.03, d: TABLE.d },
  ];
  steel.push({ x: l.table.x, y: TABLE.h / 2, z: l.table.z, w: 0.3, h: TABLE.h, d: 0.3 });

  // The chute's hopper at the left end: a funnel on the slab.
  const hopper = new Mesh(
    kit.own(new ConeGeometry(0.32, 0.36, 20, 1, true)),
    kit.matte(p.steel, { roughness: 0.4, metalness: 0.3, side: 2 }),
  );
  hopper.rotation.x = Math.PI;
  hopper.position.set(l.chute.x, 0.2, l.chute.z);
  add(hopper);

  const glassMat = kit.own(
    new MeshStandardMaterial({
      color: colour(p.glass),
      transparent: true,
      opacity: 0.22,
      roughness: 0.1,
      depthWrite: false,
    }),
  );
  const railings = boxes(kit, unit, glassMat, glass);
  if (railings) {
    railings.castShadow = false;
    railings.renderOrder = 2;
  }
  add(
    slab,
    boxes(kit, unit, kit.matte(p.wall, { roughness: 0.95 }), walls),
    boxes(kit, unit, kit.matte(p.steel, { roughness: 0.5, metalness: 0.3 }), steel),
    boxes(kit, unit, kit.matte(p.sign, { roughness: 0.6 }), consoles),
    boxes(kit, unit, kit.matte(p.laptop, { roughness: 0.4 }), screens),
    boxes(kit, unit, kit.matte(p.wood), woods),
    boxes(kit, unit, kit.matte(p.lane, { roughness: 0.6 }), trim),
    railings,
  );
  return group;
}

/** The glass filing chute from the Lookout's hopper down to intake's pallet (world frame). */
export function buildChute(l: LookoutLayout, p: FloorPalette, kit: Kit): Group {
  const group = new Group();
  const h = l.chute.top - l.chute.bottom;
  const tube = new Mesh(
    kit.own(new CylinderGeometry(0.16, 0.16, h, 24, 1, true)),
    kit.own(
      new MeshStandardMaterial({
        color: colour(p.glass),
        transparent: true,
        opacity: 0.28,
        roughness: 0.05,
        depthWrite: false,
        side: 2,
      }),
    ),
  );
  tube.position.set(l.chute.x, l.chute.bottom + h / 2, l.chute.z);
  tube.renderOrder = 2;
  group.add(tube);
  const ringGeo = kit.own(new CylinderGeometry(0.18, 0.18, 0.04, 24));
  const rings = kit.instanced(
    ringGeo,
    kit.matte(p.steel, { roughness: 0.4, metalness: 0.3 }),
    [0, 0.33, 0.66, 1].map((k) =>
      new Matrix4().makeTranslation(l.chute.x, l.chute.bottom + 0.02 + k * (h - 0.04), l.chute.z),
    ),
    undefined,
    { cast: false },
  );
  if (rings) group.add(rings);
  return group;
}
