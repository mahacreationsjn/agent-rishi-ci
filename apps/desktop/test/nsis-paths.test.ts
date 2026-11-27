import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Problem = { longest: string; length: number; limit: number };
type NsisPaths = {
  NSIS_MAX_PATH: number;
  nsisPathProblem(files: string[], limit?: number): Problem | null;
  nsisTemplateFiles(fromPackageJson: string): string[];
  assertNsisPathsFit(fromPackageJson: string): void;
};

const script = "../scripts/nsis-paths.mjs";
const { NSIS_MAX_PATH, nsisPathProblem, nsisTemplateFiles, assertNsisPathsFit } = (await import(
  /* @vite-ignore */ script
)) as NsisPaths;

const desktopPackage = join(import.meta.dirname, "..", "package.json");

describe("NSIS path length check", () => {
  it("passes paths up to makensis's limit and reports the longest one past it", () => {
    const ok = "C:\\a\\".padEnd(NSIS_MAX_PATH, "x");
    const tooLong = `${ok}y`;
    expect(nsisPathProblem([ok, "C:\\short"])).toBeNull();
    expect(nsisPathProblem(["C:\\short", tooLong, ok])).toEqual({
      longest: tooLong,
      length: NSIS_MAX_PATH + 1,
      limit: NSIS_MAX_PATH,
    });
  });

  it("finds electron-builder's NSIS templates, StdUtils.nsh included", () => {
    const files = nsisTemplateFiles(desktopPackage);
    expect(files.some((f) => f.endsWith(join("nsis", "include", "StdUtils.nsh")))).toBe(true);
  });

  it("explains the fix when this checkout is too deep, and is silent when it fits", () => {
    const problem = nsisPathProblem(nsisTemplateFiles(desktopPackage));
    if (problem) {
      expect(() => assertNsisPathsFit(desktopPackage)).toThrow(/shorter folder/);
    } else {
      expect(() => assertNsisPathsFit(desktopPackage)).not.toThrow();
    }
  });
});
