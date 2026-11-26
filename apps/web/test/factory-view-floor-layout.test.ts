import { describe, expect, it } from "vitest";
import {
  floorSeats,
  furniture,
  ROW_SEATS,
  startingSeats,
  type WorkshopLayout,
  workshopLayout,
} from "@/components/factory-view/scene/layout";
import { stationDemand } from "@/components/factory-view/scene/scene-model";
import {
  assignSeats,
  type Seating,
  type SeatRequest,
} from "@/components/factory-view/scene/seating";
import type { StationId } from "@/components/factory-view/scene/stations";

/**
 * Issue #420: Floor mode's Workshop is laid out from the agent limit, gives every agent a seat
 * (never "+N"), grows without moving anyone and never shrinks while the view is open.
 */

const STATIONS: StationId[] = ["prep", "bench", "review", "merge", "ship", "pm", "scout", "area"];
const ask = (key: string, station: StationId): SeatRequest => ({ key, station });
const crowd = (n: number, station: StationId) =>
  Array.from({ length: n }, (_, i) => ask(`${station}-${i}`, station));

/** Where every seat of a layout is, by station and index. */
function positions(layout: WorkshopLayout): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of STATIONS)
    layout.seats[s].forEach((seat, i) => {
      out.set(`${s}:${i}`, `${seat.stand.x.toFixed(3)},${seat.stand.z.toFixed(3)},${seat.floorY}`);
    });
  return out;
}

/** Seats as Floor mode does: the layout grows for the demand, then seating reads it. */
function seatOnFloor(
  n: number,
  agents: SeatRequest[],
  prev: { layout: WorkshopLayout; seating: Seating } | null,
) {
  const layout = workshopLayout(n, stationDemand(agents), prev?.layout ?? null);
  const seating = assignSeats(prev?.seating ?? null, agents, layout.stations);
  return { layout, seating };
}

describe("Floor mode's Workshop layout (#420)", () => {
  it("starts with seats from the agent limit, for every limit from 1 to 32", () => {
    for (let n = 1; n <= 32; n++) {
      const layout = workshopLayout(n, {}, null);
      const half = Math.ceil(n / 2);
      const count = (s: StationId) => layout.seats[s].length;
      expect([
        count("prep"),
        count("bench"),
        count("review"),
        count("merge"),
        count("ship"),
      ]).toEqual([half, n, n, n, half]);
      expect(count("pm")).toBe(1);
      expect(startingSeats(n).bench).toBe(n);
    }
  });

  it("puts every seat in its own place, within the hall and clear of each other's desks", () => {
    for (let n = 1; n <= 32; n++) {
      const layout = workshopLayout(n, {}, null);
      const seats = floorSeats(layout);
      const spots = seats.map((s) => `${s.stand.x.toFixed(3)},${s.stand.z.toFixed(3)}`);
      expect(new Set(spots).size).toBe(spots.length);
      const tiles = STATIONS.flatMap((s) => layout.seats[s]).map((s) => `${s.tile.c},${s.tile.r}`);
      expect(new Set(tiles).size).toBe(tiles.length);
      const { bounds } = layout;
      const boxes = furniture(layout);
      for (const seat of seats) {
        expect(seat.stand.x).toBeGreaterThan(bounds.x0);
        expect(seat.stand.x).toBeLessThan(bounds.x1);
        expect(seat.stand.z).toBeGreaterThan(bounds.z0);
        expect(seat.stand.z).toBeLessThan(bounds.z1);
        // Nobody stands inside furniture (the booth's PM stands on its platform).
        const inside = boxes.filter(
          (b) =>
            b !== layout.booth &&
            seat.stand.x > b.x0 &&
            seat.stand.x < b.x1 &&
            seat.stand.z > b.z0 &&
            seat.stand.z < b.z1,
        );
        expect(inside).toEqual([]);
      }
    }
  });

  it("lays the zones out in the board's order along +x, at most four seats to a row", () => {
    const layout = workshopLayout(10, {}, null);
    expect(layout.zones.map((z) => z.label)).toEqual([
      "INTAKE",
      "PREP",
      "BUILD",
      "REVIEW",
      "MERGE",
      "SHIP",
    ]);
    const xs = layout.zones.map((z) => z.x0);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    for (const z of layout.zones) expect(z.cols).toBeLessThanOrEqual(ROW_SEATS);
    // Ten builders: three rows going back, 1.2 apart.
    const rows = [...new Set(layout.seats.bench.map((s) => s.stand.z))];
    expect(rows).toHaveLength(3);
    expect((rows[0] as number) - (rows[1] as number)).toBeCloseTo(1.2);
    // The PM's booth is past Ship, against the back wall, on its platform.
    const ship = layout.zones.at(-1) as (typeof layout.zones)[number];
    expect(layout.booth.x0).toBeGreaterThan(ship.x1);
    expect(layout.booth.z0).toBe(layout.bounds.z0);
    expect(layout.seats.pm[0]?.floorY).toBeGreaterThan(0);
  });

  it("grows a station by whole rows when more agents want it, without moving any seat", () => {
    const first = workshopLayout(2, {}, null);
    const grown = workshopLayout(2, { bench: 7, review: 3 }, first);
    expect(grown.seats.bench.length).toBeGreaterThanOrEqual(7);
    expect(grown.seats.review.length).toBeGreaterThanOrEqual(3);
    for (const [key, at] of positions(first)) expect(positions(grown).get(key)).toBe(at);
    // The hall only deepens.
    expect(grown.bounds.z0).toBeLessThanOrEqual(first.bounds.z0);
    expect(grown.bounds.x1).toBe(first.bounds.x1);
  });

  it("never shrinks while the view stays open, even when the agent limit drops", () => {
    const big = workshopLayout(2, { bench: 9 }, null);
    const after = workshopLayout(1, { bench: 1 }, big);
    expect(after.seats.bench.length).toBe(big.seats.bench.length);
    expect(after.seats.prep.length).toBe(big.seats.prep.length);
    expect(after.bounds).toEqual(big.bounds);
    expect(positions(after)).toEqual(positions(big));
  });

  it("raising the agent limit adds seats without moving the ones there", () => {
    const first = workshopLayout(2, {}, null);
    const raised = workshopLayout(6, {}, first);
    expect(raised.seats.bench.length).toBeGreaterThanOrEqual(6);
    for (const [key, at] of positions(first)) expect(positions(raised).get(key)).toBe(at);
  });
});

describe("Floor mode's seating (#420)", () => {
  it("seats everyone, never leaving anyone over as +N, however crowded", () => {
    for (const n of [1, 2, 5, 10, 32]) {
      const agents = STATIONS.flatMap((s) =>
        crowd(s === "pm" ? 1 : s === "scout" ? 1 : n * 3 + 1, s),
      );
      const { seating } = seatOnFloor(n, agents, null);
      expect(seating.more).toEqual({});
      expect(seating.seats.size).toBe(agents.length);
      const tiles = [...seating.seats.values()].map((s) => `${s.station}:${s.tile.c},${s.tile.r}`);
      expect(new Set(tiles).size).toBe(tiles.length);
    }
  });

  it("keeps everyone in their seats across refreshes while their station is unchanged", () => {
    const agents = [...crowd(3, "bench"), ...crowd(2, "review"), ask("pm", "pm")];
    const first = seatOnFloor(2, agents, null);
    const again = seatOnFloor(2, [...agents].reverse(), first);
    for (const a of agents)
      expect(again.seating.seats.get(a.key)).toEqual(first.seating.seats.get(a.key));
  });

  it("keeps the others put when one agent changes station and the zones grow", () => {
    const agents = [...crowd(2, "bench"), ...crowd(2, "review")];
    const first = seatOnFloor(2, agents, null);
    const moved = [
      ask("bench-0", "review"),
      ask("bench-1", "bench"),
      ask("review-0", "review"),
      ask("review-1", "review"),
    ];
    const next = seatOnFloor(2, moved, first);
    expect(next.seating.more).toEqual({});
    for (const key of ["bench-1", "review-0", "review-1"])
      expect(next.seating.seats.get(key)).toEqual(first.seating.seats.get(key));
    expect(next.seating.seats.get("bench-0")?.station).toBe("review");
  });
});
