import { seeded, type Vec3 } from "./figure-look";

/**
 * The crew's small one-off moments (#476), as pure functions of their age so nothing keeps
 * state between frames: a merge's confetti burst and a failure's puff of smoke (plus a thin
 * wisp now and then while it stays failed). Positions are relative to the figure's tip.
 */

export const CONFETTI_S = 1.4;
const CONFETTI_N = 14;
const GRAVITY = -2.4;

export interface Piece {
  at: Vec3;
  spin: number;
  /** Index into the confetti colours. */
  colour: number;
  /** Fades out by shrinking toward the end. */
  scale: number;
}

/** The confetti pieces `age` seconds into a burst. */
export function confettiAt(seed: string, age: number): Piece[] {
  if (!(age >= 0 && age < CONFETTI_S)) return [];
  const out: Piece[] = [];
  const shrink = age > CONFETTI_S - 0.4 ? (CONFETTI_S - age) / 0.4 : 1;
  for (let i = 0; i < CONFETTI_N; i++) {
    const a = seeded(seed, 200 + i) * Math.PI * 2;
    const speed = 0.35 + seeded(seed, 300 + i) * 0.35;
    const up = 1.1 + seeded(seed, 400 + i) * 0.6;
    out.push({
      at: [
        Math.cos(a) * speed * age,
        up * age + 0.5 * GRAVITY * age * age,
        Math.sin(a) * speed * age,
      ],
      spin: age * (6 + seeded(seed, 500 + i) * 8),
      colour: i % 4,
      scale: shrink,
    });
  }
  return out;
}

export const PUFF_S = 1.6;
/** While failed, a thin wisp rises this often. */
export const WISP_EVERY_S = 6;
const WISP_S = 1.2;

export interface Puff {
  at: Vec3;
  scale: number;
}

/** The smoke `age` seconds after a failure: a puff, then a wisp every few seconds. */
export function smokeAt(seed: string, age: number, phase: number): Puff[] {
  if (!(age >= 0)) return [];
  if (age < PUFF_S) {
    return [0, 1, 2, 3, 4].map((i) => {
      const k = Math.max(0, age - i * 0.08) / PUFF_S;
      const a = seeded(seed, 600 + i) * Math.PI * 2;
      return {
        at: [Math.cos(a) * 0.06 * (1 + k), 0.05 + k * 0.5, Math.sin(a) * 0.06 * (1 + k)],
        // Grows, then shrinks away.
        scale: k <= 0 ? 0 : 0.6 + 1.2 * Math.sin(Math.PI * Math.min(1, k * 1.1)),
      };
    });
  }
  const w = (age + phase * WISP_EVERY_S) % WISP_EVERY_S;
  if (w >= WISP_S) return [];
  const k = w / WISP_S;
  return [{ at: [0.02, 0.06 + k * 0.35, 0], scale: 0.5 * Math.sin(Math.PI * k) }];
}
