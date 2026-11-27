import { describe, expect, it } from "vitest";
import { edition } from "../src/index";

describe("Agent Rishi Solo", () => {
  it("is the solo edition, for Windows and Linux", () => {
    expect(edition.id).toBe("solo");
    expect(edition.platforms).toEqual(["win32", "linux"]);
  });
});
