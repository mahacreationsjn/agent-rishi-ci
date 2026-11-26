import {
  AdditiveBlending,
  type BufferGeometry,
  Euler,
  Group,
  type Material,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { providerHue, providerTone, type Tone } from "@/components/common/provider-logos";
import { oklchToSrgb, type Rgb } from "@/lib/oklch";
import type { AgentRole } from "../scene/agents";
import { crewGeometry, EYE_Y, type Part, TIP_Y } from "./crew-geometry";
import { CONFETTI_S, confettiAt, smokeAt } from "./crew-moments";
import {
  BLINK_OPEN,
  beaconRing,
  blendPose,
  blockedIcon,
  type FigurePose,
  type FigureStatus,
  POSE_EASE_S,
  phaseOf,
  poseAt,
  seeded,
  type Vec3,
} from "./figure-look";
import type { FigureFrame } from "./frames";
import { colour, Kit, Pool } from "./kit";
import type { FloorPalette } from "./palette";
import { badgeCanvas, shadowCanvas } from "./textures";

/**
 * Floor mode's crew (#420, #476): every agent is the same small figure, toned by its provider,
 * dressed by its role, with a little seeded variation in size, shade and head tilt so each stays
 * recognisable. Its status shows on the figure itself: the light on its tip, its mouth and its
 * pose (see `figure-look.ts`). Every part is one instanced mesh refilled each frame, so the crew
 * costs the same few draw calls however many agents there are.
 */

/** Agents without a session yet: a neutral clay. */
const NO_PROVIDER: Tone = { l: 0.76, c: 0.01, h: 260 };
/** A tip that's off: dull glass. */
const TIP_OFF = oklchToSrgb(0.5, 0.01, 260);
const CONFETTI: Rgb[] = [
  oklchToSrgb(0.76, 0.16, 350),
  oklchToSrgb(0.68, 0.15, 240),
  oklchToSrgb(0.66, 0.2, 25),
  oklchToSrgb(0.72, 0.17, 155),
];

const toneRgb = (t: Tone, dl = 0): Rgb => oklchToSrgb(Math.min(1, Math.max(0, t.l + dl)), t.c, t.h);
const mixRgb = (a: Rgb, b: Rgb, k: number): Rgb => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];

type AccentColour = "accent" | "steel" | "ink";
/** Accessories worn on the body, and ones held in the right hand. */
const WORN: Partial<Record<AgentRole, { part: Part; colour: AccentColour }[]>> = {
  builder: [{ part: "neckerchief", colour: "accent" }],
  reviewer: [{ part: "glasses", colour: "accent" }],
  rebaser: [{ part: "collar", colour: "accent" }],
  integrator: [{ part: "collar", colour: "accent" }],
  pm: [
    { part: "headset", colour: "accent" },
    { part: "mic", colour: "ink" },
  ],
};
const HELD: Partial<Record<AgentRole, { part: Part; colour: AccentColour }[]>> = {
  rebaser: [{ part: "wrench", colour: "steel" }],
  integrator: [{ part: "wrench", colour: "steel" }],
  scout: [{ part: "spyglass", colour: "accent" }],
  area: [{ part: "magnifier", colour: "accent" }],
};

/** What the crew remembers per figure between frames. */
interface Memory {
  status: FigureStatus;
  /** When the status began, on the stage's clock; minus infinity for the first scene's. */
  since: number;
  selectedAt: number;
  /** The pose at the change, to ease from. */
  from: FigurePose | null;
  last: FigurePose | null;
  tone: Rgb;
  feet: Rgb;
  size: number;
  tilt: number;
}

export interface CrewFrame {
  /** Now, in seconds. */
  t: number;
  reduced: boolean;
  /** The factory is stopped: everyone stands still at their post. */
  still: boolean;
  selected: string | null;
  /** Crates riding out of the dock door. */
  crates: readonly { x: number; y: number; z: number; scale: number }[];
}

export class Crew {
  readonly group = new Group();
  private readonly kit = new Kit();
  private readonly geo = crewGeometry();
  private readonly pools = new Map<string, Pool>();
  private readonly badges = new Map<string, Material>();
  private readonly memory = new Map<string, Memory>();
  private readonly anchors = new Map<string, Vector3>();
  private primed = false;
  private palette: FloorPalette | null = null;
  private readonly m = {
    clay: this.kit.matte(null),
    ink: this.kit.matte(null, { roughness: 0.5 }),
    tip: this.kit.own(new MeshBasicMaterial()),
    white: this.kit.own(new MeshBasicMaterial({ color: 0xffffff })),
    halo: this.kit.own(
      new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }),
    ),
    smoke: this.kit.matte(null, { transparent: true, opacity: 0.8, roughness: 1 }),
    ring: this.kit.own(
      new MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
    ),
    lens: this.kit.own(
      new MeshStandardMaterial({
        transparent: true,
        opacity: 0.4,
        roughness: 0.1,
        depthWrite: false,
      }),
    ),
    shadow: this.kit.own(
      new MeshBasicMaterial({
        color: 0x000000,
        map: this.kit.canvasTexture(shadowCanvas()),
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    ),
  };

  constructor() {
    for (const g of Object.values(this.geo)) this.kit.own(g as BufferGeometry);
  }

  /** The pool for a part in a material; made on first use. */
  private pool(
    part: Part,
    material: Material,
    opts: { colours?: boolean; cast?: boolean; order?: number } = {},
    key: string = part,
  ): Pool {
    let p = this.pools.get(key);
    if (!p) {
      p = new Pool(this.group, this.geo[part], material, opts);
      this.pools.set(key, p);
    }
    return p;
  }

  setPalette(p: FloorPalette): void {
    this.palette = p;
    this.m.ink.color = colour(p.ink);
    this.m.ring.color = colour(p.lane);
    this.m.smoke.color = colour(p.dark ? [0.62, 0.64, 0.68] : [0.55, 0.56, 0.6]);
    this.m.lens.color = colour(p.glass);
  }

  /** Marks `key` selected now: it hops. */
  select(key: string, t: number): void {
    const mem = this.memory.get(key);
    if (mem) mem.selectedAt = t;
  }

  /** Where a figure's feet are this frame (with its step aside and hop), for its tag and card. */
  anchor(key: string): Vector3 | undefined {
    return this.anchors.get(key);
  }

  private remember(f: FigureFrame, t: number): Memory {
    let mem = this.memory.get(f.key);
    if (!mem) {
      const seed = f.agent.seed;
      const tone = f.agent.providerId ? providerTone(f.agent.providerId) : NO_PROVIDER;
      const dl = (seeded(seed, 3) - 0.5) * 0.08;
      mem = {
        status: f.status,
        since: this.primed ? t : Number.NEGATIVE_INFINITY,
        selectedAt: Number.NEGATIVE_INFINITY,
        from: null,
        last: null,
        tone: toneRgb(tone, dl),
        feet: toneRgb(tone, dl - 0.12),
        size: 0.96 + seeded(seed, 1) * 0.08,
        tilt: ((seeded(seed, 2) - 0.5) * 8 * Math.PI) / 180,
      };
      this.memory.set(f.key, mem);
    } else if (mem.status !== f.status) {
      mem.from = mem.last;
      mem.status = f.status;
      mem.since = t;
    }
    return mem;
  }

  /** Whether anything moves at `t`: loops while not reduced or stopped, and moments. */
  animating(frames: readonly FigureFrame[], ctx: CrewFrame): boolean {
    return frames.length > 0 && !ctx.reduced && !ctx.still;
  }

  /** Places every figure for this frame. */
  draw(frames: readonly FigureFrame[], ctx: CrewFrame): void {
    const p = this.palette;
    if (!p) return;
    for (const pool of this.pools.values()) pool.begin();
    this.anchors.clear();
    const keys = new Set<string>();
    for (const f of frames) {
      keys.add(f.key);
      this.figure(f, ctx, p);
    }
    for (const c of ctx.crates) {
      const s = 1.35 * c.scale;
      this.pool("crate", this.m.clay, { colours: true, cast: true }).push(
        new Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new Matrix4().makeScale(s, s, s)),
        p.wood,
      );
    }
    for (const pool of this.pools.values()) pool.end();
    for (const key of this.memory.keys()) if (!keys.has(key)) this.memory.delete(key);
    this.primed = true;
  }

  private figure(f: FigureFrame, ctx: CrewFrame, p: FloorPalette): void {
    const { t } = ctx;
    const mem = this.remember(f, t);
    const still = ctx.still || ctx.reduced;
    // A celebration shows as a merge's hop and confetti, from when it began.
    const status = f.celebrateAt !== null ? "done" : f.status;
    const since = f.celebrateAt ?? mem.since;
    let pose = poseAt({
      status,
      seed: f.agent.seed,
      t,
      since,
      selectedAt: mem.selectedAt,
      still: ctx.still,
      reduced: ctx.reduced,
      desk: f.desk && f.stride === null,
    });
    if (mem.from && !still && t - mem.since < POSE_EASE_S)
      pose = blendPose(mem.from, pose, (t - mem.since) / POSE_EASE_S);
    pose = this.moving(f, pose, t);
    mem.last = pose;

    const s = mem.size;
    const base = new Matrix4()
      .makeTranslation(f.x, f.y, f.z)
      .multiply(new Matrix4().makeRotationY(f.facing))
      .multiply(new Matrix4().makeTranslation(pose.step.x, 0, pose.step.z));
    this.anchors.set(f.key, new Vector3().setFromMatrixPosition(base));
    const lifted = base.clone().multiply(new Matrix4().makeTranslation(0, pose.lift, 0));
    const lower = lifted.clone().multiply(new Matrix4().makeScale(s, s, s));
    const upper = lifted
      .clone()
      .multiply(new Matrix4().makeRotationX(pose.lean))
      .multiply(new Matrix4().makeRotationZ(pose.roll + mem.tilt))
      .multiply(new Matrix4().makeTranslation(pose.shift, 0, 0))
      .multiply(new Matrix4().makeScale(s, s * pose.breath, s));
    const atLocal = (m: Matrix4, v: Vec3) =>
      m.clone().multiply(new Matrix4().makeTranslation(...v));

    if (ctx.selected === f.key && !f.ghost) this.pool("ring", this.m.ring, { order: 1 }).push(base);
    const shrink = Math.max(0.6, 1 - pose.lift * 2.5);
    this.pool("shadow", this.m.shadow).push(
      base.clone().multiply(new Matrix4().makeScale(s * shrink, 1, s * shrink)),
    );
    const feet = this.pool("foot", this.m.clay, { colours: true, cast: true });
    pose.feet.forEach((lift, i) => {
      feet.push(atLocal(lower, [i === 0 ? -0.1 : 0.1, 0.035 + lift, 0.04]), mem.feet);
    });
    this.pool("body", this.m.clay, { colours: true, cast: true }).push(upper, mem.tone);
    const hands = this.pool("hand", this.m.clay, { colours: true, cast: true });
    hands.push(atLocal(upper, pose.handL), mem.tone);
    hands.push(atLocal(upper, pose.handR), mem.tone);

    // The face: eyes squash toward their centre to blink; the catchlights hide meanwhile.
    const eyes = atLocal(upper, [0, EYE_Y + pose.eyes.up, 0])
      .multiply(new Matrix4().makeScale(1, pose.eyes.open, 1))
      .multiply(new Matrix4().makeTranslation(0, -EYE_Y, 0));
    this.pool("eyes", this.m.ink).push(eyes);
    if (pose.eyes.open > BLINK_OPEN) this.pool("catchlights", this.m.white).push(eyes);
    this.pool(`mouth:${pose.mouth}`, this.m.ink).push(upper);

    const glow = pose.tip.glow;
    this.pool("tip", this.m.tip, { colours: true }).push(
      upper,
      mixRgb(mixRgb(TIP_OFF, pose.tip.colour, 0.18), pose.tip.colour, glow),
    );
    const accent = p.accent[f.agent.role];
    this.pool("rim", this.m.clay, { colours: true }).push(upper, accent);
    const providerKey = f.agent.providerId ?? "";
    this.pool("badge", this.badge(providerKey, f.agent.provider), {}, `badge:${providerKey}`).push(
      upper,
    );

    const tint = (c: AccentColour) => (c === "accent" ? accent : c === "steel" ? p.steel : p.ink);
    for (const a of WORN[f.agent.role] ?? [])
      this.pool(a.part, this.m.clay, { colours: true, cast: true }).push(upper, tint(a.colour));
    const inHand = atLocal(upper, pose.handR);
    if (!f.carry)
      for (const a of HELD[f.agent.role] ?? []) {
        this.pool(a.part, this.m.clay, { colours: true, cast: true }).push(inHand, tint(a.colour));
        if (a.part === "magnifier") this.pool("lens", this.m.lens, { order: 2 }).push(inHand);
      }

    this.extras(f, status, since, pose, upper, ctx, p);
  }

  /** Walking, carrying and stamping change the pose a figure's status gives it. */
  private moving(f: FigureFrame, pose: FigurePose, t: number): FigurePose {
    if (f.stride === null && !f.stamping && !f.carry) return pose;
    // A failed agent trudges, still slumped a little.
    const lean = f.status === "failed" ? pose.lean * 0.6 : 0;
    const out: FigurePose = { ...pose, step: { x: 0, z: 0 }, lean, roll: 0, shift: 0 };
    if (f.stride !== null) {
      // Feet alternate with a small lift; the body bobs twice a stride.
      const a = Math.sin(f.stride * Math.PI * 2);
      out.feet = [0.02 * Math.max(0, a), 0.02 * Math.max(0, -a)];
      out.lift = pose.lift + 0.015 * Math.abs(a);
      out.handL = [-0.215, 0.22, 0.03 - 0.04 * a];
      out.handR = [0.215, 0.22, 0.03 + 0.04 * a];
    }
    if (f.carry || f.stamping) {
      out.handL = [-0.13, 0.3, 0.22];
      out.handR = [0.13, 0.3, 0.22];
    }
    if (f.stamping) out.handR = [0.07, 0.4 + 0.05 * Math.abs(Math.sin(t * Math.PI * 3)), 0.3];
    return out;
  }

  /** The status extras around a figure and its moments. */
  private extras(
    f: FigureFrame,
    status: FigureStatus,
    since: number,
    pose: FigurePose,
    upper: Matrix4,
    ctx: CrewFrame,
    p: FloorPalette,
  ): void {
    const { t } = ctx;
    const loops = !ctx.reduced && !ctx.still;
    const phase = phaseOf(f.agent.seed);
    const tip = upper.clone().multiply(new Matrix4().makeTranslation(0, TIP_Y, 0));
    const at = (m: Matrix4, v: Vec3) => m.clone().multiply(new Matrix4().makeTranslation(...v));
    const age = t - since;
    const carried = f.carry ?? (f.stamping ? "crate" : null);
    if (carried)
      this.pool(carried, this.m.clay, { colours: true, cast: true }).push(
        at(upper, carried === "crate" ? [0, 0.32, 0.27] : [0, 0.31, 0.24]),
        carried === "crate" ? p.wood : p.paper,
      );
    switch (status) {
      case "thinking": {
        const spin = loops ? ((t / 2.4 + phase) % 1) * Math.PI * 2 : 0;
        this.pool("dots", this.m.ink).push(tip.clone().multiply(new Matrix4().makeRotationY(spin)));
        break;
      }
      case "approval": {
        if (!loops) break;
        const k = beaconRing(t, phase);
        this.pool("halo", this.m.halo, { colours: true, order: 3 }).push(
          tip.clone().multiply(new Matrix4().makeScale(1 + 1.8 * k, 1, 1 + 1.8 * k)),
          mixRgb([0, 0, 0], pose.tip.colour, (1 - k) * 0.9),
        );
        break;
      }
      case "blocked": {
        const icon = blockedIcon(f.agent.blockedOn);
        if (icon)
          this.pool(`icon:${icon}`, this.m.clay, { colours: true }).push(
            at(upper, [0.17, TIP_Y - 0.02, 0.04]),
            p.dark ? p.paper : p.ink,
          );
        break;
      }
      case "failed":
        if (loops)
          for (const puff of smokeAt(f.agent.seed, age, phase))
            if (puff.scale > 0)
              this.pool("puff", this.m.smoke).push(
                at(tip, puff.at).multiply(
                  new Matrix4().makeScale(puff.scale, puff.scale, puff.scale),
                ),
              );
        break;
      case "done":
        if (loops && age < CONFETTI_S)
          for (const piece of confettiAt(f.agent.seed, age))
            this.pool("confetti", this.m.clay, { colours: true }).push(
              at(tip, piece.at)
                .multiply(new Matrix4().makeRotationFromEuler(eulerOf(piece.spin)))
                .multiply(new Matrix4().makeScale(piece.scale, piece.scale, piece.scale)),
              CONFETTI[piece.colour],
            );
        break;
      case "idle":
        if (!carried)
          this.pool("mug", this.m.clay, { colours: true, cast: true }).push(
            at(upper, pose.handR),
            p.paper,
          );
        break;
      default:
        break;
    }
  }

  private badge(providerId: string, name: string | null): Material {
    const cached = this.badges.get(providerId);
    if (cached) return cached;
    const map = this.kit.canvasTexture(
      badgeCanvas(providerId || null, name, providerHue(providerId)),
    );
    const material = this.kit.own(new MeshStandardMaterial({ map, roughness: 0.55 }));
    this.badges.set(providerId, material);
    return material;
  }

  dispose(): void {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
    this.group.clear();
    this.kit.dispose();
    this.badges.clear();
    this.memory.clear();
  }
}

const spinEuler = new Euler();
const eulerOf = (spin: number) => spinEuler.set(spin, spin * 0.7, spin * 0.3);
