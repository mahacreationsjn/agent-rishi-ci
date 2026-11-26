import { Box3, Ray, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { CameraRig } from "@/components/factory-view/floor/camera";
import { seatFrames } from "@/components/factory-view/floor/seat-frames";
import { asideUnder, StoreyRig } from "@/components/factory-view/floor/storey-rig";
import type { SceneAgent } from "@/components/factory-view/scene/agents";
import { WALL_H, workshopLayout } from "@/components/factory-view/scene/layout";
import {
  AREAS,
  GAP_PER_DEPTH,
  LOOKOUT_WALL_H,
  lookoutLayout,
  POD_LABEL,
  SLAB_H,
} from "@/components/factory-view/scene/lookout";
import { sceneOf } from "@/components/factory-view/scene/scene-model";
import { storeyFocus, storeyOf, storeyTabs } from "@/components/factory-view/scene/storeys";
import { inputs, scoutStatus, status } from "./scene-fixtures";

/**
 * Issue #476: a dark factory's Lookout storey hovers over the back of the Workshop with eight
 * labelled pods and the scout's map table; from the camera neither storey covers the other's
 * interior; the storey tabs count each storey's agents and flag anyone waiting on a person.
 */

const agent = (key: string, patch: Partial<SceneAgent>): SceneAgent => ({
  key,
  role: "builder",
  sessionId: null,
  card: null,
  step: null,
  activity: null,
  status: "working",
  blockedOn: null,
  failed: false,
  provider: null,
  providerId: null,
  model: null,
  progress: null,
  since: null,
  seed: key,
  area: null,
  ...patch,
});

/** Whether a point is hidden from the camera behind a box (a ray toward the camera meets it). */
function hiddenBehind(p: Vector3, back: Vector3, box: Box3): boolean {
  return new Ray(p.clone().addScaledVector(back, 0.01), back).intersectsBox(box);
}

describe("the Lookout storey (#476)", () => {
  it("has a pod for each of the eight review areas, labelled, in a row inside the storey", () => {
    const l = lookoutLayout(workshopLayout(4, {}, null));
    expect(l.pods.map((p) => p.area)).toEqual(AREAS);
    expect(l.pods.map((p) => p.label)).toEqual([
      "Features",
      "UX",
      "Performance",
      "Tech debt",
      "Test gaps",
      "Security",
      "Bugs",
      "Docs",
    ]);
    expect(Object.keys(POD_LABEL)).toHaveLength(8);
    for (const p of [...l.pods.map((x) => x.stand), l.scout, l.table]) {
      expect(p.x).toBeGreaterThan(l.bounds.x0);
      expect(p.x).toBeLessThan(l.bounds.x1);
      expect(p.z).toBeGreaterThan(l.bounds.z0);
      expect(p.z).toBeLessThan(l.bounds.z1);
    }
  });

  it("hovers about 0.6× the Workshop's depth above its walls, its chute down to the pallet", () => {
    for (const n of [1, 4, 12]) {
      const w = workshopLayout(n, {}, null);
      const l = lookoutLayout(w);
      const depth = w.bounds.z1 - w.bounds.z0;
      expect(l.y - WALL_H).toBeCloseTo(GAP_PER_DEPTH * depth);
      expect(l.chute.top).toBe(l.y);
      expect(l.chute.x).toBeGreaterThan(w.pallet.x0);
      expect(l.chute.x).toBeLessThan(w.pallet.x1);
      // The chute starts inside the Lookout, clear of the pods.
      expect(l.chute.x).toBeGreaterThan(l.bounds.x0);
      expect(l.chute.x).toBeLessThan(Math.min(...l.pods.map((p) => p.console.x)) - 0.5);
    }
  });

  it("keeps both interiors in view from the 30° camera: neither storey covers the other's floor", () => {
    for (const [n, demand] of [
      [1, {}],
      [4, {}],
      [8, { bench: 20, review: 12 }],
    ] as const) {
      const w = workshopLayout(n, demand, null);
      const l = lookoutLayout(w);
      const rig = new CameraRig();
      rig.setViewport(1200, 700);
      rig.setScene(w.bounds, WALL_H);
      rig.fit(false);
      const back = rig.camera.getWorldDirection(new Vector3()).negate();
      const lookoutBox = new Box3(
        new Vector3(l.bounds.x0, l.y - SLAB_H, l.bounds.z0),
        new Vector3(l.bounds.x1, l.y + LOOKOUT_WALL_H, l.bounds.z1),
      );
      const workshopBox = new Box3(
        new Vector3(w.bounds.x0, 0, w.bounds.z0),
        new Vector3(w.bounds.x1, WALL_H, w.bounds.z1),
      );
      // The Workshop's floor, everywhere: the Lookout never hides it.
      for (let x = w.bounds.x0 + 0.1; x < w.bounds.x1; x += 0.5)
        for (let z = w.bounds.z0 + 0.1; z < w.bounds.z1; z += 0.5)
          expect(hiddenBehind(new Vector3(x, 0, z), back, lookoutBox)).toBe(false);
      // The Lookout's floor: the Workshop below never hides it.
      for (let x = l.bounds.x0 + 0.1; x < l.bounds.x1; x += 0.5)
        for (let z = l.bounds.z0 + 0.1; z < l.bounds.z1; z += 0.5)
          expect(hiddenBehind(new Vector3(x, l.y + 0.01, z), back, workshopBox)).toBe(false);
    }
  });

  it("puts the scout at its map table and every area reviewer of the round at its pod", () => {
    const f = status({
      scout: {
        ...scoutStatus,
        lenses: AREAS.map((area, i) => ({
          area,
          sessionId: `l${i}`,
          reported: false,
          active: i % 2 === 0,
        })),
      },
    });
    const w = workshopLayout(4, {}, null);
    const l = lookoutLayout(w);
    const scene = sceneOf(inputs(f), null, () => w.stations);
    const frames = seatFrames(scene, w, l);
    const scout = frames.find((x) => x.agent.role === "scout");
    expect(scout).toMatchObject({ x: l.scout.x, y: l.y, z: l.scout.z });
    const areas = frames.filter((x) => x.agent.role === "area");
    expect(areas).toHaveLength(8);
    for (const a of areas) {
      const pod = l.pods.find((p) => p.area === a.agent.area);
      expect(a).toMatchObject({ x: pod?.stand.x, y: l.y, z: pod?.stand.z });
    }
    // A software factory has no Lookout: nobody stands up there.
    expect(seatFrames(scene, w, null).some((x) => storeyOf(x.agent) === "lookout")).toBe(false);
  });
});

describe("storey tabs and focus (#476)", () => {
  const crew = [
    agent("a", {}),
    agent("b", { status: "approval" }),
    agent("pm", { role: "pm", status: "idle" }),
    agent("scout", { role: "scout" }),
    agent("area:ux", { role: "area", area: "ux" }),
  ];

  it("counts each storey's agents and flags anyone waiting on a person", () => {
    expect(storeyTabs(crew, true)).toEqual([
      { id: "workshop", label: "Workshop", count: 3, waiting: true },
      { id: "lookout", label: "Lookout", count: 2, waiting: false },
      { id: "both", label: "Both", count: 5, waiting: true },
    ]);
    const blocked = [
      ...crew,
      agent("area:bugs", { role: "area", status: "blocked", blockedOn: "person" }),
    ];
    expect(storeyTabs(blocked, true).find((t) => t.id === "lookout")?.waiting).toBe(true);
  });

  it("has no tabs in a software factory, and no Both where one storey shows at a time", () => {
    expect(storeyTabs(crew, false)).toEqual([]);
    expect(storeyTabs(crew, true, true).map((t) => t.id)).toEqual(["workshop", "lookout"]);
  });

  it("shows both storeys by default in a dark factory, the Workshop alone otherwise", () => {
    expect(storeyFocus(null, true)).toBe("both");
    expect(storeyFocus("lookout", true)).toBe("lookout");
    expect(storeyFocus(null, false)).toBe("workshop");
    expect(storeyFocus("lookout", false)).toBe("workshop");
    expect(storeyFocus(null, true, true)).toBe("workshop");
    expect(storeyFocus("both", true, true)).toBe("workshop");
  });

  it("slides the other storey aside over half a second, or at once with reduced motion", () => {
    expect(asideUnder("workshop", "lookout")).toBe(true);
    expect(asideUnder("both", "lookout")).toBe(false);
    const rig = new StoreyRig();
    rig.set("workshop", 10, false);
    expect(rig.moving(10.2)).toBe(true);
    const mid = rig.pose(10.25);
    expect(mid.lookout.offset.y).toBeGreaterThan(0);
    expect(mid.lookout.crew).toBe(false);
    const done = rig.pose(10.6);
    expect(rig.moving(10.6)).toBe(false);
    expect(done.lookout.light).toBeLessThan(1);
    expect(done.workshop).toMatchObject({ light: 1, crew: true, offset: { x: 0, y: 0, z: 0 } });
    const cut = new StoreyRig();
    cut.set("lookout", 10, true);
    expect(cut.moving(10)).toBe(false);
    expect(cut.pose(10).workshop.offset.y).toBeLessThan(0);
  });
});
