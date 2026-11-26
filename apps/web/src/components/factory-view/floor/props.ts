import {
  type BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from "three";
import type { Rgb } from "@/lib/oklch";
import type { WorkshopLayout } from "../scene/layout";
import type { BayCrate } from "../scene/repair-bay";
import type { Scene } from "../scene/scene-model";
import { buildDeskProps } from "./desk-meshes";
import { type SeatUse, seatKey } from "./desk-props";
import { colour, type Kit } from "./kit";
import type { FloorPalette } from "./palette";
import { boardCanvas, closedCanvas, dialCanvas, displayCanvas } from "./textures";
import { BELT_TOP, type BoxSpec, boxes } from "./workshop";

/**
 * Floor mode's live props (#420): what follows the factory's state rather than the layout. The
 * tickets on intake's pallet (at most 8 drawn) and the sign with the full count, the signal
 * tower (pink while CI runs), a crate on the belt for each agent merging, the status board over
 * the dock door (merges today, agents working, items waiting on you), the repair bay's crates
 * (at most 3, by kind), the budget dial (hidden without a budget) and, on each occupied desk, the
 * prop for its agent's step (`desk-props.ts`). Rebuilt when any of it changes.
 */

/** What the props show, to tell whether they need rebuilding. */
export function propsKey(
  scene: Scene,
  layout: WorkshopLayout,
  p: FloorPalette,
  occupied: ReadonlyMap<string, SeatUse>,
): string {
  return JSON.stringify([
    scene.tickets.ids.length,
    scene.tickets.items.length,
    scene.ciRunning,
    scene.shipped,
    scene.board,
    scene.gauge === null ? null : Math.round(scene.gauge * 100),
    scene.bay.map((c) => [c.kind, c.entries.length]),
    scene.draining !== null,
    [...occupied],
    layout.bounds,
    p,
  ]);
}

/** A sign facing the camera: a plane with a canvas, turned 45° toward the viewer. */
function display(
  kit: Kit,
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  turn = Math.PI / 4,
) {
  const mesh = new Mesh(
    kit.own(new PlaneGeometry(w, h)),
    kit.own(
      new MeshStandardMaterial({
        map: kit.canvasTexture(canvas),
        roughness: 0.5,
        emissive: 0xffffff,
        emissiveIntensity: 0.12,
      }),
    ),
  );
  const material = mesh.material as MeshStandardMaterial;
  material.emissiveMap = material.map;
  mesh.position.set(x, y, z);
  mesh.rotation.y = turn;
  return mesh;
}

const CRATE_SIZE = 0.3;
/** A repair bay crate's size. */
export const BAY_CRATE = { w: 0.42, h: 0.34, d: 0.42 };

/** Where the repair bay's crates stand (at most three), in the bay's order. */
export function bayCrateSpots(layout: WorkshopLayout, n: number): { x: number; z: number }[] {
  const bay = layout.bay;
  return Array.from({ length: Math.min(3, n) }, (_, i) => ({
    x: bay.x0 + 0.55 + i * 0.7,
    z: bay.z0 + 0.75 + (i % 2) * 0.35,
  }));
}

export function buildProps(
  scene: Scene,
  layout: WorkshopLayout,
  p: FloorPalette,
  kit: Kit,
  unit: BoxGeometry,
  occupied: ReadonlyMap<string, SeatUse>,
): Group {
  const group = new Group();
  const add = (...meshes: (Mesh | null)[]) => {
    for (const m of meshes) if (m) group.add(m);
  };

  // Tickets on the pallet: two piles, at most 8 sheets.
  const pallet = layout.pallet;
  const tickets: BoxSpec[] = scene.tickets.items.map((t) => {
    const pile = t.slot % 2;
    const level = Math.floor(t.slot / 2);
    return {
      x: pallet.x0 + 0.45 + pile * 0.7,
      y: 0.13 + level * 0.035,
      z: (pallet.z0 + pallet.z1) / 2 + (t.slot % 3) * 0.03 - 0.03,
      w: 0.5,
      h: 0.03,
      d: 0.36,
      turn: ((t.slot * 37) % 11) * 0.02 - 0.1,
    };
  });
  add(boxes(kit, unit, kit.matte(p.paper, { roughness: 0.9 }), tickets));
  add(
    display(
      kit,
      displayCanvas(String(scene.tickets.ids.length), "IN INTAKE", p),
      0.56,
      0.28,
      layout.countSign.x,
      0.9,
      layout.countSign.z,
    ),
  );

  // The signal tower: red over pink over green, pink lit while CI runs.
  const tower = layout.signalTower;
  const lampGeo = kit.own(new CylinderGeometry(0.06, 0.06, 0.1, 20));
  const lamps: [Rgb, boolean][] = [
    [p.lamp.green, false],
    [p.lamp.caution, scene.ciRunning],
    [p.lamp.red, false],
  ];
  lamps.forEach(([rgb, lit], i) => {
    const m = new MeshStandardMaterial({
      color: colour(lit ? rgb : ([rgb[0] * 0.45, rgb[1] * 0.45, rgb[2] * 0.45] as Rgb)),
      emissive: colour(rgb),
      emissiveIntensity: lit ? 1.6 : 0.04,
      roughness: 0.3,
    });
    const lamp = new Mesh(lampGeo, kit.own(m));
    lamp.position.set(tower.x, 1.03 + i * 0.105, tower.z);
    group.add(lamp);
  });
  const cap = new Mesh(lampGeo, kit.matte(p.sign));
  cap.scale.set(1.05, 0.3, 1.05);
  cap.position.set(tower.x, 1.03 + 3 * 0.105 - 0.035, tower.z);
  group.add(cap);

  // A crate on the belt in front of each agent merging.
  const crates: BoxSpec[] = [];
  for (const seat of layout.seats.merge) {
    if (!seat.desk || !occupied.has(seatKey(seat))) continue;
    crates.push({
      x: seat.desk.x,
      y: BELT_TOP + CRATE_SIZE / 2,
      z: seat.desk.z,
      w: CRATE_SIZE,
      h: CRATE_SIZE * 0.8,
      d: CRATE_SIZE,
    });
  }
  add(boxes(kit, unit, kit.matte(p.wood), crates));

  // The status board over the dock door: today's merges, agents working, items waiting on you.
  const door = layout.shipDoor;
  add(
    display(
      kit,
      boardCanvas(scene.shipped, scene.board.working, scene.board.waiting, p),
      1.8,
      0.55,
      layout.bounds.x1 + 0.15,
      1.62,
      door.z + 0.2,
    ),
  );

  // The repair bay's crates, one per kind, with their counts.
  const spots = bayCrateSpots(layout, scene.bay.length);
  scene.bay.slice(0, 3).forEach((crate: BayCrate, i) => {
    const { x, z } = spots[i] as { x: number; z: number };
    const box = new Mesh(unit, kit.matte(p.crate[crate.kind], { roughness: 0.7 }));
    box.scale.set(BAY_CRATE.w, BAY_CRATE.h, BAY_CRATE.d);
    box.position.set(x, BAY_CRATE.h / 2, z);
    box.castShadow = true;
    group.add(box);
    group.add(
      display(
        kit,
        displayCanvas(String(crate.entries.length), crate.title.toUpperCase(), p),
        0.36,
        0.18,
        x,
        0.17,
        z + 0.212,
        0,
      ),
    );
  });

  // Draining: a CLOSED sign hangs on intake's roll-up door until the factory resumes.
  if (scene.draining !== null)
    group.add(
      display(kit, closedCanvas(p), 0.9, 0.3, layout.inDoor.x, 0.75, layout.bounds.z0 + 0.06, 0),
    );

  // The budget dial on the back wall in its dark ring, when there is a budget.
  if (scene.gauge !== null) {
    const ring = new Mesh(kit.own(new CircleGeometry(0.27, 32)), kit.matte(p.sign));
    ring.position.set(layout.budgetDial.x, 0.78, layout.bounds.z0 + 0.008);
    group.add(ring);
    const dial = new Mesh(
      kit.own(new CircleGeometry(0.24, 40)),
      kit.matte(null, { map: kit.canvasTexture(dialCanvas(scene.gauge, p)) }),
    );
    dial.position.set(layout.budgetDial.x, 0.78, layout.bounds.z0 + 0.012);
    group.add(dial);
  }

  // Each occupied desk's prop for its agent's step (the laptops are part of the hall).
  group.add(buildDeskProps(layout, p, kit, unit, occupied));
  return group;
}
