import { FactoryLimits, FactoryTuning, type ReviewVerdict } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/services/factory/checks";
import type { FactoryPr } from "../src/services/factory/github-port";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #397: protected areas match paths case-insensitively (on Windows and macOS `.AGENT-RISHI/`
 * is the same folder as `.agent-rishi/` once checked out), and a rename or copy is checked under its
 * old path too: moving a file out of a protected folder deletes it there.
 */

const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
  lessons: [],
};

const CODE = ["src/counter.ts", "test/counter.test.ts"];

/** Every other check green; `.agent-rishi/**` and the vision's `**\/auth/**` protected, deploys off. */
function checksFor(files: string[], renamedFrom?: string[]) {
  const pr: FactoryPr = {
    ref: { number: 7, url: "https://github.com/acme/app/pull/7", state: "open" },
    title: "Tidy the project",
    body: "Fixes #3\n\n## Test results\n- `pnpm test`: 12 passed",
    headSha: "abc",
    headBranch: "agent-rishi/tidy",
    checks: "success",
    failedChecks: [],
    mergeable: "mergeable",
    additions: 4,
    deletions: 1,
    files,
    ...(renamedFrom ? { renamedFrom } : {}),
  };
  const r = evaluateChecks({
    pr,
    issueTitle: "Tidy the project",
    review: approve,
    approvedHead: "abc",
    reviewer: "codex",
    type: "feature",
    evidence: true,
    testOutput: true,
    audit: null,
    auditConfigured: false,
    ciTimedOut: true,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 5 }, protectedPaths: [".agent-rishi/**"] }),
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: ["**/auth/**"], topics: [] },
    now: new Date().toISOString(),
  });
  return { outcome: r.outcome, check: r.checks.find((c) => c.name === "protected_paths") };
}

describe("merge checks: protected paths ignore case", () => {
  it.each([
    ".AGENT-RISHI/project.json",
    ".Agent-Rishi/automations/x.md",
    "src/Auth/login.ts",
    ".github/workflows/Deploy.yml",
    "DOCKERFILE",
  ])("escalates a change to %s", (file) => {
    const { outcome, check } = checksFor([file, ...CODE]);
    expect(outcome).toBe("escalate");
    expect(check).toMatchObject({ state: "fail", escalate: true });
    expect(check?.detail).toContain(file);
  });
});

describe("merge checks: renames are checked under both paths", () => {
  it.each([
    ["out of a protected folder", "notes/x.md", ".agent-rishi/automations/x.md"],
    ["into a protected folder", ".agent-rishi/automations/x.md", "notes/x.md"],
    ["of a deploy file", "docs/old-dockerfile", "Dockerfile"],
    ["out of a protected folder, in another case", "notes/x.md", ".Agent-Rishi/automations/x.md"],
  ])("escalates a rename %s", (_what, to, from) => {
    const { outcome, check } = checksFor([to, ...CODE], [from]);
    expect(outcome).toBe("escalate");
    expect(check).toMatchObject({ state: "fail", escalate: true });
    expect(check?.detail).toMatch(/Touches protected areas/);
  });

  it("leaves unrelated paths and renames alone", () => {
    for (const r of [
      checksFor([...CODE, "docs/agent-rishi.md", "src/author.ts"]),
      checksFor(["src/tally.ts", ...CODE], ["src/count.ts"]),
    ]) {
      expect(r.outcome).toBe("pass");
      expect(r.check?.state).toBe("pass");
    }
  });
});

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, review } = factorySteps(() => env);

/** A dark factory build whose builder opens a PR with these files, run until it settles. */
async function build(files: string[], renamedFrom?: string[]) {
  env = createFactoryEnv({ limits: { protectedPaths: [".agent-rishi/**"] } });
  await enable("dark_factory");
  const created = backlogItem();
  await tick();
  const builder = item(created.id).builderSessionId as string;
  env.gh.openPr({
    sessionId: builder,
    title: "Add a counter",
    files,
    ...(renamedFrom ? { renamedFrom } : {}),
    checks: "success",
  });
  await env.setStatus(builder, "idle");
  await tick();
  // A reviewer may already be on it: its approval must still not merge a protected change.
  if (item(created.id).reviewerSessionId) {
    review(created.id);
    await tick();
    await tick();
  }
  return item(created.id);
}

describe("the factory loop with auto-merge on", () => {
  it.each([
    ["a change to .AGENT-RISHI/project.json", [".AGENT-RISHI/project.json", ...CODE], undefined],
    [
      "a rename out of .agent-rishi/",
      ["notes/x.md", ...CODE],
      [".agent-rishi/automations/x.md"] as string[],
    ],
    [
      "a rename into .agent-rishi/",
      [".agent-rishi/automations/x.md", ...CODE],
      ["notes/x.md"] as string[],
    ],
  ])("never merges %s", async (_what, files, renamedFrom) => {
    const done = await build(files, renamedFrom);
    expect(env.gh.merges).toEqual([]);
    expect(done.stage).toBe("escalated");
    expect(done.reason).toMatch(/protected areas/);
  });

  it("still merges a PR that touches only ordinary paths", async () => {
    await build(["src/tally.ts", ...CODE], ["src/count.ts"]);
    expect(env.gh.merges).toHaveLength(1);
  });
});
