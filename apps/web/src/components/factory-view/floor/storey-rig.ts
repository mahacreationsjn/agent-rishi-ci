import type { StoreyFocus, StoreyId } from "../scene/storeys";
import { easeInOut } from "./camera";

/**
 * How Floor mode's two storeys stand (#476): in place, or slid aside and dimmed while the other
 * one is focused. Focusing a storey eases the other aside over about half a second (at once with
 * reduced motion). Pure apart from its own state: give it the time.
 */

export const SLIDE_S = 0.5;
/** Where a storey goes when the other is focused: the Workshop down and forward, the Lookout up and back. */
const ASIDE: Record<StoreyId, { x: number; y: number; z: number }> = {
  workshop: { x: 0, y: -2.4, z: 2.4 },
  lookout: { x: 0, y: 2.4, z: -2.4 },
};
/** A storey aside is dimmed to this much of its light. */
export const ASIDE_DIM = 0.35;

/** Whether a storey stands aside under a focus. */
export const asideUnder = (focus: StoreyFocus, storey: StoreyId): boolean =>
  focus !== "both" && focus !== storey;

export interface StoreyPose {
  offset: { x: number; y: number; z: number };
  /** 1 in place, `ASIDE_DIM` aside. */
  light: number;
  /** Its figures show (it's focused or both are). */
  crew: boolean;
}

export class StoreyRig {
  private focus: StoreyFocus = "both";
  /** 0 in place, 1 aside, per storey. */
  private k: Record<StoreyId, number> = { workshop: 0, lookout: 0 };
  private from: Record<StoreyId, number> = { workshop: 0, lookout: 0 };
  private since = Number.NEGATIVE_INFINITY;

  get current(): StoreyFocus {
    return this.focus;
  }

  /** Focuses a storey (or both) at `t`. */
  set(focus: StoreyFocus, t: number, reduced: boolean): void {
    if (focus === this.focus) return;
    this.focus = focus;
    this.from = { ...this.k };
    this.since = reduced ? Number.NEGATIVE_INFINITY : t;
  }

  /** Whether a slide is under way at `t`. */
  moving(t: number): boolean {
    return t - this.since < SLIDE_S;
  }

  /** Each storey's pose at `t`. */
  pose(t: number): Record<StoreyId, StoreyPose> {
    const e = easeInOut((t - this.since) / SLIDE_S);
    const out = {} as Record<StoreyId, StoreyPose>;
    for (const id of ["workshop", "lookout"] as const) {
      const goal = asideUnder(this.focus, id) ? 1 : 0;
      this.k[id] = this.from[id] + (goal - this.from[id]) * e;
      const k = this.k[id];
      const a = ASIDE[id];
      out[id] = {
        // `|| 0` keeps a storey in place at exactly 0 (not −0).
        offset: { x: a.x * k || 0, y: a.y * k || 0, z: a.z * k || 0 },
        light: 1 - (1 - ASIDE_DIM) * k,
        crew: goal === 0,
      };
    }
    return out;
  }
}
