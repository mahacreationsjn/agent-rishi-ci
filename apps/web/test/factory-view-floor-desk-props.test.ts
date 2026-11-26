import type { FactoryWorkItem } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { deskProps, hasLaptop, occupiedSeats } from "@/components/factory-view/floor/desk-props";
import { readPalette } from "@/components/factory-view/floor/palette";
import { propsKey } from "@/components/factory-view/floor/props";
import { workshopLayout } from "@/components/factory-view/scene/layout";
import { type Scene, sceneOf } from "@/components/factory-view/scene/scene-model";
import { inputs, status, w } from "./scene-fixtures";

/**
 * Floor mode's desks show what their agent is doing: a laptop on every desk where an agent
 * works, and on a desk somebody sits at, the prop for their step. Empty desks stay clean.
 */

const layout = workshopLayout(4, {}, null);

function sceneWith(items: FactoryWorkItem[], prev: Scene | null = null): Scene {
  const f = status({ mode: "software_factory", scout: null, inProgress: items });
  return sceneOf(inputs(f), prev?.seating ?? null, () => layout.stations);
}

describe("Floor mode's desk props", () => {
  it("puts a laptop on every desk where an agent works at a computer", () => {
    for (const s of ["prep", "bench", "review", "pm"] as const) expect(hasLaptop(s)).toBe(true);
    for (const s of ["merge", "ship", "scout", "area"] as const) expect(hasLaptop(s)).toBe(false);
  });

  it("leaves an empty desk without a step prop", () => {
    for (const s of ["prep", "bench", "review", "pm", "merge"] as const)
      expect(deskProps(s, undefined)).toEqual([]);
  });

  it("gives a prep desk a jar and magnifier while reproducing, a whiteboard while analyzing", () => {
    expect(deskProps("prep", { step: "reproducing", type: "bug" })).toEqual(["jar", "magnifier"]);
    expect(deskProps("prep", { step: "analyzing", type: "feature" })).toEqual([
      "whiteboard",
      "notes",
    ]);
  });

  it("gives the bench a toolbox, with a wrench for a bug fix and a blueprint for a feature", () => {
    const bench = (type: FactoryWorkItem["type"]) =>
      deskProps("bench", { step: "implementing", type });
    expect(bench("bug")).toEqual(["toolbox", "wrench"]);
    expect(bench("feature")).toEqual(["toolbox", "blueprint"]);
    expect(bench("docs")).toEqual(["toolbox"]);
    expect(bench(null)).toEqual(["toolbox"]);
  });

  it("gives a review desk the clipboard and a red pen, and the PM's desk no step prop", () => {
    expect(deskProps("review", { step: "reviewing", type: "bug" })).toEqual(["clipboard", "pen"]);
    expect(deskProps("pm", { step: "pm", type: null })).toEqual([]);
  });

  it("reads each seat's step and item type from the scene", () => {
    const scene = sceneWith([
      w("a", 1, { step: "reproduce", type: "bug" }),
      w("b", 2, { step: "implement", type: "feature" }),
    ]);
    const uses = [...occupiedSeats(scene)];
    expect(uses).toContainEqual(["prep:0,0", { step: "reproducing", type: "bug" }]);
    expect(uses).toContainEqual(["bench:1,0", { step: "implementing", type: "feature" }]);
  });

  it("rebuilds the props when an agent moves on from reproducing, or its item's type changes", () => {
    const p = readPalette();
    const key = (s: Scene) => propsKey(s, layout, p, occupiedSeats(s));
    const reproducing = sceneWith([w("a", 1, { step: "reproduce", type: "bug" })]);
    const fixing = sceneWith([w("a", 1, { step: "implement", type: "bug" })], reproducing);
    const asFeature = sceneWith([w("a", 1, { step: "implement", type: "feature" })], fixing);
    expect(key(fixing)).not.toBe(key(reproducing));
    expect(key(asFeature)).not.toBe(key(fixing));
  });
});
