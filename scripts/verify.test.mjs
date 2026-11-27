import { describe, expect, it } from "vitest";
import { STEPS, selectSteps } from "./verify.mjs";

const ids = (argv) => selectSteps(argv).map((s) => s.id);

describe("verify step selection", () => {
  it("runs every CI step in order by default", () => {
    expect(ids([])).toEqual(STEPS.map((s) => s.id));
    expect(ids([])).toEqual([
      "install",
      "typecheck",
      "lint",
      "test",
      "build",
      "self-update",
      "packed-cli",
    ]);
  });

  it("--quick stops after the tests", () => {
    expect(ids(["--quick"])).toEqual(["install", "typecheck", "lint", "test"]);
  });

  it("--only keeps pipeline order whatever order it is given in", () => {
    expect(ids(["--only", "test,lint"])).toEqual(["lint", "test"]);
  });

  it("--skip and --from narrow the list", () => {
    expect(ids(["--skip", "install,build"])).toEqual([
      "typecheck",
      "lint",
      "test",
      "self-update",
      "packed-cli",
    ]);
    expect(ids(["--from", "build"])).toEqual(["build", "self-update", "packed-cli"]);
    expect(ids(["--quick", "--from", "lint", "--skip", "install"])).toEqual(["lint", "test"]);
  });

  it("refuses an unknown step or a missing value", () => {
    expect(() => ids(["--only", "tset"])).toThrow(/Unknown step "tset"/);
    expect(() => ids(["--skip"])).toThrow(/--skip needs a value/);
    expect(() => ids(["--from", "--quick"])).toThrow(/--from needs a value/);
  });
});
