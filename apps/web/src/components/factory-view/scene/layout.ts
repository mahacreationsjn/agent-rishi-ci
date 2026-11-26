import type { StationDemand } from "./scene-model";
import type { StationId, StationTable, Tile } from "./stations";

/**
 * Floor mode's Workshop (#420): the pipeline's storey, laid out from the agent limit. Zones run
 * along +x in the board's order (Intake, Prep, Build, Review, Merge, Ship), then the PM's glass
 * booth in the back-right corner; the repair bay is the fenced corner at the front left. World
 * units are floor grid cells; the front of the hall is z = 0 and it goes back in -z.
 *
 * Every station starts with seats for the agent limit N and grows by whole rows when more agents
 * want it than it has seats, so nobody is ever left over as "+N". Seats never move once laid out:
 * a zone's width is fixed when it is first laid out and rows are added at the back, so growing
 * only deepens the hall. The layout never shrinks while the view is open (pass the previous one
 * back in). Pure.
 */

export type ZoneId = "intake" | "prep" | "bench" | "review" | "merge" | "ship";

/** Seats sit this far apart in x. */
export const SEAT_PITCH = 1;
/** Rows of seats sit this far apart in z, which leaves aisles between them. */
export const ROW_PITCH = 1.2;
/** At most this many seats in a row. */
export const ROW_SEATS = 4;
/** The walkway along the front and between zones. */
export const WALKWAY = 1;
export const DESK = { w: 0.8, d: 0.5, h: 0.26 } as const;
/** A figure stands this far behind its desk's centre, facing +z. */
export const STAND_BEHIND = 0.45;
export const WALL_H = 1.6;
export const CURB_H = 0.15;
export const BOOTH = { w: 2.4, d: 2, h: 0.3 } as const;
/** Starting seats are laid out for at most this agent limit; growth still adds rows past it. */
export const MAX_START_LIMIT = 32;
/** The area reviewers' places: one per review area, at their pods on the Lookout storey. */
const AREA_SEATS = 8;

const INTAKE_W = 2.6;
const TOWER_W = 0.6;
const LEFT_MARGIN = 0.3;
const RIGHT_MARGIN = 0.4;
/** Room behind the last row of figures, before the back wall. */
const BACK_CLEARANCE = 0.6;
/** Intake's roll-up door, pallet and the repair bay need this much depth at least. */
const MIN_DEPTH = 4.2;

export interface Point {
  x: number;
  z: number;
}

/** A rectangle on the floor; z0 is its back edge (more negative), z1 its front. */
export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface LayoutSeat {
  station: StationId;
  /** Its seat-grid cell: the station's place in the hall and the seat's index, never reused. */
  tile: Tile;
  /** Where the figure stands, facing +z. */
  stand: Point;
  /** The centre of what stands in front of it (a desk, a conveyor slot); null for none. */
  desk: Point | null;
  /** The floor's height under it: 0, or the PM booth's platform. */
  floorY: number;
  /** Not on the Workshop floor (the scout and area reviewers, on the Lookout storey). */
  offFloor: boolean;
}

export interface LayoutZone {
  id: ZoneId;
  /** Painted on the floor and on its wall sign. */
  label: string;
  station: StationId | null;
  x0: number;
  x1: number;
  /** Seats per row; fixed once laid out. */
  cols: number;
  rows: number;
}

/**
 * The walk grid's cells are this wide: fine enough that every desk blocks a row of them and the
 * aisle behind a row of seated figures still has a free lane.
 */
export const WALK_CELL = 0.25;

/**
 * A grid of square cells over the floor for walking (#476), anchored at the hall's front left:
 * cell (c, r) spans x0 + c·cell .. x0 + (c+1)·cell and goes back from the front, z0 − r·cell ..
 * z0 − (r+1)·cell. Anchored at the front, its rows line up with the desk rows.
 */
export interface WalkGrid {
  x0: number;
  /** The front edge (the hall's z1). */
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  /** Row-major: true where furniture, a fence or the walls stand. */
  blocked: boolean[];
}

/** A cell's centre on the floor. */
export function cellCentre(grid: WalkGrid, t: Tile): Point {
  return { x: grid.x0 + (t.c + 0.5) * grid.cell, z: grid.z0 - (t.r + 0.5) * grid.cell };
}

/** The cell a point on the floor is in. */
export function cellAt(grid: WalkGrid, p: Point): Tile {
  return {
    c: Math.floor((p.x - grid.x0) / grid.cell),
    r: Math.floor((grid.z0 - p.z) / grid.cell),
  };
}

export interface WorkshopLayout {
  /** The agent limit its starting seats came from (clamped). */
  n: number;
  zones: LayoutZone[];
  /** Seats per station, in the order seating hands them out. */
  seats: Record<StationId, LayoutSeat[]>;
  /** The same seats as seating reads them; no queues, since stations grow instead. */
  stations: StationTable;
  /** The floor inside the walls. */
  bounds: Box;
  bay: Box;
  booth: Box;
  pallet: Box;
  /** Intake's roll-up door in the back wall: its centre and width. */
  inDoor: { x: number; w: number };
  /** The sign with intake's count, beside the pallet. */
  countSign: Point;
  /** At the conveyor's start. */
  signalTower: Point;
  /** The dock door in the right wall: its centre and width. */
  shipDoor: { z: number; w: number };
  /** The budget dial's centre on the back wall, above Prep. */
  budgetDial: { x: number };
  walk: WalkGrid;
}

const STATION_ORDER: StationId[] = [
  "prep",
  "bench",
  "review",
  "merge",
  "ship",
  "pm",
  "scout",
  "area",
];

const ZONES: { id: ZoneId; label: string; station: StationId | null }[] = [
  { id: "intake", label: "INTAKE", station: null },
  { id: "prep", label: "PREP", station: "prep" },
  { id: "bench", label: "BUILD", station: "bench" },
  { id: "review", label: "REVIEW", station: "review" },
  { id: "merge", label: "MERGE", station: "merge" },
  { id: "ship", label: "SHIP", station: "ship" },
];

const clampLimit = (n: number) =>
  Math.min(MAX_START_LIMIT, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));

/** Seats each station starts with for agent limit `n`. */
export function startingSeats(n: number): Record<StationId, number> {
  const N = clampLimit(n);
  const half = Math.ceil(N / 2);
  return {
    prep: half,
    bench: N,
    review: N,
    merge: N,
    ship: half,
    pm: 1,
    scout: 1,
    area: AREA_SEATS,
  };
}

/** Seats per row for a station that starts with `start` seats. */
function colsFor(station: StationId, start: number): number {
  if (station === "pm" || station === "scout") return 1;
  return Math.min(ROW_SEATS, Math.max(2, start));
}

/** Enough seats for `want`, adding whole rows past `have`. */
function grow(have: number, want: number, cols: number): number {
  return want <= have ? have : Math.ceil(want / cols) * cols;
}

const rowsOf = (seats: number, cols: number) => Math.ceil(seats / cols);
const zoneWidth = (id: ZoneId, cols: number) =>
  id === "intake" ? INTAKE_W : id === "merge" ? TOWER_W + cols * SEAT_PITCH : cols * SEAT_PITCH;

/** The z of a row's desk centre; rows go back from the front walkway. */
export const deskZ = (row: number) => -(WALKWAY + DESK.d / 2) - row * ROW_PITCH;

/** Depth the hall needs for this many rows of seats. */
const depthFor = (rows: number) =>
  -deskZ(Math.max(0, rows - 1)) + STAND_BEHIND + 0.22 + BACK_CLEARANCE;

/**
 * The Workshop for agent limit `n`, with room for `demand` agents per station. With `prev` (the
 * layout already on screen) every seat it had keeps its place: zones keep their widths and only
 * gain rows, and nothing shrinks.
 */
export function workshopLayout(
  n: number,
  demand: Partial<StationDemand>,
  prev: WorkshopLayout | null,
): WorkshopLayout {
  const start = startingSeats(prev ? Math.max(prev.n, clampLimit(n)) : n);
  const cols = {} as Record<StationId, number>;
  const counts = {} as Record<StationId, number>;
  for (const s of STATION_ORDER) {
    cols[s] = prev ? (zoneOf(prev, s)?.cols ?? colsFor(s, start[s])) : colsFor(s, start[s]);
    const had = prev ? prev.seats[s].length : 0;
    counts[s] = grow(Math.max(had, start[s]), Math.max(start[s], demand[s] ?? 0), cols[s]);
  }

  // Along +x: the zones in board order with walkways between them, then the PM's booth.
  const zones: LayoutZone[] = [];
  let x = LEFT_MARGIN;
  for (const z of ZONES) {
    const c = z.station ? cols[z.station] : 0;
    const w = prev ? prevWidth(prev, z.id) : zoneWidth(z.id, c);
    zones.push({
      ...z,
      x0: x,
      x1: x + w,
      cols: c,
      rows: z.station ? rowsOf(counts[z.station], c) : 0,
    });
    x += w + WALKWAY;
  }
  const boothX0 = x - WALKWAY / 2;
  const x1 = boothX0 + BOOTH.w + RIGHT_MARGIN;

  const deepest = Math.max(...zones.map((z) => z.rows));
  const depth = Math.max(MIN_DEPTH, depthFor(deepest), prev ? -prev.bounds.z0 : 0);
  const bounds: Box = { x0: 0, x1, z0: -depth, z1: 0 };
  // The booth stays against the back wall it was first built at, so the PM never moves.
  const boothZ0 = prev ? prev.booth.z0 : bounds.z0;
  const booth: Box = { x0: boothX0, x1: boothX0 + BOOTH.w, z0: boothZ0, z1: boothZ0 + BOOTH.d };

  const seats = {} as Record<StationId, LayoutSeat[]>;
  const tile = (s: StationId, i: number): Tile => ({ c: STATION_ORDER.indexOf(s), r: i });
  for (const z of zones) {
    if (!z.station) continue;
    const s = z.station;
    const left = z.x0 + (z.id === "merge" ? TOWER_W : 0) + SEAT_PITCH / 2;
    seats[s] = Array.from({ length: counts[s] }, (_, i) => {
      const col = i % z.cols;
      const row = Math.floor(i / z.cols);
      const desk = { x: left + col * SEAT_PITCH, z: deskZ(row) };
      return {
        station: s,
        tile: tile(s, i),
        stand: { x: desk.x, z: desk.z - STAND_BEHIND },
        // The shipping crew stands by the door with nothing in front of it.
        desk: s === "ship" ? null : desk,
        floorY: 0,
        offFloor: false,
      };
    });
  }
  const pmDesk = { x: (booth.x0 + booth.x1) / 2, z: booth.z1 - 0.7 };
  seats.pm = Array.from({ length: counts.pm }, (_, i) => ({
    station: "pm",
    tile: tile("pm", i),
    stand: { x: pmDesk.x + i * SEAT_PITCH, z: pmDesk.z - STAND_BEHIND },
    desk: { x: pmDesk.x + i * SEAT_PITCH, z: pmDesk.z },
    floorY: BOOTH.h,
    offFloor: false,
  }));
  for (const s of ["scout", "area"] as const) {
    seats[s] = Array.from({ length: counts[s] }, (_, i) => ({
      station: s,
      tile: tile(s, i),
      stand: { x: 0, z: 0 },
      desk: null,
      floorY: 0,
      offFloor: true,
    }));
  }

  const intake = zones[0] as LayoutZone;
  const merge = zones.find((z) => z.id === "merge") as LayoutZone;
  const prep = zones.find((z) => z.id === "prep") as LayoutZone;
  const doorX = (intake.x0 + intake.x1) / 2 - 0.2;
  const pallet: Box = {
    x0: doorX - 0.8,
    x1: doorX + 0.8,
    z0: bounds.z0 + 0.25,
    z1: bounds.z0 + 1.25,
  };
  const bay: Box = { x0: intake.x0, x1: intake.x1, z0: -2.1, z1: -0.25 };

  const stations = {} as Record<StationId, { seats: Tile[]; queue: Tile[] }>;
  for (const s of STATION_ORDER)
    stations[s] = { seats: seats[s].map((seat) => seat.tile), queue: [] };

  const layout: WorkshopLayout = {
    n: Math.max(prev?.n ?? 0, clampLimit(n)),
    zones,
    seats,
    stations,
    bounds,
    bay,
    booth,
    pallet,
    inDoor: { x: doorX, w: 1.8 },
    countSign: { x: intake.x1 - 0.2, z: pallet.z0 + 0.5 },
    signalTower: { x: merge.x0 + TOWER_W / 2, z: deskZ(0) },
    // At the front of the right wall, clear of the booth at its back.
    shipDoor: { z: -0.95, w: 1.2 },
    budgetDial: { x: (prep.x0 + prep.x1) / 2 },
    walk: { x0: 0, z0: 0, cell: WALK_CELL, cols: 0, rows: 0, blocked: [] },
  };
  layout.walk = walkGrid(layout);
  return layout;
}

function zoneOf(layout: WorkshopLayout, s: StationId): LayoutZone | undefined {
  return layout.zones.find((z) => z.station === s);
}

function prevWidth(layout: WorkshopLayout, id: ZoneId): number {
  const z = layout.zones.find((zone) => zone.id === id) as LayoutZone;
  return z.x1 - z.x0;
}

/** The furniture nobody walks through: desks and belts, the pallet, the repair bay, the booth. */
export function furniture(layout: WorkshopLayout): Box[] {
  const out: Box[] = [layout.pallet, layout.bay, layout.booth];
  for (const s of ["prep", "bench", "review", "merge"] as const) {
    for (const seat of layout.seats[s]) {
      if (!seat.desk) continue;
      const w = s === "merge" ? SEAT_PITCH : DESK.w;
      out.push({
        x0: seat.desk.x - w / 2,
        x1: seat.desk.x + w / 2,
        z0: seat.desk.z - DESK.d / 2,
        z1: seat.desk.z + DESK.d / 2,
      });
    }
  }
  return out;
}

/**
 * The repair bay's fence (its back edge, and its right edge up to the gap at the front) as thin
 * boxes: walkers go round it and in through the gap.
 */
export function bayFence(layout: WorkshopLayout): Box[] {
  const { bay } = layout;
  const t = 0.2;
  return [
    { x0: bay.x0, x1: bay.x1 + t, z0: bay.z0 - t, z1: bay.z0 + t },
    { x0: bay.x1 - t, x1: bay.x1 + t, z0: bay.z0, z1: bay.z1 - 0.7 },
  ];
}

function walkGrid(layout: WorkshopLayout): WalkGrid {
  const { bounds } = layout;
  const cell = WALK_CELL;
  const cols = Math.ceil((bounds.x1 - bounds.x0) / cell);
  const rows = Math.ceil((bounds.z1 - bounds.z0) / cell);
  // Walkers may enter the repair bay (through its gap), so it blocks as its fence only.
  const boxes = [...furniture(layout).filter((b) => b !== layout.bay), ...bayFence(layout)];
  const grid: WalkGrid = { x0: bounds.x0, z0: bounds.z1, cell, cols, rows, blocked: [] };
  grid.blocked = Array.from({ length: cols * rows }, (_, i) => {
    const { x, z } = cellCentre(grid, { c: i % cols, r: Math.floor(i / cols) });
    if (x < bounds.x0 + 0.1 || x > bounds.x1 - 0.1 || z < bounds.z0 + 0.1) return true;
    return boxes.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
  });
  return grid;
}

/** Every seat on the Workshop floor, with its station. */
export function floorSeats(layout: WorkshopLayout): LayoutSeat[] {
  return STATION_ORDER.flatMap((s) => layout.seats[s]).filter((seat) => !seat.offFloor);
}

/** The seat a seating tile names, if the layout has it. */
export function seatAt(
  layout: WorkshopLayout,
  station: StationId,
  t: Tile,
): LayoutSeat | undefined {
  return layout.seats[station].find((s) => s.tile.c === t.c && s.tile.r === t.r);
}
