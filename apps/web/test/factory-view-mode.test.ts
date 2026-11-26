import { describe, expect, it } from "vitest";
import { storedViewMode } from "@/components/factory-view/view-mode";

/**
 * Issues #420 and #476: the Factory view remembers Board or Floor; the retired pixel mode, still
 * stored in some browsers, opens Floor, which replaced it.
 */
describe("the Factory view's stored mode", () => {
  it("reads board and floor, and anything else as the board", () => {
    expect(storedViewMode("board")).toBe("board");
    expect(storedViewMode("floor")).toBe("floor");
    expect(storedViewMode(null)).toBe("board");
    expect(storedViewMode("3d")).toBe("board");
  });

  it("opens Floor for a stored pixel mode", () => {
    expect(storedViewMode("pixel")).toBe("floor");
  });
});
