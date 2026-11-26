import { drainText, type FactoryStatus, type WorkType } from "@agent-rishi/contracts";
import type { ViewCard } from "../stages";
import { type AgentInputs, type SceneAgent, sceneAgents } from "./agents";
import { type BayCrate, bayCount, repairBay } from "./repair-bay";
import { assignSeats, type Seating } from "./seating";
import { type StationId, type StationTable, stationOf } from "./stations";

/**
 * The Factory view's pipeline as a factory floor (#209, #264, #420), used by
 * Floor mode. This module maps the live state to what the scene shows: the agents and their
 * seats, the ticket pile at intake, the repair bay, the shipped counter and the wall's gauge and
 * CI lamp. Pure, so the mapping is unit-tested; the scene only paints it.
 */

/** Tickets drawn on the intake pallet; the rest show as "+N". */
export const TICKET_CAP = 8;

export interface SceneTicket {
  card: ViewCard;
  slot: number;
  /** Plain paper before the item is sorted; tinted by type once it is. */
  tint: "paper" | WorkType;
}

export interface TicketPile {
  items: SceneTicket[];
  more: number;
  ids: string[];
}

export interface Scene {
  /** Kill switch on or loop stopped: the lights dim and everyone sits down. */
  stopped: boolean;
  /**
   * Finishing current work, then stopping (`FactoryStatus.drain`): the items still in flight, and
   * a "CLOSED" sign on the IN door; null when not draining.
   */
  draining: number | null;
  agents: SceneAgent[];
  seating: Seating;
  tickets: TicketPile;
  bay: BayCrate[];
  /** Items merged today: off the floor, only counted. */
  merged: string[];
  /** The counter by the shipping door: merges today, as the figures count them. */
  shipped: number;
  /**
   * The status board over the dock, beside `shipped`: agents working and items waiting on a
   * person, the same figures the stats strip and the header use.
   */
  board: { working: number; waiting: number };
  /** Some pull request waits on CI, or CI on the default branch is watched after a merge. */
  ciRunning: boolean;
  /** Spend against the daily budget, 0..1; null when no budget is set. */
  gauge: number | null;
  /** Dark factory only; `filing` while the scout files its round's issues (capsules drop). */
  scout: { round: number; active: boolean; filing: boolean } | null;
}

/** Spend today against the daily budget, as the figures measure it (USD first, else tokens). */
export function budgetGauge(f: FactoryStatus): number | null {
  const { usd, tokens } = f.limits.dailyBudget;
  const fraction = usd ? f.spendToday.usd / usd : tokens ? f.spendToday.tokens / tokens : null;
  return fraction === null ? null : Math.min(1, Math.max(0, fraction));
}

function ticketsOf(cards: readonly ViewCard[]): TicketPile {
  return {
    items: cards.slice(0, TICKET_CAP).map((card, slot) => ({
      card,
      slot,
      tint: card.place === "type" && card.item.type ? card.item.type : "paper",
    })),
    more: Math.max(0, cards.length - TICKET_CAP),
    ids: cards.map((c) => c.item.id),
  };
}

/** How many agents each station has to seat. */
export type StationDemand = Record<StationId, number>;

/**
 * The floor plan for a scene, given how many agents each station has to seat: a fixed plan is
 * fixed (`() => STATIONS`), Floor mode's layout grows until everyone has a seat.
 */
export type FloorPlan = (demand: StationDemand) => StationTable;

/** How many agents want each station. */
export function stationDemand(requests: readonly { station: StationId }[]): StationDemand {
  const out: StationDemand = {
    prep: 0,
    bench: 0,
    review: 0,
    merge: 0,
    ship: 0,
    pm: 0,
    scout: 0,
    area: 0,
  };
  for (const r of requests) out[r.station] += 1;
  return out;
}

/**
 * The scene for the current state. Seats follow `prev`, the seating of the scene before, so an
 * agent that stays at its station keeps its seat; the same data gives the same scene.
 */
export function sceneOf(inputs: AgentInputs, prev: Seating | null, plan: FloorPlan): Scene {
  const { f, pipeline } = inputs;
  const agents = sceneAgents(inputs);
  const requests = agents.map((a) => ({ key: a.key, station: stationOf(a) }));
  const seating = assignSeats(prev, requests, plan(stationDemand(requests)));
  const all = [...Object.values(pipeline.stages).flat(), ...pipeline.needsYou];
  const stopped = f.killSwitch || f.globalKillSwitch || f.loopState === "stopped";
  return {
    stopped,
    draining: f.drain && !stopped ? f.drain.inFlight : null,
    agents,
    seating,
    tickets: ticketsOf([...pipeline.stages.intake, ...pipeline.stages.type]),
    bay: repairBay(pipeline),
    merged: pipeline.stages.merged.filter((c) => c.item.stage === "merged").map((c) => c.item.id),
    shipped: f.limits.autoMerge ? f.mergesToday : f.stats.mergedToday,
    board: { working: f.activeSessions, waiting: pipeline.needsPerson },
    ciRunning: all.some((c) => c.pr?.state === "waiting_ci" || c.item.stage === "watching"),
    gauge: budgetGauge(f),
    scout:
      f.mode === "dark_factory" && f.scout
        ? {
            round: f.scout.rounds,
            active: f.scout.phase !== "idle",
            filing: f.scout.phase === "filing",
          }
        : null,
  };
}

const STATION_WORDS: [StationId[], string][] = [
  [["prep", "bench"], "building"],
  [["review"], "in review"],
  [["merge"], "in the merge queue"],
];

/**
 * The scene in words, for the live caption that stands in for the canvas: "4 building, 1 in
 * review, 3 merged today, 1 waiting for approval, 2 in the repair bay." Full counts, drawn or not.
 */
export function sceneSummary(scene: Scene): string {
  const parts: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) parts.push(`${n} ${text}`);
  };
  add(scene.tickets.ids.length, "in intake");
  const work = scene.agents.filter((a) => a.card);
  for (const [stations, words] of STATION_WORDS)
    add(work.filter((a) => stations.includes(stationOf(a))).length, words);
  add(scene.shipped, "merged today");
  add(scene.agents.filter((a) => a.status === "approval").length, "waiting for approval");
  add(bayCount(scene.bay), "in the repair bay");
  const lines = [parts.length > 0 ? `${parts.join(", ")}.` : "The factory floor is quiet."];
  if (scene.scout?.active && !scene.stopped)
    lines.push(`The scout is on round ${scene.scout.round}.`);
  if (scene.draining !== null) {
    lines.push(`${drainText(scene.draining)}; the IN door is closed until the factory resumes.`);
  }
  if (scene.stopped) lines.push("The loop is stopped.");
  return lines.join(" ");
}
