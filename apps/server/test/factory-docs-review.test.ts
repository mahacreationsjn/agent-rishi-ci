import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { docsOnly } from "../src/services/factory/checks";
import { clashGroup } from "../src/services/factory/fast-merge";
import { isDocFile, isLicenseFile, isNonCodeFile } from "../src/services/factory/policy";
import { VISION_TEMPLATE } from "../src/services/factory/vision";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #403: the docs pipeline skips the independent review only for documentation. A docs
 * item whose PR changes a manifest, a lock file, a CI workflow or a test (even deleting one) is
 * reviewed like any other PR, so auto-merge never lands it on CI alone.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, review } = factorySteps(() => env);

/** A docs item, waiting for an agent (the docs pipeline has no analyze step). */
function docsItem() {
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:5",
    title: "Document the setup",
    summary: "The setup guide is out of date",
    source: "issue",
    stage: "backlog",
    type: "docs",
    investigation: null,
    score: null,
    acceptanceCriteria: ["The guide matches the setup"],
    issue: { number: 5, url: "https://github.com/acme/app/issues/5", title: "Document the setup" },
  });
}

/**
 * The software factory with auto-merge on builds a docs item whose PR changes `files`. The
 * vision doesn't list CI workflows or licensing as protected (a user may take the template's
 * entries out), so the review is what stands between a workflow change and the merge, and
 * license files are protected whatever the vision says.
 */
async function build(files: string[]) {
  env = createFactoryEnv();
  const vision = join(env.project.path, env.project.visionPath);
  writeFileSync(
    vision,
    VISION_TEMPLATE.replace("- `.github/workflows/**`\n", "")
      .replace("- `LICENSE`\n", "")
      .replace("- licensing\n", ""),
  );
  await enable("software_factory", { autoMerge: true });
  const created = docsItem();
  await tick();
  const builder = item(created.id).builderSessionId as string;
  env.gh.openPr({ sessionId: builder, title: "Document the setup", files, checks: "success" });
  await env.setStatus(builder, "idle");
  await tick();
  await tick();
  return created.id;
}

const reviewCheck = (id: string) => item(id).checks.find((c) => c.name === "review");

describe("the docs pipeline with auto-merge on", () => {
  it.each([
    ["a change to package.json", ["docs/setup.md", "package.json"]],
    ["a CI workflow", ["docs/ci.md", ".github/workflows/ci.yml"]],
    ["a lock file", ["docs/setup.md", "pnpm-lock.yaml"]],
    ["a deleted test", ["docs/server.md", "apps/server/test/x.test.ts"]],
  ])("reviews %s before it merges", async (_what, files) => {
    const id = await build(files);
    expect(env.gh.merges).toEqual([]);
    expect(reviewCheck(id)?.state).not.toBe("skipped");
    expect(item(id).reviewerSessionId).toBeTruthy();
    review(id);
    await tick();
    await tick();
    expect(env.gh.merges).toHaveLength(1);
  });

  it("still merges documentation and images without a review", async () => {
    const id = await build(["docs/guide.md", "docs/img.png"]);
    expect(reviewCheck(id)?.state).toBe("skipped");
    expect(item(id).reviewerSessionId).toBeFalsy();
    expect(env.gh.merges).toHaveLength(1);
  });

  // Issue #405: MDX runs its JSX and imports when a docs site builds, and an SVG can carry
  // scripts and event handlers, so neither skips the review.
  it.each([
    ["an SVG", ["docs/diagram.svg"]],
    ["an MDX page", ["docs/page.mdx"]],
  ])("reviews %s before it merges", async (_what, files) => {
    const id = await build(files);
    expect(env.gh.merges).toEqual([]);
    expect(reviewCheck(id)?.state).not.toBe("skipped");
    expect(item(id).reviewerSessionId).toBeTruthy();
  });

  // Issue #405: licensing goes to a person, like `.agent-rishi/`, whatever the vision lists.
  it.each(["LICENSE.md", "LICENSE", "LICENSE.txt", "COPYING", "NOTICE", "packages/x/LICENSE.md"])(
    "escalates a change to %s and never merges it",
    async (file) => {
      const id = await build(["docs/guide.md", file]);
      expect(env.gh.merges).toEqual([]);
      expect(reviewCheck(id)?.state).not.toBe("skipped");
      expect(item(id).stage).toBe("escalated");
      expect(item(id).reason).toMatch(/protected areas/);
      expect(item(id).reason).toContain(`${file} (the project's license terms)`);
    },
  );

  it("skips the review for prose plus a raster image", async () => {
    const id = await build(["docs/guide.md", "docs/shot.png"]);
    expect(reviewCheck(id)?.state).toBe("skipped");
    expect(item(id).reviewerSessionId).toBeFalsy();
    expect(env.gh.merges).toHaveLength(1);
  });
});

describe("isDocFile", () => {
  it.each([
    "README.md",
    "docs/guide.md",
    "NOTES.txt",
    "docs/api.rst",
    "docs/img.png",
    "assets/photo.JPG",
    "docs/shot.jpeg",
    "docs/anim.gif",
    "docs/pic.webp",
    "public/favicon.ico",
    "apps/web/README.md",
    "docs\\windows\\path.md",
    "./docs/guide.md",
  ])("counts %s as documentation", (path) => {
    expect(isDocFile(path)).toBe(true);
  });

  it.each([
    // Manifests, lock files, config and CI, though the tests checks count them as non-code.
    "package.json",
    "apps/server/package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "tsconfig.json",
    "biome.json",
    "pyproject.toml",
    "setup.ini",
    ".github/workflows/ci.yml",
    ".gitignore",
    // MDX runs JSX and imports when a docs site builds; SVG can carry scripts.
    "docs/site/intro.mdx",
    "docs/logo.svg",
    "public/ICON.SVG",
    // Licensing, always protected.
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "packages/x/license.md",
    "COPYING",
    "NOTICE",
    // `.txt` files that steer an install or a build.
    "requirements.txt",
    "requirements-dev.txt",
    "services/api/requirements/base.txt",
    "constraints.txt",
    "CMakeLists.txt",
    // Tests, fixtures included.
    "apps/server/test/x.test.ts",
    "apps/server/test/fixtures/expected.md",
    "src/__tests__/snapshot.png",
    // Instructions coding agents load, and dot-folders.
    "CLAUDE.md",
    "apps/web/AGENTS.md",
    "AGENTS.override.md",
    "CLAUDE.local.md",
    "GEMINI.md",
    ".claude/commands/ship.md",
    ".agents/skills/x/SKILL.md",
    ".github/copilot-instructions.md",
    ".cursor/rules/x.md",
    // Code.
    "src/index.ts",
    "docs/build.mjs",
    "Makefile",
  ])("never counts %s as documentation", (path) => {
    expect(isDocFile(path)).toBe(false);
  });

  it("is narrower than isNonCodeFile, which only relaxes the tests checks", () => {
    for (const path of ["package.json", "pnpm-lock.yaml", ".github/workflows/ci.yml"]) {
      expect(isNonCodeFile(path)).toBe(true);
      expect(isDocFile(path)).toBe(false);
    }
  });
});

describe("isLicenseFile", () => {
  it.each([
    "LICENSE",
    "LICENSE.md",
    "license.txt",
    "LICENCE",
    "UNLICENSE",
    "LICENSE-MIT",
    "LICENSE_APACHE.txt",
    "COPYING",
    "COPYING.LESSER",
    "NOTICE",
    "NOTICE.md",
    "packages/x/LICENSE",
    "LICENSES/MIT.txt",
    "docs\\LICENSE.md",
  ])("protects %s", (path) => {
    expect(isLicenseFile(path)).toBe(true);
  });

  // Always on, so it must not catch ordinary files that share the name.
  it.each([
    "src/components/Notice.tsx",
    "src/license.ts",
    "scripts/license-check.mjs",
    "docs/licensing.md",
    "docs/notices/banner.md",
  ])("leaves %s alone", (path) => {
    expect(isLicenseFile(path)).toBe(false);
  });
});

describe("docsOnly", () => {
  it("needs every file, old paths of renames included, to be documentation", () => {
    expect(docsOnly({ files: ["docs/guide.md", "docs/img.png"] })).toBe(true);
    expect(docsOnly({ files: ["docs/guide.md", "package.json"] })).toBe(false);
    // Renaming code or a test into a docs file removes it.
    expect(docsOnly({ files: ["docs/old.md"], renamedFrom: ["src/old.ts"] })).toBe(false);
    expect(docsOnly({ files: ["docs/a.md"], renamedFrom: ["test/a.test.ts"] })).toBe(false);
    expect(docsOnly({ files: ["docs/new.md"], renamedFrom: ["docs/old.md"] })).toBe(true);
  });

  it("reviews a PR whose file list GitHub cut short, or that lists no files", () => {
    expect(docsOnly({ files: ["docs/guide.md"], changedFiles: 3_001 })).toBe(false);
    expect(docsOnly({ files: ["docs/guide.md"], changedFiles: 1 })).toBe(true);
    expect(docsOnly({ files: [] })).toBe(false);
  });
});

describe("fast merge: dependency manifests and lock files always re-test", () => {
  it.each([
    "package.json",
    "apps/server/package.json",
    "packages/contracts/package.json",
    "pnpm-lock.yaml",
    "apps/web/yarn.lock",
    "vendor/custom.lock",
    "go.sum",
    "services/api/go.mod",
    "Cargo.lock",
  ])("treats %s as a dependency file for the merge queue", (path) => {
    expect(clashGroup(path)).toBe("dependencies");
  });
});
