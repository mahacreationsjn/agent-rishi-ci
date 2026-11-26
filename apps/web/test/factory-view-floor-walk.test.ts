import { describe, expect, it } from "vitest";
import {
  cellAt,
  cellCentre,
  floorSeats,
  type LayoutSeat,
  WALKWAY,
  type WalkGrid,
  workshopLayout,
} from "@/components/factory-view/scene/layout";
import type { Tile } from "@/components/factory-view/scene/stations";
import {
  arrived,
  cellId,
  findPath,
  GIVE_UP_AFTER,
  nearestFree,
  startWalker,
  stepWalkers,
  type Walker,
  walkable,
  walkerTile,
} from "@/components/factory-view/scene/walk";

/**
 * Issues #264 and #476: walkers cross Floor mode's Workshop on the layout's walk grid, around
 * desks and conveyors, and nobody shares a cell or walks through anyone.
 */

const layout = workshopLayout(4, {}, null);
const grid: WalkGrid = layout.walk;
const id = (t: Tile) => cellId(grid, t);
const seatsOf = (station: LayoutSeat["station"]) => layout.seats[station];
const cellOf = (seat: LayoutSeat) => cellAt(grid, seat.stand);

/** Steps walkers until all arrive (or a limit), checking every step that no two share a cell. */
function walkAll(walkers: Walker[], occupied: Set<number>, limit = 600) {
  let now = walkers;
  for (let i = 0; i < limit && !now.every(arrived); i++) {
    const before = new Map(now.map((x) => [x.key, id(walkerTile(x))]));
    now = stepWalkers(grid, now, occupied);
    const cells = now.map((x) => id(walkerTile(x)));
    expect(new Set(cells).size).toBe(cells.length);
    for (const t of cells) expect(occupied.has(t)).toBe(false);
    // Nobody swaps places with another walker in one step.
    for (const x of now)
      for (const y of now)
        if (x.key !== y.key && before.get(x.key) === id(walkerTile(y)))
          expect(before.get(y.key)).not.toBe(id(walkerTile(x)));
  }
  return now;
}

describe("the Workshop's walk grid (#476)", () => {
  it("blocks every desk and conveyor, and the walls", () => {
    for (const seat of floorSeats(layout)) {
      if (!seat.desk || seat.station === "pm") continue;
      expect(walkable(grid, cellAt(grid, seat.desk))).toBe(false);
    }
    // Behind the back wall and past the right one there is nowhere to go.
    expect(walkable(grid, { c: 0, r: grid.rows - 1 })).toBe(false);
    expect(walkable(grid, { c: grid.cols, r: 0 })).toBe(false);
  });

  it("leaves every seat's place free and reachable from every other", () => {
    const seats = floorSeats(layout).filter((s) => s.station !== "pm");
    const from = cellOf(seatsOf("prep")[0] as LayoutSeat);
    for (const seat of seats) {
      expect(walkable(grid, cellOf(seat))).toBe(true);
      expect(findPath(grid, from, cellOf(seat), new Set())).not.toBeNull();
    }
    // The repair bay's inside is reached through its gap.
    const inBay = cellAt(grid, { x: layout.bay.x0 + 0.8, z: layout.bay.z1 - 0.4 });
    expect(findPath(grid, from, inBay, new Set())).not.toBeNull();
  });

  it("puts a cell's centre inside it", () => {
    const t = { c: 7, r: 3 };
    expect(cellAt(grid, cellCentre(grid, t))).toEqual(t);
    // Rows line up with the desks: the first desk row's front edge is a cell boundary.
    expect((WALKWAY / grid.cell) % 1).toBeCloseTo(0);
  });

  it("finds the nearest free cell around a taken one", () => {
    const seat = cellOf(seatsOf("bench")[0] as LayoutSeat);
    const free = nearestFree(grid, seat, new Set([id(seat)]));
    expect(free).not.toBeNull();
    expect(free && Math.abs(free.c - seat.c) + Math.abs(free.r - seat.r)).toBe(1);
  });
});

describe("walking (#264, #476)", () => {
  it("finds a path around desks and the conveyor, one cell at a time", () => {
    const from = cellOf(seatsOf("bench")[0] as LayoutSeat);
    const to = cellOf(seatsOf("ship")[0] as LayoutSeat);
    const path = findPath(grid, from, to, new Set()) ?? [];
    expect(path[0]).toEqual(from);
    expect(path.at(-1)).toEqual(to);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as Tile;
      const b = path[i] as Tile;
      expect(Math.abs(a.c - b.c) + Math.abs(a.r - b.r)).toBe(1);
      expect(walkable(grid, b)).toBe(true);
    }
  });

  it("waits rather than walk into a standing agent, and goes around it", () => {
    // Along the front walkway, with someone standing in the middle of it.
    const from = { c: 8, r: 0 };
    const to = { c: 20, r: 0 };
    const standing = new Set([id({ c: 12, r: 0 })]);
    const walker = { key: "a", path: findPath(grid, from, to, new Set()) ?? [], at: 0, waited: 0 };
    const [done] = walkAll([walker], standing);
    expect(done && walkerTile(done)).toEqual(to);
  });

  it("lets two walkers meet head-on without sharing a cell or swapping through each other", () => {
    const a = { c: 6, r: 0 };
    const b = { c: 30, r: 0 };
    const walkers = [
      startWalker(grid, "a", a, b, new Set()),
      startWalker(grid, "b", b, a, new Set()),
    ];
    const done = walkAll(walkers, new Set());
    expect(done.map(walkerTile)).toEqual([b, a]);
  });

  it("keeps a crowd of walkers apart on their way across the floor", () => {
    const from = [...seatsOf("prep"), ...seatsOf("bench"), ...seatsOf("review")].map(cellOf);
    const goals = [...seatsOf("merge"), ...seatsOf("ship"), ...seatsOf("review")].map(cellOf);
    const walkers = from
      .slice(0, goals.length)
      .map((f, i) => startWalker(grid, `w${i}`, f, goals[i] as Tile, new Set()));
    const done = walkAll(walkers, new Set(), 900);
    expect(done.every(arrived)).toBe(true);
    // Nobody waited long enough to give up and be put on its seat.
    expect(Math.max(...done.map((x) => x.waited))).toBeLessThan(GIVE_UP_AFTER);
  });
});
