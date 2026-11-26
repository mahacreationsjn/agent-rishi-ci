import { oklchToSrgb, type Rgb } from "@/lib/oklch";
import type { BlockedOn, SceneAgent } from "../scene/agents";

/**
 * How a crew figure shows its state (#476): the light on its tip, its mouth and its pose for
 * each of the seven statuses, and the small loops that keep it alive (breath, sway, blinking,
 * typing). All motion is procedural and sine-based, offset per figure by a phase from its seed
 * so neighbours never move in step; nothing squashes or wobbles. Pure: time comes in as seconds
 * on one clock, so every rule here is unit-tested and the crew only turns poses into matrices.
 */

/** The figure's status: the scene's six plus `failed` (its session or item failed). */
export type FigureStatus =
  | "working"
  | "thinking"
  | "approval"
  | "blocked"
  | "failed"
  | "done"
  | "idle";

export const FIGURE_STATUSES: readonly FigureStatus[] = [
  "working",
  "thinking",
  "approval",
  "blocked",
  "failed",
  "done",
  "idle",
];

export type Mouth = "smile" | "flat-short" | "o" | "flat" | "frown" | "wide-smile";
export type PoseName = "type" | "chin" | "raise" | "lean-back" | "slump" | "hop" | "mug";
/** How the tip light behaves over time. */
export type TipMode = "pulse" | "breathe" | "beacon" | "dim" | "flicker-out" | "flash-off" | "low";

export interface StatusLook {
  /** The tip light's colour when lit, as OKLCH. */
  tip: { l: number; c: number; h: number };
  tipMode: TipMode;
  mouth: Mouth;
  pose: PoseName;
}

/** The table in #476, one row per status. */
export const STATUS_LOOK: Record<FigureStatus, StatusLook> = {
  working: { tip: { l: 0.72, c: 0.17, h: 155 }, tipMode: "pulse", mouth: "smile", pose: "type" },
  thinking: {
    tip: { l: 0.72, c: 0.13, h: 230 },
    tipMode: "breathe",
    mouth: "flat-short",
    pose: "chin",
  },
  approval: { tip: { l: 0.76, c: 0.16, h: 350 }, tipMode: "beacon", mouth: "o", pose: "raise" },
  blocked: { tip: { l: 0.62, c: 0.03, h: 260 }, tipMode: "dim", mouth: "flat", pose: "lean-back" },
  failed: {
    tip: { l: 0.65, c: 0.2, h: 25 },
    tipMode: "flicker-out",
    mouth: "frown",
    pose: "slump",
  },
  done: {
    tip: { l: 0.72, c: 0.17, h: 155 },
    tipMode: "flash-off",
    mouth: "wide-smile",
    pose: "hop",
  },
  idle: { tip: { l: 0.85, c: 0.02, h: 80 }, tipMode: "low", mouth: "smile", pose: "mug" },
};

/** An agent's figure status: failed wins over everything but a merge. */
export function figureStatus(a: Pick<SceneAgent, "status" | "failed">): FigureStatus {
  if (a.failed && a.status !== "done") return "failed";
  return a.status;
}

/** The tip's lit colour for a status, in sRGB. */
export function tipColour(status: FigureStatus): Rgb {
  const { l, c, h } = STATUS_LOOK[status].tip;
  return oklchToSrgb(l, c, h);
}

/** The small icon by a blocked figure's tip, by what it waits on; none for the others. */
export type BlockedIcon = "hourglass" | "cable" | "ticket" | "person" | "chair";

export function blockedIcon(on: BlockedOn | null): BlockedIcon | null {
  switch (on) {
    case "ci":
      return "hourglass";
    case "conflicts":
      return "cable";
    case "turn":
      return "ticket";
    case "person":
      return "person";
    case "agent":
      return "chair";
    default:
      return null;
  }
}

/** A repeatable number in 0..1 per seed and channel (FNV-1a with a final mix). */
export function seeded(seed: string, channel: number): number {
  let h = 2166136261 ^ channel;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The phase (0..1) that offsets all of a figure's loops, from its seed. */
export const phaseOf = (seed: string): number => seeded(seed, 11);

/** Breath: scale y from 1 to 1.02 and back over 2.4 s. */
export const BREATH_S = 2.4;
/** Sway: ±2° around z over 4 s. */
export const SWAY_S = 4;
const SWAY_RAD = (2 * Math.PI) / 180;
/** Blinks come every 3 to 6 s: one per slot of 4.5 s, at a seeded offset in its first 1.5 s. */
const BLINK_SLOT = 4.5;
const BLINK_JITTER = 1.5;
export const BLINK_S = 0.1;
/** Eyes squash to this much of their height in a blink. */
export const BLINK_OPEN = 0.1;

const wave = (t: number, period: number, phase: number) =>
  Math.sin(2 * Math.PI * (t / period + phase));

/** When the blink of slot `k` starts. */
export function blinkStart(seed: string, k: number): number {
  return k * BLINK_SLOT + seeded(seed, 1000 + k) * BLINK_JITTER + phaseOf(seed) * BLINK_SLOT;
}

/** Whether the figure blinks at `t`. Consecutive blinks are 3 to 6 s apart. */
export function blinkAt(seed: string, t: number): boolean {
  const k = Math.floor((t - phaseOf(seed) * BLINK_SLOT) / BLINK_SLOT);
  const start = blinkStart(seed, k);
  return t >= start && t < start + BLINK_S;
}

/** Breath's y scale at `t`: 1..1.02. */
export function breathAt(t: number, phase: number): number {
  return 1 + 0.01 * (1 - Math.cos(2 * Math.PI * (t / BREATH_S + phase)));
}

/** Sway's roll at `t`: ±2°. */
export const swayAt = (t: number, phase: number): number => SWAY_RAD * wave(t, SWAY_S, phase);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};

/** How long the one-off tip moments last: a failure's flicker, a merge's flash. */
export const FLICKER_S = 1.2;
export const FLASH_S = 1.4;

/**
 * The tip light's strength (0 off, 1 full) at `t`, for a status that began at `since` (minus
 * infinity for one already showing when the view opened, so no moment replays). With reduced
 * motion it is the status's steady value.
 */
export function tipGlow(
  status: FigureStatus,
  t: number,
  since: number,
  phase: number,
  reduced: boolean,
): number {
  const mode = STATUS_LOOK[status].tipMode;
  const age = t - since;
  switch (mode) {
    case "pulse": {
      if (reduced) return 0.9;
      // Steady, with a soft swell every 2 s.
      const k = (t / 2 + phase) % 1;
      return 0.82 + 0.18 * Math.exp(-(((k - 0.15) / 0.12) ** 2));
    }
    case "breathe":
      return reduced ? 0.7 : 0.45 + 0.4 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t / 3 + phase)));
    case "beacon":
      return reduced ? 1 : 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(2 * Math.PI * (t + phase)));
    case "dim":
      return 0.32;
    case "low":
      return 0.3;
    case "flicker-out": {
      if (reduced || !(age < FLICKER_S)) return 0;
      // A few uneven flickers that die down.
      const on = seeded(String(Math.floor(age * 14)), 7) > 0.4;
      return (on ? 0.95 : 0.15) * (1 - age / FLICKER_S);
    }
    case "flash-off": {
      if (reduced || !(age < FLASH_S)) return 0;
      if (age < 0.2) return smooth(age / 0.2);
      if (age < 0.8) return 1;
      return 1 - smooth((age - 0.8) / (FLASH_S - 0.8));
    }
  }
}

/** The approval beacon's ring at `t`: how far it has spread (0..1), once a second. */
export function beaconRing(t: number, phase: number): number {
  return (t + phase) % 1;
}

export type Vec3 = [number, number, number];

/** Everything the crew needs to place one figure's parts this frame, in its own frame. */
export interface FigurePose {
  /** Lift off the floor (hops), world units. */
  lift: number;
  /** Lean forward (+) or back (−) around x, radians, pivoting at the feet. */
  lean: number;
  /** Roll around z (sway), radians. */
  roll: number;
  /** Weight shift along x. */
  shift: number;
  /** Breath: y scale of the upper body. */
  breath: number;
  /** Stepped aside from its post (approval), in its own x and z. */
  step: { x: number; z: number };
  handL: Vec3;
  handR: Vec3;
  /** Each foot's lift (walking). */
  feet: [number, number];
  /** Eye openness (1 open, 0.1 blinking) and how far they look up. */
  eyes: { open: number; up: number };
  mouth: Mouth;
  tip: { colour: Rgb; glow: number };
}

/** Hands at rest by the body's sides. */
const REST_L: Vec3 = [-0.215, 0.22, 0.03];
const REST_R: Vec3 = [0.215, 0.22, 0.03];

/** Each pose's hands and lean, before loops move them. */
const POSE: Record<PoseName, { lean: number; handL: Vec3; handR: Vec3 }> = {
  // Hands forward over the laptop's keys.
  type: { lean: (4 * Math.PI) / 180, handL: [-0.09, 0.33, 0.33], handR: [0.09, 0.33, 0.33] },
  // One hand to the chin.
  chin: { lean: 0, handL: REST_L, handR: [0.06, 0.31, 0.21] },
  // One hand raised high.
  raise: { lean: 0, handL: REST_L, handR: [0.2, 0.8, 0.02] },
  // Leaning back, hands together in front.
  "lean-back": {
    lean: (-6 * Math.PI) / 180,
    handL: [-0.05, 0.21, 0.21],
    handR: [0.05, 0.21, 0.21],
  },
  // Slumped, hands hanging low.
  slump: { lean: (12 * Math.PI) / 180, handL: [-0.2, 0.15, 0.06], handR: [0.2, 0.15, 0.06] },
  hop: { lean: 0, handL: REST_L, handR: REST_R },
  // Holding a mug in front.
  mug: { lean: 0, handL: REST_L, handR: [0.15, 0.27, 0.17] },
};

/** Hands thrown up in a cheer (a merge's hop). */
const CHEER_L: Vec3 = [-0.24, 0.62, 0.04];
const CHEER_R: Vec3 = [0.24, 0.62, 0.04];

/** Where an approval figure steps to: beside its desk, in the gap to the next one. */
export const STEP_OUT = { x: 0.5, z: -0.05 };

/** The merge's hop and a selection's smaller one: height and length. */
export const DONE_HOP = { h: 0.14, s: 0.55 };
export const SELECT_HOP = { h: 0.07, s: 0.35 };
/** A pose eases into the next over this long when the status changes. */
export const POSE_EASE_S = 0.35;

/** A hop's height at `age` seconds into it (a parabola; nothing squashes). */
export function hopAt(age: number, hop: { h: number; s: number }): number {
  if (!(age >= 0 && age < hop.s)) return 0;
  const k = age / hop.s;
  return hop.h * 4 * k * (1 - k);
}

export interface PoseInput {
  status: FigureStatus;
  seed: string;
  /** Now, in seconds. */
  t: number;
  /** When this status began (minus infinity when it showed at the first scene). */
  since: number;
  /** When it was last selected (minus infinity when never). */
  selectedAt: number;
  /** No loops: the pose without motion. */
  still: boolean;
  reduced: boolean;
  /** It has a desk in front and room beside it to step out to. */
  desk: boolean;
}

/** The figure's pose at `t`. */
export function poseAt(i: PoseInput): FigurePose {
  const look = STATUS_LOOK[i.status];
  const phase = phaseOf(i.seed);
  const moving = !i.reduced && !i.still;
  const t = i.t;
  const base = POSE[look.pose];
  let handL: Vec3 = [...base.handL];
  let handR: Vec3 = [...base.handR];
  let lean = base.lean;
  let roll = 0;
  let shift = 0;
  let lift = 0;
  let step = { x: 0, z: 0 };
  // Typing needs a desk; without one it stands with its hands at its sides.
  if (look.pose === "type" && !i.desk) {
    handL = [...REST_L];
    handR = [...REST_R];
    lean = 0;
  }
  if (look.pose === "raise" && i.desk) step = { ...STEP_OUT };
  if (moving) {
    if (look.pose === "type" && i.desk) {
      // Taps alternate between the hands, five a second in all.
      const s = wave(t, 0.4, phase);
      handL[1] -= 0.025 * Math.max(0, s);
      handR[1] -= 0.025 * Math.max(0, -s);
    }
    if (look.pose === "mug") {
      roll = swayAt(t, phase);
      shift = 0.012 * wave(t, SWAY_S, phase);
    }
    if (look.pose === "raise") {
      // The raised hand waves a little.
      handR[0] += 0.02 * wave(t, 1.2, phase);
    }
    if (look.pose === "hop") {
      const age = t - i.since;
      lift = hopAt(age, DONE_HOP);
      if (lift > 0) {
        handL = [...CHEER_L];
        handR = [...CHEER_R];
      }
    }
    lift = Math.max(lift, hopAt(t - i.selectedAt, SELECT_HOP));
  }
  const blink = moving && blinkAt(i.seed, t);
  return {
    lift,
    lean,
    roll,
    shift,
    breath: moving ? breathAt(t, phase) : 1,
    step,
    handL,
    handR,
    feet: [0, 0],
    eyes: { open: blink ? BLINK_OPEN : 1, up: look.pose === "chin" ? 0.01 : 0 },
    mouth: look.mouth,
    tip: { colour: tipColour(i.status), glow: tipGlow(i.status, t, i.since, phase, i.reduced) },
  };
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mixV = (a: Vec3, b: Vec3, k: number): Vec3 => [
  mix(a[0], b[0], k),
  mix(a[1], b[1], k),
  mix(a[2], b[2], k),
];

/**
 * Eases from the pose a figure had when its status changed toward its new one, over
 * `POSE_EASE_S`; `k` is 0 at the change and 1 once settled. Mouths and the tip switch at once.
 */
export function blendPose(from: FigurePose, to: FigurePose, k: number): FigurePose {
  const e = smooth(k);
  if (e >= 1) return to;
  return {
    ...to,
    lean: mix(from.lean, to.lean, e),
    roll: mix(from.roll, to.roll, e),
    shift: mix(from.shift, to.shift, e),
    step: { x: mix(from.step.x, to.step.x, e), z: mix(from.step.z, to.step.z, e) },
    handL: mixV(from.handL, to.handL, e),
    handR: mixV(from.handR, to.handR, e),
  };
}

/** Name tags show from this zoom up (CSS pixels per world unit), where neighbours' don't touch. */
export const TAG_MIN_PX = 78;

/**
 * Whether a figure's name tag shows: when zoomed in far enough for tags not to crowd, and
 * always on agents that wait on a person's approval or have failed.
 */
export function tagVisible(status: FigureStatus, pxPerUnit: number): boolean {
  return status === "approval" || status === "failed" || pxPerUnit >= TAG_MIN_PX;
}
