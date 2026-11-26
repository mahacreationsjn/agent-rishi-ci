import type { FactoryStatus } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { FloorMotion, STEP_S } from "@/components/factory-view/floor/motion";
import { cellAt, seatAt, workshopLayout } from "@/components/factory-view/scene/layout";
import { type Scene, sceneOf } from "@/components/factory-view/scene/scene-model";
import { sceneEvents } from "@/components/factory-view/scene/transitions";
import { cellId } from "@/components/factory-view/scene/walk";
import type { SessionInfo } from "@/components/factory-view/stages";
import { inputs, minutesAgo, prRef, running, status, w } from "./scene-fixtures";

/**
 * Issue #476: Floor mode acts out the pipeline's moments in 3D once per real change: a figure
 * walks to its new seat over the walk grid, a builder carries its crate to the reviewer and
 * walks back, a merge's crate rides out of the dock door, and the first scene plays nothing.
 */

const layout = workshopLayout(4, {}, null);
const sessions = new Map<string, SessionInfo>([["s4", running("Wiring the button", 1)]]);
const build = w("build", 4, {
  stage: "building",
  step: "implement",
  sessionId: "s4",
  activeSessionId: "s4",
});

function sceneFor(patch: Partial<FactoryStatus>, prev: Scene | null = null): Scene {
  const f = status({ mode: "software_factory", scout: null, ...patch });
  return sceneOf(inputs(f, sessions), prev?.seating ?? null, () => layout.stations);
}

/** Every frame from `t0` to `t1`, a step at a time. */
function run(m: FloorMotion, scene: Scene, t0: number, t1: number) {
  const all = [];
  for (let t = t0; t <= t1; t += STEP_S / 3) all.push(m.frames(scene, layout, t));
  return all;
}

describe("Floor mode's motion (#476)", () => {
  it("plays nothing on the first scene: everyone stands at their seat", () => {
    const first = sceneFor({ inProgress: [build] });
    const m = new FloorMotion();
    m.play(first, layout, sceneEvents(null, first), 0);
    expect(m.busy(0)).toBe(false);
    const frames = m.frames(first, layout, 0.5);
    const builder = frames.find((f) => f.key === "item:build:builder");
    const seat = seatAt(layout, "bench", layout.stations.bench.seats[0] as never);
    expect(builder).toMatchObject({ x: seat?.stand.x, z: seat?.stand.z, stride: null });
  });

  it("walks a builder in from the pallet with its ticket, cell by cell, to its seat", () => {
    const queued = w("build", 4, { stage: "backlog", step: "queued", type: "feature" });
    const before = sceneFor({ backlog: [queued] });
    const after = sceneFor({ inProgress: [build] }, before);
    const m = new FloorMotion();
    m.play(after, layout, sceneEvents(before, after), 10);
    expect(m.busy(10)).toBe(true);
    const frames = run(m, after, 10, 30).map((list) =>
      list.find((f) => f.key === "item:build:builder"),
    );
    const start = frames[0];
    expect(start?.carry).toBe("ticket");
    expect(start?.stride).not.toBeNull();
    // It starts by the pallet and ends at its bench, never jumping more than a cell a frame.
    expect(start?.z).toBeGreaterThan(layout.pallet.z1);
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1];
      const b = frames[i];
      if (a && b) expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(layout.walk.cell * 1.5);
    }
    const end = frames.at(-1);
    const seat = seatAt(layout, "bench", layout.stations.bench.seats[0] as never);
    expect(end).toMatchObject({ x: seat?.stand.x, z: seat?.stand.z, stride: null, carry: null });
    expect(m.busy(30)).toBe(false);
  });

  it("has the builder carry its crate to the reviewer as a ghost, walk back and leave", () => {
    // Its bench is in the middle of a full row: it walks out behind its neighbours.
    const row = [1, 2, 3].map((i) =>
      w(`n${i}`, 40 + i, { stage: "building", step: "implement", sessionId: `n${i}` }),
    );
    const before = sceneFor({
      inProgress: [row[0], build, row[1], row[2]].filter(Boolean) as never,
    });
    const reviewing = w("build", 4, {
      stage: "verifying",
      step: "review",
      pr: prRef(30),
      sessionId: "s4",
      reviewerSessionId: "r4",
    });
    const after = sceneFor({ inProgress: [...row, reviewing] }, before);
    const m = new FloorMotion();
    m.play(after, layout, sceneEvents(before, after), 0);
    const frames = run(m, after, 0, 60);
    const ghosts = frames.map((list) => list.find((f) => f.ghost));
    expect(ghosts[0]?.carry).toBe("crate");
    expect(ghosts.some((g) => g && g.carry === null)).toBe(true);
    // It walks all the way, a cell at a time, to the reviewer's desk and back: no jumps.
    const seen = ghosts.filter((g) => g !== undefined);
    for (let i = 1; i < seen.length; i++) {
      const a = seen[i - 1];
      const b = seen[i];
      if (a && b) expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(layout.walk.cell * 1.5);
    }
    const reviewer = after.seating.seats.get("item:build:reviewer");
    const desk = reviewer ? seatAt(layout, reviewer.station, reviewer.tile)?.desk : null;
    const nearest = Math.min(
      ...seen.map((g) => (desk ? Math.hypot(g.x - desk.x, g.z - desk.z) : 99)),
    );
    expect(nearest).toBeLessThan(0.8);
    // Gone once it walked back to its bench.
    expect(ghosts.at(-1)).toBeUndefined();
    // Nobody ever shares a cell with another walker.
    for (const list of frames) {
      const walking = list.filter((f) => f.stride !== null);
      const cells = walking.map((f) => cellId(layout.walk, cellAt(layout.walk, f)));
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it("ships a merged crate out of the dock door, counting it once it has left", () => {
    const merging = w("first", 9, { stage: "verifying", step: "merge", pr: prRef(19) });
    const before = sceneFor({
      inProgress: [merging],
      pullRequests: [
        {
          itemId: "first",
          title: "PR",
          pr: prRef(19),
          state: "queued",
          queuePosition: 1,
          note: null,
        },
      ],
    });
    const merged = w("first", 9, { stage: "merged", step: "done", mergedAt: minutesAgo(0) });
    const after = sceneFor({ recent: [merged], mergesToday: 3 }, before);
    const m = new FloorMotion();
    m.play(after, layout, sceneEvents(before, after), 0);
    expect(m.shipsInFlight(0.1)).toBe(1);
    const crate = m.crates(0.1)[0];
    expect(crate?.x).toBeLessThan(layout.bounds.x1);
    expect(m.shipsInFlight(30)).toBe(0);
    expect(m.crates(30)).toEqual([]);
  });

  it("clears every walk when reset (reduced motion, a stopped factory)", () => {
    const queued = w("build", 4, { stage: "backlog", step: "queued", type: "feature" });
    const before = sceneFor({ backlog: [queued] });
    const after = sceneFor({ inProgress: [build] }, before);
    const m = new FloorMotion();
    m.play(after, layout, sceneEvents(before, after), 0);
    m.reset();
    expect(m.busy(0)).toBe(false);
    expect(m.frames(after, layout, 0.1).every((f) => f.stride === null)).toBe(true);
  });
});
