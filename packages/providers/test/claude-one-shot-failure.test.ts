import { describe, expect, it } from "vitest";
import { oneShotFailure } from "../src/claude/one-shot";

describe("Claude utility model failures", () => {
  it("names the reason of an error reported as a turn (subtype success, is_error)", () => {
    expect(
      oneShotFailure({
        subtype: "success",
        is_error: true,
        result: "You've hit your 5-hour limit · resets 3am (Asia/Kolkata)",
      }),
    ).toBe(
      "Utility model failed (error): You've hit your 5-hour limit · resets 3am (Asia/Kolkata)",
    );
  });

  it("keeps an error subtype and its errors", () => {
    expect(
      oneShotFailure({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["API Error: 529 overloaded", ""],
      }),
    ).toBe("Utility model failed (error_during_execution): API Error: 529 overloaded");
  });

  it("says no more than it knows, on one line and short", () => {
    expect(oneShotFailure({ subtype: "error_max_turns", is_error: true })).toBe(
      "Utility model failed (error_max_turns)",
    );
    const long = oneShotFailure({
      subtype: "success",
      is_error: true,
      result: `a\n\n${"x".repeat(500)}`,
    });
    expect(long).not.toContain("\n");
    expect(long.length).toBeLessThan(340);
  });
});
