import type { WorkType } from "@agent-rishi/contracts";
import type { AgentRole, AgentStep } from "../scene/agents";
import type { LayoutSeat } from "../scene/layout";
import type { Scene } from "../scene/scene-model";
import { type StationId, stationOf } from "../scene/stations";

/**
 * What stands on Floor mode's desks: a laptop on every desk where an agent works at a computer
 * (part of the hall, seated or not), and on a desk somebody sits at, a prop for the step they are
 * on: a jar with a bug and a magnifier while reproducing, the whiteboard and sticky notes while
 * analyzing, a toolbox at the bench (with a wrench for a bug fix, a blueprint roll for a feature)
 * and a clipboard with a red pen while reviewing. Empty desks have no step prop. Pure.
 */

/** Who works at a seat: its agent's step (its role when it has none) and its item's type. */
export interface SeatUse {
  step: AgentStep | AgentRole;
  /** Bug, feature or docs, once the item is sorted; null when it isn't (or has no item). */
  type: WorkType | null;
}

/** A step's prop on a desk. */
export type DeskProp =
  | "jar"
  | "magnifier"
  | "whiteboard"
  | "notes"
  | "toolbox"
  | "wrench"
  | "blueprint"
  | "clipboard"
  | "pen";

/** Stations whose desks carry a laptop: everyone there works at a computer. */
const LAPTOP_STATIONS: ReadonlySet<StationId> = new Set(["prep", "bench", "review", "pm"]);

/** Whether a desk at `station` has a laptop on it (seated or not, so the room stays alike). */
export const hasLaptop = (station: StationId): boolean => LAPTOP_STATIONS.has(station);

/** The step props on a desk at `station`, for whoever sits there; none on an empty desk. */
export function deskProps(station: StationId, use: SeatUse | undefined): DeskProp[] {
  if (!use) return [];
  switch (station) {
    case "prep":
      if (use.step === "reproducing") return ["jar", "magnifier"];
      if (use.step === "analyzing") return ["whiteboard", "notes"];
      return [];
    case "bench":
      if (use.type === "bug") return ["toolbox", "wrench"];
      if (use.type === "feature") return ["toolbox", "blueprint"];
      return ["toolbox"];
    case "review":
      return ["clipboard", "pen"];
    default:
      return [];
  }
}

/** A seat's key, matching the occupied map. */
export const seatKey = (seat: Pick<LayoutSeat, "station" | "tile">): string =>
  `${seat.station}:${seat.tile.c},${seat.tile.r}`;

/** Which seats are taken, and the step and item type of whoever sits there. */
export function occupiedSeats(scene: Scene): Map<string, SeatUse> {
  const out = new Map<string, SeatUse>();
  for (const a of scene.agents) {
    const seat = scene.seating.seats.get(a.key);
    if (!seat || seat.station !== stationOf(a)) continue;
    out.set(seatKey(seat), { step: a.step ?? a.role, type: a.card?.item.type ?? null });
  }
  return out;
}
