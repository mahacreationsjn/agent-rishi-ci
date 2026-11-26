import { BoxGeometry, CircleGeometry, Group, Mesh, type Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { occupiedSeats } from "@/components/factory-view/floor/desk-props";
import { Kit } from "@/components/factory-view/floor/kit";
import { readPalette } from "@/components/factory-view/floor/palette";
import { buildProps } from "@/components/factory-view/floor/props";
import { buildWorkshop } from "@/components/factory-view/floor/workshop";
import { type WorkshopLayout, workshopLayout } from "@/components/factory-view/scene/layout";
import type { Scene } from "@/components/factory-view/scene/scene-model";
import { NO_SEATING } from "@/components/factory-view/scene/seating";

/**
 * Issue #474: Floor mode hides the budget dial when no daily budget is set, and the dark ring
 * that backs it on the back wall goes with it; with a budget, both are drawn.
 */

const scene = (gauge: number | null): Scene => ({
  stopped: false,
  draining: null,
  agents: [],
  seating: NO_SEATING,
  tickets: { items: [], more: 0, ids: [] },
  bay: [],
  merged: [],
  shipped: 0,
  board: { working: 0, waiting: 0 },
  ciRunning: false,
  gauge,
  scout: null,
});

const kits: Kit[] = [];
beforeEach(() => {
  // jsdom has no 2D canvas; the textures skip drawing without one.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  for (const kit of kits.splice(0)) kit.dispose();
  vi.restoreAllMocks();
});

/** The hall and the live props for `gauge`, as the stage builds them. */
function floorFor(layout: WorkshopLayout, gauge: number | null): Group {
  const p = readPalette();
  const hallKit = new Kit();
  const propsKit = new Kit();
  kits.push(hallKit, propsKit);
  const s = scene(gauge);
  const unit = propsKit.own(new BoxGeometry(1, 1, 1));
  const root = new Group();
  root.add(buildWorkshop(layout, p, hallKit));
  root.add(buildProps(s, layout, p, propsKit, unit, occupiedSeats(s)));
  root.updateMatrixWorld(true);
  return root;
}

/** The discs on the back wall at the budget dial's spot (radius, distance off the wall), widest first. */
function atDial(root: Object3D, layout: WorkshopLayout): { radius: number; off: number }[] {
  const found: { radius: number; off: number }[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !(o.geometry instanceof CircleGeometry)) return;
    const { x, z } = o.getWorldPosition(new Vector3());
    const off = z - layout.bounds.z0;
    if (Math.abs(x - layout.budgetDial.x) < 0.01 && off >= 0 && off < 0.05)
      found.push({ radius: o.geometry.parameters.radius, off });
  });
  return found.sort((a, b) => b.radius - a.radius);
}

describe("Floor mode's budget dial (#474)", () => {
  it("draws nothing at the dial's spot on the back wall when no daily budget is set", () => {
    for (const n of [1, 4, 12]) {
      const layout = workshopLayout(n, {}, null);
      expect(atDial(floorFor(layout, null), layout)).toEqual([]);
    }
  });

  it("draws the dial and its backing ring just behind it when there is a budget", () => {
    const layout = workshopLayout(4, {}, null);
    const discs = atDial(floorFor(layout, 0.4), layout);
    expect(discs).toHaveLength(2);
    const [ring, dial] = discs as [(typeof discs)[0], (typeof discs)[0]];
    // The ring is wider than the dial and sits between it and the wall.
    expect(ring.radius).toBeGreaterThan(dial.radius);
    expect(ring.off).toBeLessThan(dial.off);
  });
});
