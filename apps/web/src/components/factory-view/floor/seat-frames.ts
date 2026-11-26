import type { SceneAgent } from "../scene/agents";
import { seatAt, type WorkshopLayout } from "../scene/layout";
import { type LookoutLayout, podOf } from "../scene/lookout";
import type { Scene } from "../scene/scene-model";
import { figureStatus } from "./figure-look";
import { type FigureFrame, standing } from "./frames";

/** Where an agent stands at its post, and whether a desk is in front of it; null when nowhere. */
export function postOf(
  agent: SceneAgent,
  scene: Scene,
  layout: WorkshopLayout,
  lookout: LookoutLayout | null,
): { x: number; y: number; z: number; desk: boolean } | null {
  if (agent.role === "scout" || agent.role === "area") {
    if (!lookout) return null;
    const at = agent.role === "scout" ? lookout.scout : podOf(lookout, agent.area)?.stand;
    return at ? { x: at.x, y: lookout.y, z: at.z, desk: agent.role === "area" } : null;
  }
  const at = scene.seating.seats.get(agent.key);
  const seat = at ? seatAt(layout, at.station, at.tile) : undefined;
  if (!seat || seat.offFloor) return null;
  return { x: seat.stand.x, y: seat.floorY, z: seat.stand.z, desk: seat.desk !== null };
}

/**
 * Every agent standing at its post: the Workshop's at their seats, and in a dark factory the
 * scout at the Lookout's map table and each area reviewer at its pod. The still scene, before
 * anyone walks.
 */
export function seatFrames(
  scene: Scene,
  layout: WorkshopLayout,
  lookout: LookoutLayout | null = null,
): FigureFrame[] {
  const out: FigureFrame[] = [];
  for (const agent of scene.agents) {
    const post = postOf(agent, scene, layout, lookout);
    if (!post) continue;
    const { desk, ...at } = post;
    out.push(standing(agent, figureStatus(agent), at, desk));
  }
  return out;
}
