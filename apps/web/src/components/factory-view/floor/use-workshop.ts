import { useMemo, useRef } from "react";
import type { AgentInputs } from "../scene/agents";
import { type WorkshopLayout, workshopLayout } from "../scene/layout";
import { type Scene, sceneOf } from "../scene/scene-model";
import type { Seating } from "../scene/seating";

/**
 * Floor mode's scene and Workshop (#420): the layout starts from the agent limit and grows with
 * the agents that want each station, so everyone has a seat; it never shrinks while the view is
 * open. Seats follow the previous scene's, so agents keep theirs while their station stays.
 */
export function useWorkshop(inputs: AgentInputs): { scene: Scene; layout: WorkshopLayout } {
  const seating = useRef<Seating | null>(null);
  const layout = useRef<WorkshopLayout | null>(null);
  const { f, pipeline, sessions, pmSessionId } = inputs;
  return useMemo(() => {
    const limit = f.limits.maxConcurrentSessions;
    const laid: { current: WorkshopLayout | null } = { current: null };
    const scene = sceneOf({ f, pipeline, sessions, pmSessionId }, seating.current, (demand) => {
      laid.current = workshopLayout(limit, demand, layout.current);
      return laid.current.stations;
    });
    const next = laid.current ?? workshopLayout(limit, {}, layout.current);
    seating.current = scene.seating;
    layout.current = next;
    return { scene, layout: next };
  }, [f, pipeline, sessions, pmSessionId]);
}
