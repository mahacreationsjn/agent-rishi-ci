import type { SceneAgent } from "./agents";

/**
 * Floor mode's storeys (#476): the Workshop, where the pipeline runs, and in a dark factory the
 * Lookout above it, where the scout and its area reviewers work. The view's tabs focus one
 * storey or show both; each tab counts its agents and shows a pink dot when one of them waits
 * on a person. A software factory has one storey and no tabs. Pure.
 */

export type StoreyId = "workshop" | "lookout";
export type StoreyFocus = StoreyId | "both";

export const STOREY_LABEL: Record<StoreyFocus, string> = {
  workshop: "Workshop",
  lookout: "Lookout",
  both: "Both",
};

/** Which storey an agent works on. */
export function storeyOf(a: Pick<SceneAgent, "role">): StoreyId {
  return a.role === "scout" || a.role === "area" ? "lookout" : "workshop";
}

/** It waits on a person: an answer or an approval, or a person to act on its work. */
export function waitsOnPerson(a: Pick<SceneAgent, "status" | "blockedOn">): boolean {
  return a.status === "approval" || a.blockedOn === "person";
}

export interface StoreyTab {
  id: StoreyFocus;
  label: string;
  count: number;
  /** Someone there waits on a person. */
  waiting: boolean;
}

/**
 * The storey tabs for a factory's agents: none for a software factory (one storey), else
 * Workshop, Lookout and Both, or just the two storeys where only one fits at a time (phones).
 */
export function storeyTabs(
  agents: readonly SceneAgent[],
  darkFactory: boolean,
  oneAtATime = false,
): StoreyTab[] {
  if (!darkFactory) return [];
  const tab = (id: StoreyFocus): StoreyTab => {
    const on = agents.filter((a) => id === "both" || storeyOf(a) === id);
    return { id, label: STOREY_LABEL[id], count: on.length, waiting: on.some(waitsOnPerson) };
  };
  const ids: StoreyFocus[] = oneAtATime ? ["workshop", "lookout"] : ["workshop", "lookout", "both"];
  return ids.map(tab);
}

/** The focus to show: Both by default in a dark factory, one storey where only one fits. */
export function storeyFocus(
  wanted: StoreyFocus | null,
  darkFactory: boolean,
  oneAtATime = false,
): StoreyFocus {
  if (!darkFactory) return "workshop";
  if (wanted === null) return oneAtATime ? "workshop" : "both";
  if (oneAtATime && wanted === "both") return "workshop";
  return wanted;
}
