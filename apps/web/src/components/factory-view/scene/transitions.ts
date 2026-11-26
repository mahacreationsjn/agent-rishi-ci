import type { SceneAgent } from "./agents";
import type { Scene } from "./scene-model";
import type { StationId, Tile } from "./stations";

/**
 * The floor's moments (#264, #476): what it acts out between two scenes, by seat. Pure, so the
 * mapping is unit-tested; Floor mode's motion plays them in 3D.
 */

/** A seat: its station and its tile in the seating. */
export interface SeatRef {
  station: StationId;
  tile: Tile;
}

/** A moment the floor acts out once, between two scenes. */
export type Transition =
  /** An agent walks from its old seat to its new one; a reviewer stamps the crate first. */
  | {
      kind: "move";
      key: string;
      from: SeatRef;
      to: SeatRef;
      carry: "crate" | null;
      stamp: boolean;
      /** It celebrates on arrival (its pull request merged). */
      celebrate: boolean;
    }
  /** A build started from the pile: the builder walks in from the pallet carrying its ticket. */
  | { kind: "arrive"; key: string; to: SeatRef }
  /** The builder carries its PR crate to the new reviewer's desk, then walks back to its bench. */
  | { kind: "handoff"; agent: SceneAgent; from: SeatRef; to: SeatRef }
  /** A merge: the crate rides the conveyor from this seat and out of the dock door. */
  | { kind: "ship"; from: SeatRef }
  /** A departed agent's pull request merged: a small celebration where it stood. */
  | { kind: "celebrate"; agent: SceneAgent; at: SeatRef }
  /** It failed: a puff of smoke, and unless it stays, it trudges to the repair bay. */
  | { kind: "fail"; agent: SceneAgent; at: SeatRef; stays: boolean };

const itemOf = (a: SceneAgent) => a.card?.item.id ?? null;
const sameTile = (a: Tile, b: Tile) => a.c === b.c && a.r === b.r;
const ref = (s: { station: StationId; tile: Tile }): SeatRef => ({
  station: s.station,
  tile: s.tile,
});

/**
 * The moments between the previous scene and this one. Nothing on the first scene, so opening
 * the view doesn't replay the day, and nothing when the same data comes again.
 */
export function sceneEvents(prev: Scene | null, next: Scene): Transition[] {
  if (!prev) return [];
  const out: Transition[] = [];
  const before = (key: string) => prev.seating.seats.get(key);
  const after = (key: string) => next.seating.seats.get(key);
  const prevByItem = new Map<string, SceneAgent>();
  for (const a of prev.agents) {
    const id = itemOf(a);
    if (id) prevByItem.set(id, a);
  }
  const nextKeys = new Set(next.agents.map((a) => a.key));
  const nextItems = new Set(next.agents.map(itemOf).filter(Boolean));
  const was = new Map(prev.agents.map((a) => [a.key, a]));

  for (const a of next.agents) {
    const to = after(a.key);
    if (!to) continue;
    const item = itemOf(a);
    const same = was.get(a.key);
    const from = same ? before(a.key) : undefined;
    if (same && from) {
      if (from.station !== to.station || !sameTile(from.tile, to.tile)) {
        const handsOver = from.station === "review" && to.station === "merge";
        out.push({
          kind: "move",
          key: a.key,
          from: ref(from),
          to: ref(to),
          carry: handsOver ? "crate" : null,
          stamp: handsOver,
          celebrate: to.station === "ship",
        });
        if (from.station === "merge" && to.station === "ship")
          out.push({ kind: "ship", from: ref(from) });
      }
      if (!same.failed && a.failed) out.push({ kind: "fail", agent: a, at: ref(to), stays: true });
      continue;
    }
    if (same || !item) continue;
    // The item's builder hands its pull request over to the new reviewer.
    const builder = prevByItem.get(item);
    const bench = builder ? before(builder.key) : undefined;
    if (builder?.role === "builder" && a.role === "reviewer" && bench) {
      out.push({ kind: "handoff", agent: builder, from: ref(bench), to: ref(to) });
      continue;
    }
    if (a.role === "builder" && prev.tickets.ids.includes(item))
      out.push({ kind: "arrive", key: a.key, to: ref(to) });
  }

  const merged = new Set(next.merged);
  const inBay = new Set(next.bay.flatMap((c) => c.entries.map((e) => e.card.item.id)));
  for (const b of prev.agents) {
    const item = itemOf(b);
    const seat = before(b.key);
    if (nextKeys.has(b.key) || !item || !seat || nextItems.has(item)) continue;
    if (merged.has(item)) {
      out.push({ kind: "celebrate", agent: b, at: ref(seat) });
      if (seat.station === "merge") out.push({ kind: "ship", from: ref(seat) });
    } else if (inBay.has(item)) out.push({ kind: "fail", agent: b, at: ref(seat), stays: false });
  }
  return out;
}
