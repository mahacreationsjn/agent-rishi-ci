import type { SceneAgent } from "./agents";

/**
 * Where agents work on the factory floor (#264, #420), laid out by Floor mode's Workshop: one
 * station per step zone, and single posts for the PM and, in a dark factory, the scout and its
 * area reviewers. Each mode lays its stations out on its own grid; seating only needs the tiles.
 */

/** Where an agent sits: one station per step zone, and single posts in the control room. */
export type StationId = "prep" | "bench" | "review" | "merge" | "ship" | "pm" | "scout" | "area";

/** A cell of a floor's grid: column and row. */
export interface Tile {
  c: number;
  r: number;
}

export const sameTile = (a: Tile, b: Tile): boolean => a.c === b.c && a.r === b.r;

/** A station's places, as seating hands them out. */
export interface StationSeats {
  /** Seat tiles in the order they are handed out. */
  seats: readonly Tile[];
  /** Where agents wait, in order, when every seat is taken (Floor mode has none: it grows). */
  queue: readonly Tile[];
}

/** Every station's places, for one floor plan. */
export type StationTable = Readonly<Record<StationId, StationSeats>>;

/**
 * The station an agent works at, by its role and step: the pipeline's zone for its step. A PR
 * waiting on CI stays where it is (at the review desk, or on the conveyor); a merged one whose
 * CI is still watched stands by the shipping door.
 */
export function stationOf(a: Pick<SceneAgent, "role" | "step" | "card">): StationId {
  if (a.role === "pm" || a.role === "scout" || a.role === "area") return a.role;
  switch (a.step) {
    case "reproducing":
    case "analyzing":
      return "prep";
    case "implementing":
    case "revising":
    case "rebasing":
      return "bench";
    case "merging":
      return "merge";
    case "watching_ci":
      if (a.card?.item.stage === "watching") return "ship";
      return a.card?.item.step === "merge" ? "merge" : "review";
    default:
      return "review";
  }
}
