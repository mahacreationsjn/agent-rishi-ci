import {
  BoxGeometry,
  CapsuleGeometry,
  Group,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
} from "three";
import { floorSeats, WALL_H, type WorkshopLayout } from "../scene/layout";
import { LOOKOUT_WALL_H, type LookoutLayout, SLAB_H } from "../scene/lookout";
import type { Scene } from "../scene/scene-model";
import { type StoreyFocus, type StoreyId, storeyOf } from "../scene/storeys";
import { sceneEvents } from "../scene/transitions";
import type { Box3D } from "./camera";
import { Crew } from "./crew";
import { occupiedSeats } from "./desk-props";
import { tipColour } from "./figure-look";
import type { FigureFrame } from "./frames";
import { clear, colour, Kit, Pool } from "./kit";
import { dimTree, Lights } from "./lights";
import { buildChute, buildLookout, lookoutKey } from "./lookout";
import { FloorMotion } from "./motion";
import type { FloorPalette } from "./palette";
import { bayCrateSpots, buildProps, propsKey } from "./props";
import { seatFrames } from "./seat-frames";
import { type StoreyPose, StoreyRig } from "./storey-rig";
import { buildWorkshop } from "./workshop";

/**
 * Everything Floor mode shows (#420, #476): the Workshop (its hall and live props), in a dark
 * factory the Lookout storey above it with the filing chute between them, the crew, and the
 * moments they act out. It rebuilds only what changed, and each frame places the crew, slides a
 * storey aside when the other is focused (its figures replaced by windows lit in their status
 * colours), and drops capsules down the chute while the scout files.
 */

export interface WorldContent {
  layout: WorkshopLayout;
  scene: Scene;
  palette: FloorPalette;
  /** The Lookout, in a dark factory. */
  lookout: LookoutLayout | null;
}

/** A capsule takes this long to fall down the chute. */
const CAPSULE_S = 1.1;
/** While the scout files, one drops this often. */
const CAPSULE_EVERY_S = 1.6;
const WINDOW_GAP = 0.34;

export class FloorWorld {
  readonly root = new Group();
  readonly lights = new Lights();
  readonly crew = new Crew();
  private readonly workshop = new Group();
  private readonly hall = new Group();
  private readonly props = new Group();
  private readonly lookoutRoot = new Group();
  private readonly lookout = new Group();
  private readonly chute = new Group();
  private hallKit = new Kit();
  private propsKit = new Kit();
  private lookoutKit = new Kit();
  private chuteKit = new Kit();
  private readonly shared = new Kit();
  private retired: Kit[] = [];
  private readonly unit = this.shared.own(new BoxGeometry(1, 1, 1));
  private readonly windowGeo = this.shared.own(new PlaneGeometry(0.2, 0.15));
  private readonly windowMat = this.shared.own(new MeshBasicMaterial());
  private readonly capsuleGeo = this.shared.own(new CapsuleGeometry(0.07, 0.1, 4, 10));
  private readonly capsuleMat = this.shared.own(new MeshBasicMaterial());
  private readonly windows: Record<StoreyId, Pool>;
  private readonly capsulePool: Pool;
  private keys = { hall: "", props: "", lookout: "" };
  private content: WorldContent | null = null;
  private prevScene: Scene | null = null;
  readonly motion = new FloorMotion();
  readonly storeys = new StoreyRig();
  private shipping = 0;
  private capsules: number[] = [];
  private lastCapsule = Number.NEGATIVE_INFINITY;
  private lit: Record<StoreyId, number> = { workshop: 1, lookout: 1 };
  /** Figures drawn this frame. */
  frames: FigureFrame[] = [];

  constructor() {
    this.workshop.add(this.hall, this.props);
    this.lookoutRoot.add(this.lookout);
    this.root.add(
      this.lights.hemi,
      this.lights.sun,
      this.lights.sun.target,
      this.workshop,
      this.lookoutRoot,
      this.chute,
      this.crew.group,
    );
    this.windows = {
      workshop: new Pool(this.workshop, this.windowGeo, this.windowMat, { colours: true }),
      lookout: new Pool(this.lookoutRoot, this.windowGeo, this.windowMat, { colours: true }),
    };
    this.capsulePool = new Pool(this.root, this.capsuleGeo, this.capsuleMat, { colours: true });
  }

  /** The boxes the camera frames for a focus: one storey, or both. */
  boxes(focus: StoreyFocus): Box3D[] {
    const c = this.content;
    if (!c) return [];
    const { x0, x1, z0, z1 } = c.layout.bounds;
    const out: Box3D[] = [];
    if (focus !== "lookout" || !c.lookout) out.push({ x0, x1, y0: 0, y1: WALL_H, z0, z1 });
    const l = c.lookout;
    if (l && focus !== "workshop")
      out.push({ ...l.bounds, y0: l.y - SLAB_H, y1: l.y + LOOKOUT_WALL_H });
    return out;
  }

  /** Shows `content`, rebuilding only what changed. Returns whether the framing changed. */
  update(content: WorldContent, t: number, reduced: boolean): void {
    const { layout, scene, palette, lookout } = content;
    this.content = content;
    const hallKey = JSON.stringify([
      layout.bounds,
      layout.zones,
      floorSeats(layout).length,
      palette,
    ]);
    if (hallKey !== this.keys.hall) {
      this.keys.hall = hallKey;
      this.retire(this.hall, this.hallKit);
      this.hallKit = new Kit();
      this.hall.add(buildWorkshop(layout, palette, this.hallKit));
      this.crew.setPalette(palette);
      this.lit.workshop = -1;
    }
    this.lights.set(this.boxes("both"), palette, scene.stopped);
    this.windowMat.color.set(0xffffff);
    this.capsuleMat.color = colour(palette.paper);

    // The Lookout: its pods lit for the areas whose reviewer works this round.
    const litPods = new Set(
      scene.agents
        .filter(
          (a) =>
            a.role === "area" && a.area && ["working", "thinking", "approval"].includes(a.status),
        )
        .map((a) => a.area as string),
    );
    const lk = lookout ? lookoutKey(lookout, litPods, palette) : "";
    if (lk !== this.keys.lookout) {
      this.keys.lookout = lk;
      this.retire(this.lookout, this.lookoutKit);
      this.retire(this.chute, this.chuteKit);
      this.lookoutKit = new Kit();
      this.chuteKit = new Kit();
      if (lookout) {
        this.lookout.add(buildLookout(lookout, litPods, palette, this.lookoutKit, this.unit));
        this.chute.add(buildChute(lookout, palette, this.chuteKit));
      }
      this.lit.lookout = -1;
    }

    // The moments between the last scene and this one: none on the first, none with reduced
    // motion or while the factory is stopped (everyone stands still at their post).
    if (reduced || scene.stopped) this.motion.reset();
    else this.motion.play(scene, layout, sceneEvents(this.prevScene, scene), t);
    // Capsules drop for issues the scout filed into intake.
    if (this.prevScene && scene.scout?.filing && !reduced) {
      const had = new Set(this.prevScene.tickets.ids);
      const added = scene.tickets.ids.filter((id) => !had.has(id)).length;
      for (let i = 0; i < Math.min(4, added); i++) this.capsules.push(t + i * 0.3);
    }
    this.prevScene = scene;
    this.rebuildProps(t);
  }

  /** The live props, when what they show changed. The dock's count waits for crates to leave. */
  private rebuildProps(t: number): void {
    const c = this.content;
    if (!c) return;
    const inFlight = this.motion.shipsInFlight(t);
    this.shipping = inFlight;
    const scene = { ...c.scene, shipped: Math.max(0, c.scene.shipped - inFlight) };
    const occupied = occupiedSeats(scene);
    const key = propsKey(scene, c.layout, c.palette, occupied);
    if (key === this.keys.props) return;
    this.keys.props = key;
    this.retire(this.props, this.propsKit);
    this.propsKit = new Kit();
    this.props.add(buildProps(scene, c.layout, c.palette, this.propsKit, this.unit, occupied));
    this.lit.workshop = -1;
  }

  /** Whether loops, walks, moments, capsules or a storey's slide want frames at `t`. */
  animating(t: number, reduced: boolean): boolean {
    const scene = this.content?.scene;
    if (!scene) return false;
    return (
      this.motion.busy(t) ||
      this.storeys.moving(t) ||
      this.capsules.some((s) => t < s + CAPSULE_S) ||
      (Boolean(scene.scout?.filing) && !reduced && !scene.stopped) ||
      this.crew.animating(this.frames, {
        t,
        reduced,
        still: scene.stopped,
        selected: null,
        crates: [],
      })
    );
  }

  /** Places everything for the frame at `t`. */
  draw(t: number, reduced: boolean, selected: string | null): void {
    const c = this.content;
    if (!c) return;
    const poses = this.storeys.pose(t);
    this.place(poses);
    const still = reduced || c.scene.stopped;
    const all = still
      ? seatFrames(c.scene, c.layout, c.lookout)
      : this.motion.frames(c.scene, c.layout, t, c.lookout);
    // A storey aside shows its crew as lit windows instead of figures.
    this.frames = all
      .filter((f) => poses[storeyOf(f.agent)].crew)
      .map((f) => {
        const o = poses[storeyOf(f.agent)].offset;
        return o.x || o.y || o.z ? { ...f, x: f.x + o.x, y: f.y + o.y, z: f.z + o.z } : f;
      });
    this.crew.draw(this.frames, {
      t,
      reduced,
      still: c.scene.stopped,
      selected,
      crates: this.motion.crates(t),
    });
    this.drawWindows(c, poses);
    this.drawCapsules(c, t, poses, reduced);
    if (this.motion.shipsInFlight(t) !== this.shipping) this.rebuildProps(t);
  }

  /** Moves and dims the storeys for their poses. */
  private place(poses: Record<StoreyId, StoreyPose>): void {
    const l = this.content?.lookout;
    const w = poses.workshop;
    this.workshop.position.set(w.offset.x, w.offset.y, w.offset.z);
    const k = poses.lookout;
    this.lookoutRoot.position.set(k.offset.x, (l?.y ?? 0) + k.offset.y, k.offset.z);
    // The chute joins the storeys only while both stand in place.
    this.chute.visible = Boolean(l) && w.light === 1 && k.light === 1;
    for (const id of ["workshop", "lookout"] as const) {
      if (this.lit[id] === poses[id].light) continue;
      this.lit[id] = poses[id].light;
      // The windows stay as they are: they light up while their storey is aside.
      if (id === "workshop") {
        dimTree(this.hall, poses[id].light);
        dimTree(this.props, poses[id].light);
      } else dimTree(this.lookout, poses[id].light);
    }
  }

  /** A window per agent on each storey's back wall, lit in its status colour while aside. */
  private drawWindows(c: WorldContent, poses: Record<StoreyId, StoreyPose>): void {
    const dark = c.palette.sign;
    for (const id of ["workshop", "lookout"] as const) {
      const pool = this.windows[id];
      pool.begin();
      const box = id === "workshop" ? c.layout.bounds : c.lookout?.bounds;
      if (box) {
        const y = id === "workshop" ? WALL_H - 0.3 : LOOKOUT_WALL_H - 0.22;
        const agents = c.scene.agents.filter((a) => storeyOf(a) === id);
        agents.forEach((a, i) => {
          const x = box.x0 + 0.5 + i * WINDOW_GAP;
          if (x > box.x1 - 0.3) return;
          const on = !poses[id].crew;
          const rgb = on ? tipColour(a.failed && a.status !== "done" ? "failed" : a.status) : dark;
          pool.push(new Matrix4().makeTranslation(x, y, box.z0 + 0.006), rgb);
        });
      }
      pool.end();
    }
  }

  /** Capsules falling down the chute while the scout files. */
  private drawCapsules(
    c: WorldContent,
    t: number,
    poses: Record<StoreyId, StoreyPose>,
    reduced: boolean,
  ): void {
    const l = c.lookout;
    const filing = Boolean(c.scene.scout?.filing) && !reduced && !c.scene.stopped;
    if (filing && t - this.lastCapsule >= CAPSULE_EVERY_S) {
      this.lastCapsule = t;
      this.capsules.push(t);
    }
    this.capsules = this.capsules.filter((s) => t < s + CAPSULE_S);
    this.capsulePool.begin();
    if (l && this.chute.visible && poses.lookout.crew && poses.workshop.crew)
      for (const s of this.capsules) {
        const k = (t - s) / CAPSULE_S;
        if (k < 0) continue;
        const y = l.chute.top - (l.chute.top - l.chute.bottom - 0.1) * k * k;
        this.capsulePool.push(
          new Matrix4()
            .makeTranslation(l.chute.x, y, l.chute.z)
            .multiply(new Matrix4().makeRotationZ(k * 2)),
          c.palette.lamp.caution,
        );
      }
    this.capsulePool.end();
  }

  /** The repair bay's crates as targets keyed `bay:<kind>` (with the Workshop's offset). */
  crateTargets(): { key: string; x: number; y: number; z: number }[] {
    const c = this.content;
    if (!c) return [];
    const o = this.workshop.position;
    const spots = bayCrateSpots(c.layout, c.scene.bay.length);
    return c.scene.bay.slice(0, spots.length).map((crate, i) => {
      const at = spots[i] as { x: number; z: number };
      return { key: `bay:${crate.kind}`, x: at.x + o.x, y: o.y, z: at.z + o.z };
    });
  }

  /**
   * Takes a rebuilt part's old meshes off the scene, freeing their GPU resources only after the
   * next frame has drawn the new ones: their shaders stay compiled, so a rebuild doesn't stall.
   */
  private retire(group: Group, kit: Kit): void {
    group.clear();
    this.retired.push(kit);
  }

  /** Frees what rebuilt parts used to hold; call after a frame is drawn. */
  flushRetired(): void {
    for (const kit of this.retired.splice(0)) kit.dispose();
  }

  dispose(): void {
    this.flushRetired();
    clear(this.hall, this.hallKit);
    clear(this.props, this.propsKit);
    clear(this.lookout, this.lookoutKit);
    clear(this.chute, this.chuteKit);
    this.windows.workshop.dispose();
    this.windows.lookout.dispose();
    this.capsulePool.dispose();
    this.crew.dispose();
    this.shared.dispose();
    this.lights.dispose();
  }
}
