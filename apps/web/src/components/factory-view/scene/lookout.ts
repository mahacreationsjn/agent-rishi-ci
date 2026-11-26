import { DiscoveryArea as Areas, type DiscoveryArea } from "@agent-rishi/contracts";
import { type Box, type Point, WALL_H, type WorkshopLayout } from "./layout";

/**
 * The Lookout (#476): a dark factory's second storey, where the scout plans its rounds at a map
 * table and its area reviewers work at eight labelled pods, one per review area, always there
 * (lit only while that area's reviewer works this round). It hovers above the back of the
 * Workshop, so from the camera's 30° neither storey covers the other's interior, and a glass
 * filing chute runs from it down to intake's pallet. Same x and z as the Workshop; its floor is
 * `y` above it. Pure.
 */

/** The pods' labels, in the areas' order. */
export const POD_LABEL: Record<DiscoveryArea, string> = {
  features: "Features",
  ux: "UX",
  performance: "Performance",
  tech_debt: "Tech debt",
  test_gaps: "Test gaps",
  security: "Security",
  bugs: "Bugs",
  docs: "Docs",
};

export const AREAS: readonly DiscoveryArea[] = Areas.options;

/** Pods sit this far apart along x. */
export const POD_PITCH = 1.2;
/** A pod's console in front of its reviewer. */
export const POD = { w: 0.8, d: 0.36, h: 0.32 } as const;
export const TABLE = { w: 1.8, d: 0.9, h: 0.3 } as const;
/** The Lookout's depth: pods along the back, the map table in front of them. */
export const LOOKOUT_DEPTH = 2.9;
/** Room at its left end for the chute's hopper. */
const HOPPER_W = 1.4;
const MARGIN = 0.4;
/** The gap between the Workshop's walls and the Lookout's floor, per unit of Workshop depth. */
export const GAP_PER_DEPTH = 0.6;
export const SLAB_H = 0.16;
export const LOOKOUT_WALL_H = 0.9;

export interface LookoutPod {
  area: DiscoveryArea;
  label: string;
  /** The console's centre. */
  console: Point;
  /** Where its reviewer stands, behind the console. */
  stand: Point;
}

export interface LookoutLayout {
  /** Its floor's height above the Workshop floor. */
  y: number;
  bounds: Box;
  pods: LookoutPod[];
  table: Point;
  /** Where the scout stands, behind the map table. */
  scout: Point;
  /** The filing chute: straight down from the hopper to intake's pallet. */
  chute: { x: number; z: number; top: number; bottom: number };
}

/** The Lookout over a Workshop. */
export function lookoutLayout(w: WorkshopLayout): LookoutLayout {
  const depth = w.bounds.z1 - w.bounds.z0;
  const y = WALL_H + GAP_PER_DEPTH * depth;
  const x0 = w.bounds.x0 + 0.3;
  const z0 = w.bounds.z0;
  const podsX0 = x0 + MARGIN + HOPPER_W;
  const pods = AREAS.map((area, i) => {
    const x = podsX0 + POD_PITCH / 2 + i * POD_PITCH;
    return {
      area,
      label: POD_LABEL[area],
      console: { x, z: z0 + 0.95 },
      stand: { x, z: z0 + 0.5 },
    };
  });
  const x1 = podsX0 + AREAS.length * POD_PITCH + MARGIN;
  const tableX = podsX0 + (AREAS.length * POD_PITCH) / 2;
  const table = { x: tableX, z: z0 + 2.15 };
  const pallet = w.pallet;
  return {
    y,
    bounds: { x0, x1, z0, z1: z0 + LOOKOUT_DEPTH },
    pods,
    table,
    scout: { x: tableX, z: table.z - TABLE.d / 2 - 0.42 },
    chute: {
      x: (pallet.x0 + pallet.x1) / 2,
      z: (pallet.z0 + pallet.z1) / 2,
      top: y,
      bottom: 0.15,
    },
  };
}

/** Where an area reviewer stands: at its area's pod. */
export function podOf(l: LookoutLayout, area: DiscoveryArea | null): LookoutPod | undefined {
  return l.pods.find((p) => p.area === area);
}
