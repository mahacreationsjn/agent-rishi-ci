import type { WalkGrid } from "./layout";
import type { Tile } from "./stations";

/**
 * Walking on the floor (#264, #476): shortest paths over the walk grid's free cells
 * (breadth-first, four directions), and one step at a time for everyone who walks, so nobody
 * ever walks through anyone. A walker only steps into a cell that no standing agent occupies and
 * no other walker stands on or has just stepped into; otherwise it waits, and after a few
 * blocked steps looks for a way around. The grid comes from the layout (`layout.ts`). Pure.
 */

const DIRS = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
] as const;

/** A cell's id on its grid. */
export const cellId = (grid: WalkGrid, t: Tile): number => t.r * grid.cols + t.c;

/** Whether a cell is on the grid and nothing stands there for good. */
export function walkable(grid: WalkGrid, t: Tile): boolean {
  if (t.c < 0 || t.c >= grid.cols || t.r < 0 || t.r >= grid.rows) return false;
  return !grid.blocked[cellId(grid, t)];
}

/**
 * The shortest path from `from` to `to` (both included), avoiding `blocked` cells; null when
 * there is none. `from` itself may be blocked (it is where the walker stands).
 */
export function findPath(
  grid: WalkGrid,
  from: Tile,
  to: Tile,
  blocked: ReadonlySet<number>,
): Tile[] | null {
  if (from.c === to.c && from.r === to.r) return [from];
  if (!walkable(grid, to) || blocked.has(cellId(grid, to))) return null;
  const came = new Map<number, number>([[cellId(grid, from), -1]]);
  const queue: Tile[] = [from];
  const goal = cellId(grid, to);
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as Tile;
    for (const [dc, dr] of DIRS) {
      const next = { c: at.c + dc, r: at.r + dr };
      if (!walkable(grid, next)) continue;
      const id = cellId(grid, next);
      if (came.has(id) || (blocked.has(id) && id !== goal)) continue;
      came.set(id, cellId(grid, at));
      if (id === goal) return unwind(grid, came, id);
      queue.push(next);
    }
  }
  return null;
}

function unwind(grid: WalkGrid, came: ReadonlyMap<number, number>, end: number): Tile[] {
  const path: Tile[] = [];
  for (let id = end; id !== -1; id = came.get(id) ?? -1)
    path.unshift({ c: id % grid.cols, r: Math.floor(id / grid.cols) });
  return path;
}

/** The nearest walkable cell to `t` that isn't blocked (itself when it is free). */
export function nearestFree(grid: WalkGrid, t: Tile, blocked: ReadonlySet<number>): Tile | null {
  const start = {
    c: Math.min(grid.cols - 1, Math.max(0, t.c)),
    r: Math.min(grid.rows - 1, Math.max(0, t.r)),
  };
  const seen = new Set<number>([cellId(grid, start)]);
  const queue: Tile[] = [start];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i] as Tile;
    if (walkable(grid, at) && !blocked.has(cellId(grid, at))) return at;
    for (const [dc, dr] of DIRS) {
      const next = { c: at.c + dc, r: at.r + dr };
      if (next.c < 0 || next.c >= grid.cols || next.r < 0 || next.r >= grid.rows) continue;
      if (seen.has(cellId(grid, next))) continue;
      seen.add(cellId(grid, next));
      queue.push(next);
    }
  }
  return null;
}

export interface Walker {
  key: string;
  /** From where it started (or last re-planned) to its goal. */
  path: Tile[];
  /** Its index on the path: where it stands. */
  at: number;
  /** Steps it has waited in a row. */
  waited: number;
}

/** After this many blocked steps a walker looks for another way. */
export const REPATH_AFTER = 3;
/** After this many, it gives up walking (the scene puts it straight on its goal). */
export const GIVE_UP_AFTER = 36;

export const walkerTile = (w: Walker): Tile => w.path[w.at] as Tile;
export const walkerGoal = (w: Walker): Tile => w.path[w.path.length - 1] as Tile;
export const arrived = (w: Walker): boolean => w.at >= w.path.length - 1;

/**
 * A walker from `from` to `to`. With no way through (everything around is taken), it doesn't
 * slide across the floor: it is simply at its goal.
 */
export function startWalker(
  grid: WalkGrid,
  key: string,
  from: Tile,
  to: Tile,
  blocked: ReadonlySet<number>,
): Walker {
  const path = findPath(grid, from, to, blocked) ?? [to];
  return { key, path, at: 0, waited: 0 };
}

/**
 * One step for every walker, in order. `occupied` holds the cells of agents standing still.
 * Every walker's cell counts as taken for the whole step (even one that moves off it), so two
 * walkers never meet on a cell or swap through each other. When two walkers block each other,
 * the later one in the list gives way (looks for another route) and the earlier one waits, so
 * they don't both step aside the same way forever.
 */
export function stepWalkers(
  grid: WalkGrid,
  walkers: readonly Walker[],
  occupied: ReadonlySet<number>,
): Walker[] {
  const id = (t: Tile) => cellId(grid, t);
  const claimed = new Set(walkers.map((w) => id(walkerTile(w))));
  const standing = new Map(walkers.map((w, i) => [id(walkerTile(w)), i]));
  return walkers.map((w, i) => {
    if (arrived(w)) return w;
    const next = w.path[w.at + 1] as Tile;
    const nextId = id(next);
    if (!occupied.has(nextId) && !claimed.has(nextId)) {
      claimed.add(nextId);
      return { ...w, at: w.at + 1, waited: 0 };
    }
    const waited = w.waited + 1;
    const blocker = standing.get(nextId);
    const blockerWalker = blocker === undefined ? undefined : walkers[blocker];
    // Anyone gives way after waiting a while: the other may have no way around.
    const yields =
      blocker === undefined ||
      blocker < i ||
      (blockerWalker !== undefined && arrived(blockerWalker)) ||
      waited >= 2 * REPATH_AFTER;
    if (yields && waited % REPATH_AFTER === 0) {
      const around = new Set([...occupied, ...claimed]);
      around.delete(id(walkerTile(w)));
      const path = findPath(grid, walkerTile(w), walkerGoal(w), around);
      if (path && path.length > 1) return { ...w, path, at: 0, waited };
    }
    return { ...w, waited };
  });
}
