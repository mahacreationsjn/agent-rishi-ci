import { describe, expect, it } from "vitest";
import { loginPaste } from "../src/components/workbench/login-paste";

describe("login clipboard input", () => {
  it("keeps a long line intact and leaves submission to Enter", () => {
    const code = "fake-login-".repeat(15);
    expect(loginPaste(`\x1b[200~  ${code}\r\n\x1b[201~`)).toBe(code);
  });

  it("rejects multiple lines and terminal control characters", () => {
    for (const text of ["first\nsecond", "first\rsecond", "abc\x1b[A", "abc\x16", "  \r\n"]) {
      expect(loginPaste(text)).toBe("");
    }
  });
});
