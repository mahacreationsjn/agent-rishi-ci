import { describe, expect, it } from "vitest";
import { EditionConfig } from "../src/edition";

describe("EditionConfig", () => {
  const solo = {
    id: "solo",
    name: "Agent Rishi Solo",
    summary: "One person runs a company.",
    platforms: ["win32", "linux"],
  };

  it("round-trips through JSON", () => {
    expect(EditionConfig.parse(JSON.parse(JSON.stringify(EditionConfig.parse(solo))))).toEqual(
      solo,
    );
  });

  it.each([
    [{ ...solo, id: "team" }, "an unknown edition"],
    [{ ...solo, platforms: [] }, "no platform"],
    [{ ...solo, platforms: ["beos"] }, "an unknown platform"],
    [{ ...solo, name: "" }, "an empty name"],
    [{ ...solo, extra: true }, "an unknown field"],
  ])("refuses %j (%s)", (value, _why) => {
    expect(EditionConfig.safeParse(value).success).toBe(false);
  });
});
