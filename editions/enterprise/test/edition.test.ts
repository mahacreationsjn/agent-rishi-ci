import { describe, expect, it } from "vitest";
import { edition } from "../src/index";

describe("Agent Rishi Enterprise", () => {
  it("is the enterprise edition, for Linux only", () => {
    expect(edition.id).toBe("enterprise");
    expect(edition.platforms).toEqual(["linux"]);
  });
});
