import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryLimits, FactoryTuning, type ReviewVerdict } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateChecks } from "../src/services/factory/checks";
import type { FactoryPr } from "../src/services/factory/github-port";
import { VISION_TEMPLATE } from "../src/services/factory/vision";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * `.agent-rishi/` is always a protected area (§10.1): it holds the setup commands every new worktree
 * runs, the checks, the vision the factory enforces and the scheduled automations. A pull request
 * that changes anything there goes to a person, whatever the vision or the limits say.
 */

const AGENT_RISHI_FILES = [
  ".agent-rishi/project.json",
  ".agent-rishi/VISION.md",
  ".agent-rishi/automations/x.md",
] as const;

const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
  lessons: [],
};

function pr(files: string[]): FactoryPr {
  return {
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
  };
}

/** Every other check green, nothing configured as protected, deploys allowed. */
function checksFor(files: string[]) {
  return evaluateChecks({
    pr: pr(files),
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
    limits: FactoryLimits.parse({
      maxConcurrentSessions: 2,
      maxMergesPerDay: 3,
      dailyBudget: { usd: 5 },
      pauseAfterConsecutiveFailures: 2,
      protectedPaths: [],
      allowDeploys: true,
    }),
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: [], topics: [] },
    now: new Date().toISOString(),
  });
}

describe("merge checks: .agent-rishi/ is always protected", () => {
  it.each(AGENT_RISHI_FILES)(
    "escalates a change to %s with no protected areas configured",
    (file) => {
      const r = checksFor([file, "src/counter.ts", "test/counter.test.ts"]);
      expect(r.outcome).toBe("escalate");
      const check = r.checks.find((c) => c.name === "protected_paths");
      expect(check).toMatchObject({ state: "fail", escalate: true });
      expect(check?.detail).toContain(file);
    },
  );

  it("leaves other paths unchanged", () => {
    const r = checksFor(["src/counter.ts", "test/counter.test.ts", "docs/agent-rishi.md"]);
    expect(r.outcome).toBe("pass");
    expect(r.checks.find((c) => c.name === "protected_paths")?.state).toBe("pass");
  });
});

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem, review } = factorySteps(() => env);

describe("the factory loop with auto-merge on", () => {
  it.each(AGENT_RISHI_FILES)("never merges a PR that changes %s", async (file) => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files: [file, "src/counter.ts", "test/counter.test.ts"],
      checks: "success",
    });
    await env.setStatus(builder, "idle");
    await tick();
    // A reviewer may already be on it (the bug): its approval must still not merge it.
    if (item(created.id).reviewerSessionId) {
      review(created.id);
      await tick();
      await tick();
    }
    expect(env.gh.merges).toEqual([]);
    expect(item(created.id).stage).toBe("escalated");
    expect(item(created.id).reason).toMatch(/protected areas/);
    expect(item(created.id).reason).toContain(file);
  });

  it("never merges a change to a vision kept outside .agent-rishi/", async () => {
    env = createFactoryEnv();
    mkdirSync(join(env.project.path, "docs"), { recursive: true });
    writeFileSync(join(env.project.path, "docs", "VISION.md"), VISION_TEMPLATE);
    env.updateProject({ visionPath: "docs/VISION.md" });
    await enable("dark_factory");
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files: ["docs/VISION.md", "src/counter.ts", "test/counter.test.ts"],
      checks: "success",
    });
    await env.setStatus(builder, "idle");
    await tick();
    expect(env.gh.merges).toEqual([]);
    expect(item(created.id).stage).toBe("escalated");
    expect(item(created.id).reason).toContain("docs/VISION.md");
  });

  it("still merges a PR that touches only ordinary paths", async () => {
    env = createFactoryEnv();
    await enable("dark_factory");
    const created = backlogItem();
    await tick();
    const builder = item(created.id).builderSessionId as string;
    env.gh.openPr({
      sessionId: builder,
      title: "Add a counter",
      files: ["src/counter.ts", "test/counter.test.ts"],
      checks: "success",
    });
    await env.setStatus(builder, "idle");
    await tick();
    review(created.id);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toHaveLength(1);
  });
});
