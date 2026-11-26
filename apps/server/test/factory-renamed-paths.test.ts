import {
  FactoryLimits,
  FactoryTuning,
  type ReviewVerdict,
  type WorkType,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/services/factory/checks";
import { fastMergeVerdict } from "../src/services/factory/fast-merge";
import type { FactoryPr } from "../src/services/factory/github-port";
import { changeSize } from "../src/services/factory/size";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #399: a renamed or copied file counts under its old path as well as its new one
 * (GitHub's `previous_filename`). Moving code into `docs/` deletes the code, so the change is
 * never docs-only and is reviewed; the UI evidence and the size check read old paths the same way.
 */

const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true, notNeeded: true },
  security: { concerns: [] },
  lessons: [],
};

function checksFor(opts: {
  files: string[];
  renamedFrom?: string[];
  fileLines?: FactoryPr["fileLines"];
  type?: WorkType;
  review?: ReviewVerdict | null;
  evidence?: boolean | null;
}) {
  const pr: FactoryPr = {
    ref: { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" },
    title: "Move the notes",
    body: "Fixes #3\n\n## Test results\n- `pnpm test`: 12 passed",
    headSha: "abc",
    headBranch: "agent-rishi/notes",
    checks: "success",
    failedChecks: [],
    mergeable: "mergeable",
    additions: 4,
    deletions: 1,
    files: opts.files,
    ...(opts.renamedFrom ? { renamedFrom: opts.renamedFrom } : {}),
    ...(opts.fileLines ? { fileLines: opts.fileLines } : {}),
  };
  const r = evaluateChecks({
    pr,
    issueTitle: "Move the notes",
    review: opts.review === undefined ? null : opts.review,
    approvedHead: "abc",
    reviewer: "codex",
    type: opts.type ?? "docs",
    evidence: opts.evidence ?? null,
    testOutput: null,
    audit: null,
    auditConfigured: false,
    ciTimedOut: true,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 5 } }),
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: [], topics: [] },
    now: new Date().toISOString(),
  });
  const check = (name: string) => r.checks.find((c) => c.name === name);
  return { outcome: r.outcome, check };
}

describe("merge checks: docs-only needs every path, old paths included", () => {
  it.each([
    "apps/server/src/x.ts",
    "apps/server/src/services/factory/policy.ts",
    "apps/server/src/services/factory/checks.ts",
    "packages/providers/src/risk/classify.ts",
  ])("reviews a rename of %s into docs/", (from) => {
    const { outcome, check } = checksFor({ files: ["docs/x.md"], renamedFrom: [from] });
    expect(check("review")).toMatchObject({ state: "pending" });
    expect(check("security")?.state).toBe("pending");
    expect(check("tests")?.detail).not.toBe("No code changed");
    expect(outcome).toBe("pending");
  });

  it("skips the review for a rename within docs/", () => {
    const { outcome, check } = checksFor({
      files: ["docs/guide/setup.md"],
      renamedFrom: ["docs/setup.md"],
    });
    expect(check("review")?.state).toBe("skipped");
    expect(outcome).toBe("pass");
  });

  it("reviews a removed code file plus a new docs file", () => {
    // GitHub lists a removed file under its own path.
    const { outcome, check } = checksFor({ files: ["apps/server/src/x.ts", "docs/x.md"] });
    expect(check("review")?.state).toBe("pending");
    expect(outcome).toBe("pending");
  });

  it("asks for test evidence for a rename out of code, whatever the pipeline", () => {
    const { check } = checksFor({
      type: "feature",
      files: ["notes/x.md"],
      renamedFrom: ["src/x.ts"],
      review: approve,
    });
    expect(check("tests")?.detail).not.toBe("No code changed");
    expect(check("test_results")?.state).toBe("pass");
  });
});

describe("merge checks: UI evidence counts a rename's old path", () => {
  it("wants screenshots for a UI file renamed out of the UI", () => {
    const { check } = checksFor({
      type: "feature",
      files: ["docs/button.md"],
      renamedFrom: ["apps/web/src/components/button.tsx"],
      review: approve,
      evidence: false,
    });
    expect(check("ui_evidence")).toMatchObject({ state: "fail" });
    expect(check("ui_evidence")?.detail).toContain("apps/web/src/components/button.tsx");
  });

  it("still skips a rename that never was UI", () => {
    const { check } = checksFor({
      type: "feature",
      files: ["docs/b.md"],
      renamedFrom: ["docs/a.md"],
      review: approve,
    });
    expect(check("ui_evidence")?.state).toBe("skipped");
  });
});

describe("the size check counts a rename out of reviewed code", () => {
  const pr = (fileLines: FactoryPr["fileLines"]) =>
    ({ additions: 0, deletions: 0, files: [], fileLines }) as unknown as FactoryPr;

  it("counts a file moved from code into a generated folder", () => {
    const moved = [{ path: "vendor/engine.ts", previousPath: "src/engine.ts", lines: 6000 }];
    expect(changeSize(pr(moved))).toEqual({ lines: 6000, files: 1, uncounted: 0 });
    const { check } = checksFor({
      type: "feature",
      files: ["vendor/engine.ts"],
      renamedFrom: ["src/engine.ts"],
      fileLines: moved,
      review: approve,
    });
    expect(check("size")?.state).toBe("fail");
  });

  it("still leaves out a rename within generated or vendored files", () => {
    const moved = [{ path: "dist/b.js", previousPath: "dist/a.js", lines: 6000 }];
    expect(changeSize(pr(moved))).toEqual({ lines: 0, files: 0, uncounted: 1 });
  });
});

describe("the fast merge path counts a rename's old path", () => {
  it("re-tests a PR that moves a migration out of its folder when main added one", () => {
    const verdict = fastMergeVerdict({
      branch: "main",
      hold: null,
      pr: {
        files: ["docs/old-schema.sql"],
        renamedFrom: ["db/migrations/001_init.sql"],
        mergeState: "clean",
      },
      main: { behind: 1, files: ["db/migrations/002_users.sql"], complete: true },
    });
    expect(verdict).toMatchObject({ fast: false });
    expect(verdict.fast ? "" : verdict.reason).toContain("db/migrations/001_init.sql");
  });
});

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem } = factorySteps(() => env);

describe("the factory loop looks up evidence for a rename's old path", () => {
  it("fails, rather than waits on, missing screenshots and test results", async () => {
    env = createFactoryEnv();
    await enable("software_factory");
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files: ["docs/button.md"],
      renamedFrom: ["apps/web/src/components/button.tsx"],
      body: "Moves the button into the docs",
      checks: "success",
    });
    await env.setStatus(builder, "idle");
    await tick();
    const check = (name: string) => item(created.id).checks.find((c) => c.name === name);
    expect(check("ui_evidence")).toMatchObject({ state: "fail" });
    expect(check("test_results")).toMatchObject({ state: "fail" });
  });
});

/** A dark factory docs build whose builder opens a PR with these files, run until it settles. */
async function buildDocs(files: string[], renamedFrom?: string[]) {
  env = createFactoryEnv();
  await enable("dark_factory");
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: "issue:5",
    title: "Tidy the guides",
    summary: "The guides are out of date",
    source: "issue",
    stage: "backlog",
    type: "docs",
    investigation: null,
    score: null,
    acceptanceCriteria: ["The guides are current"],
    issue: { number: 5, url: "https://github.com/acme/app/issues/5", title: "Tidy the guides" },
  });
  await tick();
  const builder = item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: "Tidy the guides",
    files,
    ...(renamedFrom ? { renamedFrom } : {}),
    checks: "success",
  });
  await env.setStatus(builder, "idle");
  await tick();
  await tick();
  return item(created.id);
}

describe("the factory loop, docs pipeline with auto-merge on", () => {
  it.each([
    ["a rename of code into docs/", ["docs/x.md"], ["apps/server/src/x.ts"]],
    ["a removed code file plus a new docs file", ["apps/server/src/x.ts", "docs/x.md"], undefined],
  ])("reviews %s and never merges it unreviewed", async (_what, files, renamedFrom) => {
    const done = await buildDocs(files, renamedFrom);
    expect(env.gh.merges).toEqual([]);
    expect(done.reviewerSessionId).toBeTruthy();
    expect(done.checks.find((c) => c.name === "review")?.state).toBe("pending");
  });

  it("merges a rename within docs/ without a review", async () => {
    const done = await buildDocs(["docs/guide/setup.md"], ["docs/setup.md"]);
    expect(done.reviewerSessionId).toBeNull();
    expect(done.checks.find((c) => c.name === "review")?.state).toBe("skipped");
    expect(env.gh.merges).toHaveLength(1);
  });
});
