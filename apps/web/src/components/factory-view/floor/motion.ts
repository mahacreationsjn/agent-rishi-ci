import type { SceneAgent } from "../scene/agents";
import {
  cellAt,
  cellCentre,
  DESK,
  type Point,
  seatAt,
  type WalkGrid,
  type WorkshopLayout,
} from "../scene/layout";
import type { LookoutLayout } from "../scene/lookout";
import type { Scene } from "../scene/scene-model";
import type { Tile } from "../scene/stations";
import type { SeatRef, Transition } from "../scene/transitions";
import {
  arrived,
  cellId,
  GIVE_UP_AFTER,
  nearestFree,
  startWalker,
  stepWalkers,
  type Walker,
  walkerTile,
} from "../scene/walk";
import { type FigureStatus, figureStatus } from "./figure-look";
import type { FigureFrame } from "./frames";
import { seatFrames } from "./seat-frames";

/**
 * Floor mode's motion between data refreshes (#476): who walks where, the one-off moments (a
 * stamp, a celebration, a slump, a crate riding out of the dock door) and where everyone stands
 * this frame. Movement only comes from `sceneEvents` transitions; nothing wanders. Walkers step
 * one cell of the layout's walk grid every `STEP_S` through `stepWalkers`, so nobody shares a
 * cell or walks through anyone, and slide smoothly between cells, turning to face where they
 * go. With reduced motion, or while the factory is stopped, nothing plays: everyone is at their
 * post.
 */

/** Seconds per cell. */
export const STEP_S = 0.18;
const STAMP_S = 0.7;
const CHEER_S = 1.6;
/** A failed agent slumps this long before it trudges to the repair bay. */
const SLUMP_S = 1.1;
/** ... and stays there this long before it leaves. */
const LINGER_S = 1.4;
/** A crate rides the belt and out of the dock door at this speed (units a second). */
const BELT_SPEED = 1.6;
const BELT_Y = 0.36;

interface Mover {
  key: string;
  walker: Walker;
  agent: SceneAgent;
  /** A departed agent acting out its exit: no tag or card, and it leaves when done. */
  ghost: boolean;
  status: FigureStatus;
  carry: "crate" | "ticket" | null;
  /** Seconds to stand first (stamping the crate, or slumped after a failure). */
  delay: number;
  stamping: boolean;
  from: Point;
  to: Point;
  goal: Point;
  y: number;
  facing: number;
  steps: number;
  /** A second leg: where it walks back to. */
  back: Point | null;
  celebrate: boolean;
  /** A ghost stays this long after it arrives. */
  linger: number;
}

/** A departed agent standing where it was: celebrating its merge. */
interface Still {
  key: string;
  agent: SceneAgent;
  at: Point;
  y: number;
  until: number;
  since: number;
}

/** A crate riding out of the dock door. */
export interface Ship {
  path: { x: number; y: number; z: number }[];
  start: number;
  duration: number;
}

export class FloorMotion {
  private movers: Mover[] = [];
  private stills: Still[] = [];
  private cheers = new Map<string, number>();
  private ships: Ship[] = [];
  private stepAt = 0;
  private ghosts = 0;
  private bayTurn = 0;

  /** Someone walks or a moment plays. */
  busy(t: number): boolean {
    return (
      this.movers.length > 0 ||
      this.stills.length > 0 ||
      this.ships.some((s) => t < s.start + s.duration) ||
      [...this.cheers.values()].some((c) => t < c + CHEER_S)
    );
  }

  /** Crates still on their way out, so the dock's count ticks up as each one leaves. */
  shipsInFlight(t: number): number {
    return this.ships.filter((s) => t < s.start + s.duration).length;
  }

  /** The crates riding out at `t`: where each one is (null once it has gone through the door). */
  crates(t: number): { x: number; y: number; z: number; scale: number }[] {
    this.ships = this.ships.filter((s) => t < s.start + s.duration + 0.1);
    return this.ships.flatMap((s) => {
      const k = (t - s.start) / s.duration;
      if (k < 0 || k >= 1) return [];
      return [{ ...along(s.path, k), scale: k > 0.85 ? (1 - k) / 0.15 : 1 }];
    });
  }

  /** Clears every walk and moment: reduced motion, a stopped factory. */
  reset(): void {
    this.movers = [];
    this.stills = [];
    this.cheers.clear();
    this.ships = [];
  }

  /**
   * The cells taken by agents standing still (not walking) and departed agents standing: every
   * cell within a body's reach of where each stands, so walkers pass behind them, not through.
   */
  private occupied(scene: Scene, layout: WorkshopLayout, except?: string): Set<number> {
    const grid = layout.walk;
    const walking = new Set(this.movers.filter((m) => !m.ghost).map((m) => m.key));
    if (except) walking.add(except);
    const out = new Set<number>();
    for (const [key, s] of scene.seating.seats) {
      if (walking.has(key)) continue;
      const seat = seatAt(layout, s.station, s.tile);
      if (seat && !seat.offFloor) for (const id of footprint(grid, seat.stand)) out.add(id);
    }
    for (const s of this.stills) for (const id of footprint(grid, s.at)) out.add(id);
    return out;
  }

  private walk(
    scene: Scene,
    layout: WorkshopLayout,
    m: Omit<Mover, "walker" | "to" | "facing" | "steps" | "y"> & { y?: number },
  ): void {
    this.movers = this.movers.filter((x) => x.key !== m.key);
    const grid = layout.walk;
    // Its own seat doesn't block it.
    const blocked = this.occupied(scene, layout, m.key);
    const start = cellAt(grid, m.from);
    const goalCell = freeCell(grid, cellAt(grid, m.goal), blocked);
    blocked.delete(cellId(grid, goalCell));
    this.movers.push({
      ...m,
      y: m.y ?? 0,
      walker: startWalker(grid, m.key, start, goalCell, blocked),
      to: m.from,
      facing: Math.atan2(m.goal.x - m.from.x, m.goal.z - m.from.z),
      steps: 0,
    });
  }

  /** Acts out the moments between the previous scene and `scene`, from `t`. */
  play(scene: Scene, layout: WorkshopLayout, events: readonly Transition[], t: number): void {
    const agentOf = (key: string) => scene.agents.find((a) => a.key === key);
    const point = (s: SeatRef) => seatPoint(layout, s);
    for (const e of events) {
      if (e.kind === "move" || e.kind === "arrive") {
        const agent = agentOf(e.key);
        const to = point(e.to);
        if (!agent || !to) continue;
        const current = this.movers.find((m) => m.key === e.key);
        const from = current?.to ?? (e.kind === "move" ? point(e.from) : palletFront(layout)) ?? to;
        this.walk(scene, layout, {
          key: e.key,
          agent,
          ghost: false,
          status: figureStatus(agent),
          carry: e.kind === "arrive" ? "ticket" : e.carry,
          delay: e.kind === "move" && e.stamp ? STAMP_S : 0,
          stamping: e.kind === "move" && e.stamp,
          from,
          goal: to,
          back: null,
          celebrate: e.kind === "move" && e.celebrate,
          linger: 0,
        });
      } else if (e.kind === "handoff") {
        const from = point(e.from);
        const desk = deskFront(layout, e.to);
        if (!from || !desk) continue;
        this.ghosts += 1;
        this.walk(scene, layout, {
          key: `ghost:${this.ghosts}`,
          agent: e.agent,
          ghost: true,
          status: figureStatus(e.agent),
          carry: "crate",
          delay: 0,
          stamping: false,
          from,
          goal: desk,
          back: from,
          celebrate: false,
          linger: 0,
        });
      } else if (e.kind === "ship") {
        const path = shipPath(layout, e.from);
        if (path) this.ships.push({ path, start: t, duration: pathLength(path) / BELT_SPEED });
      } else if (e.kind === "celebrate") {
        const at = point(e.at);
        if (!at) continue;
        this.ghosts += 1;
        this.stills.push({
          key: `ghost:${this.ghosts}`,
          agent: e.agent,
          at,
          y: seatY(layout, e.at),
          since: t,
          until: t + CHEER_S,
        });
      } else if (e.kind === "fail" && !e.stays) {
        const from = point(e.at);
        if (!from) continue;
        this.ghosts += 1;
        this.bayTurn += 1;
        this.walk(scene, layout, {
          key: `ghost:${this.ghosts}`,
          agent: e.agent,
          ghost: true,
          status: "failed",
          carry: null,
          delay: SLUMP_S,
          stamping: false,
          from,
          goal: bayPoint(layout, this.bayTurn),
          back: null,
          celebrate: false,
          linger: LINGER_S,
        });
      }
    }
  }

  /** Steps walkers up to `t`, a cell every `STEP_S`, and expires moments. */
  private advance(scene: Scene, layout: WorkshopLayout, t: number): void {
    this.stills = this.stills.filter((s) => s.until > t);
    for (const [key, at] of this.cheers) if (t >= at + CHEER_S) this.cheers.delete(key);
    const keys = new Set(scene.agents.map((a) => a.key));
    this.movers = this.movers.filter((m) => m.ghost || keys.has(m.key));
    if (this.stepAt === 0 || t - this.stepAt > 1) this.stepAt = t;
    const grid = layout.walk;
    while (t - this.stepAt >= STEP_S) {
      this.stepAt += STEP_S;
      for (const m of this.movers) {
        // The last step's slide is done.
        m.from = m.to;
        if (m.delay > 0) m.delay = Math.max(0, m.delay - STEP_S);
        if (m.delay === 0) m.stamping = false;
      }
      const ready = this.movers.filter((m) => m.delay === 0 && !arrived(m.walker));
      if (ready.length > 0) {
        const stepped = stepWalkers(
          grid,
          ready.map((m) => m.walker),
          this.occupied(scene, layout),
        );
        ready.forEach((m, i) => {
          const next = stepped[i] as Walker;
          const a = walkerTile(m.walker);
          const b = walkerTile(next);
          const moved = a.c !== b.c || a.r !== b.r;
          m.walker = next;
          if (moved) {
            m.steps += 1;
            m.to = arrived(next) ? m.goal : cellCentre(grid, walkerTile(next));
            m.facing = Math.atan2(m.to.x - m.from.x, m.to.z - m.from.z);
          }
        });
      }
      this.settle(scene, layout);
    }
  }

  /** Walkers that arrived: the next leg, a lingering ghost, or done. */
  private settle(scene: Scene, layout: WorkshopLayout): void {
    const done: Mover[] = [];
    for (const m of this.movers) {
      if (m.delay > 0) continue;
      const stuck = m.walker.waited >= GIVE_UP_AFTER;
      const there = arrived(m.walker) && m.from === m.to;
      if (!there && !stuck) continue;
      if (m.back && !stuck) {
        const goal = m.back;
        m.back = null;
        m.carry = null;
        const here = m.to;
        const grid = layout.walk;
        const blocked = this.occupied(scene, layout);
        m.goal = goal;
        m.walker = startWalker(
          grid,
          m.key,
          cellAt(grid, here),
          freeCell(grid, cellAt(grid, goal), blocked),
          blocked,
        );
        continue;
      }
      if (m.linger > 0) {
        m.linger = Math.max(0, m.linger - STEP_S);
        continue;
      }
      if (m.celebrate) this.cheers.set(m.key, this.stepAt);
      done.push(m);
    }
    this.movers = this.movers.filter((m) => !done.includes(m));
  }

  /** Everyone to draw at `t`, where they are (the Lookout's crew at their posts up there). */
  frames(
    scene: Scene,
    layout: WorkshopLayout,
    t: number,
    lookout: LookoutLayout | null = null,
  ): FigureFrame[] {
    this.advance(scene, layout, t);
    const k = Math.min(1, Math.max(0, (t - this.stepAt) / STEP_S));
    const out: FigureFrame[] = [];
    const moving = new Set<string>();
    for (const m of this.movers) {
      moving.add(m.key);
      const walking = m.delay === 0 && (m.from !== m.to || !arrived(m.walker));
      const x = m.from.x + (m.to.x - m.from.x) * k;
      const z = m.from.z + (m.to.z - m.from.z) * k;
      out.push({
        key: m.key,
        agent: m.agent,
        status: m.ghost ? m.status : figureStatus(m.agent),
        ghost: m.ghost,
        x,
        y: m.y,
        z,
        facing: m.delay > 0 ? 0 : m.facing,
        desk: false,
        stride: walking ? (m.steps + k) / 2 : null,
        carry: m.carry,
        stamping: m.stamping,
        celebrateAt: null,
      });
    }
    for (const s of this.stills)
      out.push({
        key: s.key,
        agent: s.agent,
        status: "done",
        ghost: true,
        x: s.at.x,
        y: s.y,
        z: s.at.z,
        facing: 0,
        desk: false,
        stride: null,
        carry: null,
        stamping: false,
        celebrateAt: s.since,
      });
    for (const f of seatFrames(scene, layout, lookout)) {
      if (moving.has(f.key)) continue;
      const cheer = this.cheers.get(f.key);
      out.push(cheer === undefined ? f : { ...f, celebrateAt: cheer });
    }
    return out;
  }
}

/** A standing figure keeps others this far from where it stands (its body, and a little room). */
const BODY_REACH = 0.32;

/** The cells a figure standing at `p` takes: those whose centre lies within its reach. */
export function footprint(grid: WalkGrid, p: Point): number[] {
  const at = cellAt(grid, p);
  const out: number[] = [];
  const n = Math.ceil(BODY_REACH / grid.cell);
  for (let dr = -n; dr <= n; dr++)
    for (let dc = -n; dc <= n; dc++) {
      const t = { c: at.c + dc, r: at.r + dr };
      if (t.c < 0 || t.r < 0 || t.c >= grid.cols || t.r >= grid.rows) continue;
      const c = cellCentre(grid, t);
      if (dc === 0 && dr === 0) out.push(cellId(grid, t));
      else if (Math.hypot(c.x - p.x, c.z - p.z) <= BODY_REACH) out.push(cellId(grid, t));
    }
  return out;
}

/** A free cell at or near `t`. */
function freeCell(grid: WalkGrid, t: Tile, blocked: ReadonlySet<number>): Tile {
  return nearestFree(grid, t, blocked) ?? t;
}

function seatY(layout: WorkshopLayout, s: SeatRef): number {
  return seatAt(layout, s.station, s.tile)?.floorY ?? 0;
}

/** Where a seat's figure stands. */
export function seatPoint(layout: WorkshopLayout, s: SeatRef): Point | null {
  const seat = seatAt(layout, s.station, s.tile);
  return seat && !seat.offFloor ? seat.stand : null;
}

/** In front of a seat's desk, facing it from the other side (a handoff's stop). */
function deskFront(layout: WorkshopLayout, s: SeatRef): Point | null {
  const seat = seatAt(layout, s.station, s.tile);
  if (!seat?.desk) return seat?.stand ?? null;
  return { x: seat.desk.x, z: seat.desk.z + DESK.d / 2 + 0.3 };
}

/** In front of intake's pallet, where a builder picks up its ticket. */
function palletFront(layout: WorkshopLayout): Point {
  const p = layout.pallet;
  return { x: (p.x0 + p.x1) / 2, z: p.z1 + 0.35 };
}

/** A spot inside the repair bay, a different one for each arrival in turn. */
function bayPoint(layout: WorkshopLayout, turn: number): Point {
  const b = layout.bay;
  const spots = Math.max(1, Math.floor((b.x1 - b.x0 - 0.6) / 0.5));
  return { x: b.x0 + 0.5 + (turn % spots) * 0.5, z: b.z1 - 0.35 };
}

/** The crate's way from a merge seat: along its belt, then out through the dock door. */
function shipPath(layout: WorkshopLayout, from: SeatRef): Ship["path"] | null {
  const seat = seatAt(layout, from.station, from.tile);
  if (!seat?.desk) return null;
  const merge = layout.zones.find((z) => z.id === "merge");
  const beltEnd = merge ? merge.x1 : seat.desk.x + 1;
  const door = layout.shipDoor;
  return [
    { x: seat.desk.x, y: BELT_Y, z: seat.desk.z },
    { x: beltEnd, y: BELT_Y, z: seat.desk.z },
    { x: beltEnd + 0.4, y: 0.2, z: door.z },
    { x: layout.bounds.x1 + 0.5, y: 0.2, z: door.z },
  ];
}

function pathLength(path: Ship["path"]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Ship["path"][number];
    const b = path[i] as Ship["path"][number];
    d += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return d;
}

/** The point `k` (0..1) of the way along a path. */
function along(path: Ship["path"], k: number): { x: number; y: number; z: number } {
  let left = pathLength(path) * k;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Ship["path"][number];
    const b = path[i] as Ship["path"][number];
    const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    if (left <= d && d > 0) {
      const f = left / d;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
    }
    left -= d;
  }
  return path[path.length - 1] as Ship["path"][number];
}
