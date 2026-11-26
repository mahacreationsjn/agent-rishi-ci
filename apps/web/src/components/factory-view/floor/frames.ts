import type { SceneAgent } from "../scene/agents";
import type { FigureStatus } from "./figure-look";

/**
 * One figure to draw this frame (#476): an agent at its post or walking, or a departed agent
 * acting out its exit (a ghost: no tag, card or bubble). Where its feet are and what it does;
 * the crew turns this into a pose and matrices.
 */
export interface FigureFrame {
  key: string;
  agent: SceneAgent;
  status: FigureStatus;
  ghost: boolean;
  /** Its feet, in world units. */
  x: number;
  y: number;
  z: number;
  /** Turn around y; 0 faces +z (the front of the hall). */
  facing: number;
  /** A desk in front of it, with room beside it to step out to. */
  desk: boolean;
  /** Walking: how far through its stride (0..1 per tile), else null. */
  stride: number | null;
  carry: "crate" | "ticket" | null;
  /** Stamping the crate it hands to the merge queue. */
  stamping: boolean;
  /** When it began to celebrate a merge (a hop and confetti), else null. */
  celebrateAt: number | null;
}

/** A figure standing at a point, as most are most of the time. */
export function standing(
  agent: SceneAgent,
  status: FigureStatus,
  at: { x: number; y: number; z: number },
  desk: boolean,
): FigureFrame {
  return {
    key: agent.key,
    agent,
    status,
    ghost: false,
    ...at,
    facing: 0,
    desk,
    stride: null,
    carry: null,
    stamping: false,
    celebrateAt: null,
  };
}
