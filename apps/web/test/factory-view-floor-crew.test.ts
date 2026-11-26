import { describe, expect, it } from "vitest";
import { CameraRig } from "@/components/factory-view/floor/camera";
import { confettiAt, smokeAt } from "@/components/factory-view/floor/crew-moments";
import {
  BLINK_OPEN,
  blinkAt,
  blinkStart,
  blockedIcon,
  FIGURE_STATUSES,
  type FigureStatus,
  figureStatus,
  phaseOf,
  poseAt,
  STATUS_LOOK,
  STEP_OUT,
  TAG_MIN_PX,
  tagVisible,
  tipColour,
  tipGlow,
} from "@/components/factory-view/floor/figure-look";
import { pickFigure, rayAt, screenAnchor } from "@/components/factory-view/floor/screen";
import { tagOf } from "@/components/factory-view/floor/tags";
import type { SceneAgent } from "@/components/factory-view/scene/agents";
import { oklchToSrgb } from "@/lib/oklch";

/**
 * Issue #476: each crew figure shows its status by its tip light, mouth and pose; loops are
 * offset per figure; tags hide when zoomed out except where someone must act; bubbles sit at the
 * figure's projected head; a pointer picks the figure under it.
 */

const agent = (patch: Partial<SceneAgent> = {}): SceneAgent => ({
  key: "item:a:builder",
  role: "builder",
  sessionId: "s1",
  card: null,
  step: "implementing",
  activity: null,
  status: "working",
  blockedOn: null,
  failed: false,
  provider: "Claude Code",
  providerId: "claude",
  model: "opus",
  progress: null,
  since: null,
  seed: "s1",
  area: null,
  ...patch,
});

const pose = (status: FigureStatus, patch: Partial<Parameters<typeof poseAt>[0]> = {}) =>
  poseAt({
    status,
    seed: "s1",
    t: 100,
    since: Number.NEGATIVE_INFINITY,
    selectedAt: Number.NEGATIVE_INFINITY,
    still: false,
    reduced: false,
    desk: true,
    ...patch,
  });

describe("figure status (#476)", () => {
  it("maps the scene's statuses and a failure to the seven figure statuses", () => {
    expect(figureStatus(agent())).toBe("working");
    expect(figureStatus(agent({ status: "blocked", failed: true }))).toBe("failed");
    expect(figureStatus(agent({ status: "approval" }))).toBe("approval");
    // A merge wins over a failure flag.
    expect(figureStatus(agent({ status: "done", failed: true }))).toBe("done");
    expect(figureStatus(agent({ status: "idle", role: "pm" }))).toBe("idle");
  });

  it("gives every status its own look: tip colour, mouth and pose", () => {
    const looks = FIGURE_STATUSES.map((s) => {
      const p = pose(s);
      return JSON.stringify([STATUS_LOOK[s].tipMode, p.mouth, STATUS_LOOK[s].pose]);
    });
    expect(new Set(looks).size).toBe(7);
    expect(tipColour("working")).toEqual(oklchToSrgb(0.72, 0.17, 155));
    expect(tipColour("approval")).toEqual(oklchToSrgb(0.76, 0.16, 350));
    expect(tipColour("failed")).toEqual(oklchToSrgb(0.65, 0.2, 25));
    expect(pose("approval").mouth).toBe("o");
    expect(pose("failed").mouth).toBe("frown");
    expect(pose("done").mouth).toBe("wide-smile");
  });

  it("poses: working leans in and types, approval steps aside with a hand high, failed slumps", () => {
    const w = pose("working");
    expect(w.lean).toBeCloseTo((4 * Math.PI) / 180);
    expect(w.handL[2]).toBeGreaterThan(0.25);
    const a = pose("approval");
    expect(a.step).toEqual(STEP_OUT);
    expect(a.handR[1]).toBeGreaterThan(0.7);
    expect(pose("approval", { desk: false }).step).toEqual({ x: 0, z: 0 });
    expect(pose("failed").lean).toBeCloseTo((12 * Math.PI) / 180);
    expect(pose("blocked").lean).toBeLessThan(0);
    expect(pose("thinking").eyes.up).toBeCloseTo(0.01);
  });

  it("tip lights: dim when blocked, 30% when idle, out once a failure's flicker ends", () => {
    expect(tipGlow("blocked", 5, 0, 0, false)).toBeCloseTo(0.32);
    expect(tipGlow("idle", 5, 0, 0, false)).toBeCloseTo(0.3);
    expect(tipGlow("failed", 5, 0, 0, false)).toBe(0);
    expect(tipGlow("failed", 0.3, 0, 0, false)).toBeGreaterThan(0);
    // A merge flashes green, then goes off.
    expect(tipGlow("done", 0.5, 0, 0, false)).toBe(1);
    expect(tipGlow("done", 3, 0, 0, false)).toBe(0);
    // Statuses already showing when the view opened play no moment.
    expect(tipGlow("done", 0.5, Number.NEGATIVE_INFINITY, 0, false)).toBe(0);
    // Approval pulses once a second.
    expect(tipGlow("approval", 0, 0, 0, false)).toBeCloseTo(1);
    expect(tipGlow("approval", 0.5, 0, 0, false)).toBeCloseTo(0.55);
    expect(tipGlow("approval", 1, 0, 0, false)).toBeCloseTo(1);
  });

  it("reduced motion: no loops, no hops, steady tips and moments that change at once", () => {
    for (const s of FIGURE_STATUSES) {
      const a = pose(s, { reduced: true, t: 1, since: 0.9, selectedAt: 0.95 });
      const b = pose(s, { reduced: true, t: 2.3, since: 0.9, selectedAt: 0.95 });
      expect(a).toEqual(b);
      expect(a.lift).toBe(0);
      expect(a.breath).toBe(1);
      expect(a.eyes.open).toBe(1);
    }
    expect(tipGlow("failed", 0.3, 0, 0, true)).toBe(0);
    expect(tipGlow("done", 0.5, 0, 0, true)).toBe(0);
    expect(confettiAt("s1", 0.5).length).toBeGreaterThan(0);
  });

  it("a merge hops on both feet and bursts confetti once; a failure puffs smoke", () => {
    const hop = pose("done", { since: 99.8 });
    expect(hop.lift).toBeGreaterThan(0.05);
    expect(pose("done", { since: 90 }).lift).toBe(0);
    expect(confettiAt("s1", 2)).toEqual([]);
    expect(smokeAt("s1", 0.4, 0).length).toBe(5);
    // A selected figure hops a little.
    expect(pose("working", { selectedAt: 99.85 }).lift).toBeGreaterThan(0);
  });

  it("names the icon by a blocked figure's tip after what it waits on", () => {
    expect(blockedIcon("ci")).toBe("hourglass");
    expect(blockedIcon("conflicts")).toBe("cable");
    expect(blockedIcon("turn")).toBe("ticket");
    expect(blockedIcon("person")).toBe("person");
    expect(blockedIcon("agent")).toBe("chair");
    expect(blockedIcon("cut_off")).toBeNull();
  });
});

describe("loops and phases (#476)", () => {
  it("offsets each figure's loops by a phase from its seed, so figures never move in step", () => {
    expect(phaseOf("s1")).toBe(phaseOf("s1"));
    const phases = Array.from({ length: 40 }, (_, i) => phaseOf(`session-${i}`));
    for (const p of phases) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
    expect(new Set(phases).size).toBe(40);
    // Two figures in the same state at the same moment breathe differently.
    expect(pose("idle", { seed: "a" }).breath).not.toBe(pose("idle", { seed: "b" }).breath);
  });

  it("blinks for 100 ms every 3 to 6 seconds, squashing the eyes to 10%", () => {
    for (const seed of ["a", "b", "s1", "session-7"]) {
      for (let k = 0; k < 30; k++) {
        const gap = blinkStart(seed, k + 1) - blinkStart(seed, k);
        expect(gap).toBeGreaterThanOrEqual(3);
        expect(gap).toBeLessThanOrEqual(6);
      }
      const start = blinkStart(seed, 4);
      expect(blinkAt(seed, start + 0.05)).toBe(true);
      expect(blinkAt(seed, start + 0.15)).toBe(false);
      expect(pose("working", { seed, t: start + 0.05 }).eyes.open).toBe(BLINK_OPEN);
    }
  });

  it("breathes between 1 and 1.02, with no squash below 1", () => {
    for (let t = 0; t < 5; t += 0.1) {
      const b = pose("working", { t }).breath;
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(1.02 + 1e-9);
    }
  });
});

describe("name tags (#476)", () => {
  it("show the issue number and a glyph for the step, or the role", () => {
    const card = { item: { issue: { number: 142 }, pr: null, ownedPr: null } } as never;
    expect(tagOf(agent({ card, step: "reviewing" }))).toEqual({ text: "#142", glyph: "reviewing" });
    expect(tagOf(agent({ role: "pm", card: null }))).toEqual({ text: "PM", glyph: "pm" });
    expect(tagOf(agent({ role: "area", area: "security", card: null })).glyph).toBe("area");
  });

  it("hide when zoomed out, except on agents waiting on approval or failed", () => {
    expect(tagVisible("working", TAG_MIN_PX)).toBe(true);
    expect(tagVisible("working", TAG_MIN_PX - 1)).toBe(false);
    expect(tagVisible("approval", 10)).toBe(true);
    expect(tagVisible("failed", 10)).toBe(true);
    expect(tagVisible("done", 10)).toBe(false);
  });
});

describe("bubble anchors and picking (#476)", () => {
  const rig = () => {
    const r = new CameraRig();
    r.setViewport(800, 600);
    r.setScene({ x0: 0, x1: 10, z0: -6, z1: 0 }, 1.6);
    r.fit(false);
    return r;
  };

  it("projects a figure's head straight above its feet, by its height on screen", () => {
    const r = rig();
    const view = { width: 800, height: 600 };
    const foot = screenAnchor(r.camera, view, { x: 5, y: 0, z: -3 });
    const head = screenAnchor(r.camera, view, { x: 5, y: 0.75, z: -3 });
    expect(head.x).toBeCloseTo(foot.x, 3);
    // The camera looks 30° down: a height shows at cos 30° of it.
    expect(foot.y - head.y).toBeCloseTo(0.75 * Math.cos(Math.PI / 6) * r.pxPerUnit(), 3);
    expect(foot.inView).toBe(true);
    expect(screenAnchor(r.camera, view, { x: 500, y: 0, z: 0 }).inView).toBe(false);
  });

  it("puts the hall's centre in the middle of the canvas", () => {
    const r = rig();
    const view = { width: 800, height: 600 };
    const centre = screenAnchor(r.camera, view, { x: 5, y: 0.8, z: -3 });
    expect(centre.x).toBeCloseTo(400, 0);
    expect(centre.y).toBeCloseTo(300, 0);
  });

  it("picks the figure under the pointer, the nearest when two overlap", () => {
    const r = rig();
    const view = { width: 800, height: 600 };
    const a = { key: "a", x: 3, y: 0, z: -3 };
    const b = { key: "b", x: 7, y: 0, z: -2 };
    const at = (p: typeof a) => screenAnchor(r.camera, view, { ...p, y: 0.4 });
    const pa = at(a);
    expect(pickFigure(rayAt(r.camera, view, pa.x, pa.y), [a, b])).toBe("a");
    const pb = at(b);
    expect(pickFigure(rayAt(r.camera, view, pb.x, pb.y), [a, b])).toBe("b");
    expect(pickFigure(rayAt(r.camera, view, 2, 2), [a, b])).toBeNull();
    // One figure right behind another: the front one (nearer the camera) wins.
    const behind = { key: "behind", x: 3 - 0.2, y: 0, z: -3 - 0.2 };
    expect(pickFigure(rayAt(r.camera, view, pa.x, pa.y), [behind, a])).toBe("a");
  });

  it("flies to a selected figure over about 1.5 s, or cuts with reduced motion", () => {
    const r = rig();
    const view = { width: 800, height: 600 };
    r.flyTo({ x: 2, y: 0.35, z: -1 });
    expect(r.moving).toBe(true);
    for (let i = 0; i < 89; i++) r.step(1 / 60);
    expect(r.moving).toBe(true);
    r.step(2 / 60);
    expect(r.moving).toBe(false);
    const p = screenAnchor(r.camera, view, { x: 2, y: 0.35, z: -1 });
    expect(p.x).toBeCloseTo(400, 0);
    const cut = rig();
    cut.reduced = true;
    cut.flyTo({ x: 2, y: 0.35, z: -1 });
    expect(cut.moving).toBe(false);
  });
});
