import { describe, expect, it } from "vitest";
import { toUnifiedPatch } from "../src/services/github/pr-files";

const hunks = "@@ -1,2 +1,2 @@\n a\n-b\n+c";

describe("toUnifiedPatch", () => {
  it("adds git headers to GitHub's hunk-only patch", () => {
    expect(toUnifiedPatch({ path: "src/a.ts", status: "modified" }, hunks)).toBe(
      `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n${hunks}\n`,
    );
  });

  it("uses /dev/null for added and removed files", () => {
    expect(toUnifiedPatch({ path: "new.ts", status: "added" }, "@@ -0,0 +1 @@\n+x")).toBe(
      "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n",
    );
    expect(toUnifiedPatch({ path: "old.ts", status: "removed" }, "@@ -1 +0,0 @@\n-x\n")).toBe(
      "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    );
  });

  it("names both sides of a rename", () => {
    expect(
      toUnifiedPatch({ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" }, hunks),
    ).toBe(`diff --git a/src/old.ts b/src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n${hunks}\n`);
  });

  it("is null when GitHub sent no patch (binary, too large, no content change)", () => {
    expect(toUnifiedPatch({ path: "logo.png", status: "added" }, undefined)).toBeNull();
    expect(
      toUnifiedPatch({ path: "a.ts", status: "renamed", previousPath: "b.ts" }, ""),
    ).toBeNull();
  });
});

// A PR from anyone can name its files; the names must stay inside their header lines.
describe("toUnifiedPatch quotes file names the way git does", () => {
  /** The patch of a modified file whose `a/` and `b/` names are written as `a` and `b`. */
  function modified(a: string, b: string): string {
    return `diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n${hunks}\n`;
  }

  it("escapes a newline, so a name can't add diff lines or a second file", () => {
    const path = "evil\ndiff --git a/injected.ts b/injected.ts";
    const patch = toUnifiedPatch({ path, status: "modified" }, hunks);
    expect(patch).toBe(
      modified(
        '"a/evil\\ndiff --git a/injected.ts b/injected.ts"',
        '"b/evil\\ndiff --git a/injected.ts b/injected.ts"',
      ),
    );
    expect(patch?.match(/^diff --git /gm)).toHaveLength(1);
    expect(patch?.match(/^(---|\+\+\+) /gm)).toHaveLength(2);
  });

  it("escapes a newline that would fake the +++ header", () => {
    const path = "fake\n+++ b/other.ts";
    expect(toUnifiedPatch({ path, status: "modified" }, hunks)).toBe(
      modified('"a/fake\\n+++ b/other.ts"', '"b/fake\\n+++ b/other.ts"'),
    );
  });

  it("escapes tabs, quotes, backslashes and other control characters", () => {
    expect(toUnifiedPatch({ path: "tab\there.ts", status: "modified" }, hunks)).toBe(
      modified('"a/tab\\there.ts"', '"b/tab\\there.ts"'),
    );
    expect(toUnifiedPatch({ path: 'say "hi".ts', status: "modified" }, hunks)).toBe(
      modified('"a/say \\"hi\\".ts"', '"b/say \\"hi\\".ts"'),
    );
    expect(toUnifiedPatch({ path: "back\\slash.ts", status: "modified" }, hunks)).toBe(
      modified('"a/back\\\\slash.ts"', '"b/back\\\\slash.ts"'),
    );
    expect(toUnifiedPatch({ path: "a\rb\u0001c\u007f.ts", status: "modified" }, hunks)).toBe(
      modified('"a/a\\rb\\001c\\177.ts"', '"b/a\\rb\\001c\\177.ts"'),
    );
  });

  it("writes non-ASCII names as octal UTF-8 bytes", () => {
    expect(toUnifiedPatch({ path: "café.ts", status: "modified" }, hunks)).toBe(
      modified('"a/caf\\303\\251.ts"', '"b/caf\\303\\251.ts"'),
    );
    // A Unicode line separator never reaches the header as itself.
    expect(toUnifiedPatch({ path: "x y.ts", status: "modified" }, hunks)).toBe(
      modified('"a/x\\342\\200\\250y.ts"', '"b/x\\342\\200\\250y.ts"'),
    );
  });

  it("quotes each side on its own and leaves /dev/null bare", () => {
    expect(
      toUnifiedPatch({ path: "new.ts", previousPath: "old\tname.ts", status: "renamed" }, hunks),
    ).toBe(
      `diff --git "a/old\\tname.ts" b/new.ts\n--- "a/old\\tname.ts"\n+++ b/new.ts\n${hunks}\n`,
    );
    expect(toUnifiedPatch({ path: "n\new.ts", status: "added" }, "@@ -0,0 +1 @@\n+x")).toBe(
      'diff --git "a/n\\new.ts" "b/n\\new.ts"\n--- /dev/null\n+++ "b/n\\new.ts"\n@@ -0,0 +1 @@\n+x\n',
    );
  });
});
