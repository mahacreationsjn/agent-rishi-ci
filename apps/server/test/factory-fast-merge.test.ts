import type { FactoryLimits } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  clashGroup,
  fastMergeVerdict,
  strictProtectionInboxId,
} from "../src/services/factory/fast-merge";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * The merge queue's fast policy (#301): every queued PR that is ready merges on the same tick,
 * and one that is behind main merges on its own green CI whenever GitHub can merge it. It is
 * re-tested against main (update-branch, CI on the new head) only when it and main both changed
 * dependency files or migrations, when GitHub's merge state names something a merge can't pass,
 * when branch protection wants it up to date, or while CI on main is red. Merges stacked on an
 * unverified main are judged in order.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, review } = factorySteps(() => env);

function start(limits: Partial<FactoryLimits> = {}) {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 8, ...limits } });
  return enable();
}

/** A feature built until its PR, changing `files` and a test of its own, is in verification. */
async function build(title: string, issue: number, files: string[]) {
  const created = backlogItem(title, issue);
  await tick();
  const builder = item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title,
    files: [...files, `test/issue-${issue}.test.ts`],
  });
  await env.setStatus(builder, "idle");
  await tick();
  expect(item(created.id).stage).toBe("verifying");
  return { id: created.id, pr };
}

/** Approve each item, oldest first, while the loop holds merges; then let the queue go. */
async function approveInOrder(...ids: string[]) {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
  for (const id of ids) {
    review(id);
    await tick();
    later(1_000);
  }
  env.factory.resume(env.project.id);
}

const updated = () => env.gh.updates.map((u) => u.number);
const merged = () => env.gh.merges.map((m) => m.number);
const refusals = (id: string) =>
  Object.keys(item(id).nudges).filter((k) => k.startsWith("refused_"));
const loop = () => env.factory.data.loopOrNew(env.project.id);
const MIGRATION = (name: string) => `apps/server/drizzle/${name}/migration.sql`;

describe("which changes are tested on top of each other", () => {
  it("groups dependency files and migrations, and nothing else", () => {
    for (const path of [
      "pnpm-lock.yaml",
      "apps/web/package-lock.json",
      "package.json",
      "apps/web/package.json",
      "pnpm-workspace.yaml",
      "services/api/go.mod",
      "requirements-dev.txt",
      "vendor/custom.lock",
      "go.sum",
    ])
      expect(clashGroup(path), path).toBe("dependencies");
    for (const path of [
      "apps/server/drizzle/0042_fast.sql",
      "db/migrations/001_init.sql",
      "src/db/add-user-migration.ts",
      "prisma/schema.prisma",
    ])
      expect(clashGroup(path), path).toBe("migrations");
    for (const path of [
      "apps/server/src/services/factory/queue.ts",
      "packages/contracts/src/index.ts",
      ".github/workflows/ci.yml",
      "tsconfig.json",
      "apps/web/vite.config.ts",
      "docs/software-factory.md",
      "apps/server/test/migrations.test.ts",
      "test/config.test.ts",
    ])
      expect(clashGroup(path), path).toBeNull();
  });

  it("merges fast unless both sides changed the same kind of clashing files", () => {
    const pr = { files: ["src/a.ts"], mergeState: "clean" as const };
    const main = { behind: 2, files: ["src/b.ts"], complete: true };
    const verdict = (patch: Partial<Parameters<typeof fastMergeVerdict>[0]>) =>
      fastMergeVerdict({ branch: "main", hold: null, pr, main, ...patch });
    expect(verdict({})).toEqual({ fast: true });
    // GitHub reports conflicts: the same file on both sides is its call, not a reason to re-test.
    expect(verdict({ main: { ...main, files: ["src/a.ts"] } })).toEqual({ fast: true });
    // One side only: a migration on main, a lockfile in the PR, one of each.
    expect(verdict({ main: { ...main, files: [MIGRATION("0001_a")] } })).toEqual({ fast: true });
    expect(verdict({ pr: { ...pr, files: ["pnpm-lock.yaml"] } })).toEqual({ fast: true });
    expect(
      verdict({
        pr: { ...pr, files: ["package.json"] },
        main: { ...main, files: [MIGRATION("0001_a")] },
      }),
    ).toEqual({ fast: true });
    // Merge states that lag behind the checks the factory read itself.
    for (const mergeState of ["has_hooks", "unstable", "unknown"] as const)
      expect(verdict({ pr: { ...pr, mergeState } }), mergeState).toEqual({ fast: true });

    expect(
      verdict({
        pr: { ...pr, files: ["src/a.ts", MIGRATION("0002_b")] },
        main: { ...main, files: [MIGRATION("0001_a")] },
      }),
    ).toMatchObject({
      reason: `it and main both changed database migrations (${MIGRATION("0002_b")}; on main: ${MIGRATION("0001_a")})`,
    });
    expect(
      verdict({
        pr: { ...pr, files: ["apps/web/package.json"] },
        main: { ...main, files: ["pnpm-lock.yaml", "package.json"] },
      }),
    ).toMatchObject({
      reason:
        "it and main both changed dependency files (apps/web/package.json; on main: pnpm-lock.yaml (+1 more))",
    });
    // A rename counts its old path: the PR moved a migration main also changed files next to.
    expect(
      verdict({
        pr: { ...pr, files: ["docs/old.sql"], renamedFrom: ["db/migrations/001.sql"] },
        main: { ...main, files: ["db/migrations/002.sql"] },
      }),
    ).toMatchObject({ fast: false });
  });

  it("re-tests on a hold, a merge state a merge can't pass, or file lists cut short", () => {
    const pr = { files: ["src/a.ts"], mergeState: "clean" as const };
    const main = { behind: 2, files: ["src/b.ts"], complete: true };
    const verdict = (patch: Partial<Parameters<typeof fastMergeVerdict>[0]>) =>
      fastMergeVerdict({ branch: "main", hold: null, pr, main, ...patch });
    expect(verdict({ hold: "CI on main is red" })).toMatchObject({ fast: false });
    expect(verdict({ pr: { ...pr, mergeState: "behind" } })).toMatchObject({
      fast: false,
      protection: true,
    });
    for (const mergeState of ["blocked", "draft", "dirty"] as const)
      expect(verdict({ pr: { ...pr, mergeState } }), mergeState).toMatchObject({
        reason: `GitHub reports its merge state as ${mergeState}`,
      });
    expect(verdict({ main: { ...main, complete: false } })).toMatchObject({
      reason: "too many changed files to compare",
    });
    expect(verdict({ pr: { ...pr, changedFiles: 3001 } })).toMatchObject({ fast: false });
  });
});

describe("the fast merge policy", () => {
  it("merges every ready PR on the same tick, each on its own CI", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    // B changes a file A also changes: GitHub reports no conflict, so it merges all the same.
    const b = await build("Count twice", 4, ["src/counter.ts", "src/twice.ts"]);
    const c = await build("Add a timer", 5, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id, c.id);
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number, c.pr.ref.number]);
    // No update-branch and no second CI run for any of them.
    expect(updated()).toEqual([]);
    expect(item(a.id).mergePath).toBe("current");
    expect(item(b.id)).toMatchObject({
      stage: "watching",
      mergePath: "fast",
      note: "Merged on its own CI (1 commit behind main, no conflicts); watching CI on main",
    });
    expect(item(c.id)).toMatchObject({
      mergePath: "fast",
      note: "Merged on its own CI (2 commits behind main, no conflicts); watching CI on main",
    });
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({
      fastMerges7d: 2,
      retestedMerges7d: 0,
    });
  });

  it("gives GitHub a moment to work out the next PR after a merge, then merges it", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    await approveInOrder(a.id, b.id);
    // After a merge the other PRs read "unknown" twice: the pass waits and reads again.
    env.gh.settleReads = 2;
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);

    // GitHub takes longer than the pass waits: C merges on the next tick, never re-tested.
    const d = await build("Add a calendar", 6, ["src/calendar.ts"]);
    await approveInOrder(c.id, d.id);
    env.gh.settleReads = 5;
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number, c.pr.ref.number]);
    expect(item(d.id).note).toBe("Every check passed; waiting for GitHub to work out the merge");
    await tick();
    expect(merged()).toContain(d.pr.ref.number);
    expect(updated()).toEqual([]);
  });

  it("tries again when GitHub says the base branch was modified, without counting a refusal", async () => {
    await start();
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    env.gh.pushMain(["docs/notes.md"]);
    env.gh.baseMovedRefusals = 1;
    review(b.id);
    await tick();
    expect(merged()).toEqual([]);
    expect(updated()).toEqual([]);
    expect(refusals(b.id)).toEqual([]);
    expect(item(b.id).note).toBe("Every check passed; waiting for GitHub to work out the merge");
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("fast");
  });

  it("doesn't hold ready PRs behind one that waits for CI on a new head", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id);
    // A's branch gets a new head with the same change (its approval stands); CI runs again.
    env.gh.rebase(a.pr, "rebased-a", "pending");
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    a.pr.checks = "success";
    await tick();
    expect(merged()).toEqual([b.pr.ref.number, a.pr.ref.number]);
    expect(updated()).toEqual([]);
  });

  it("tests two migrations one on top of the other, and lets the rest merge meanwhile", async () => {
    await start();
    const a = await build("Add users", 3, ["src/users.ts", MIGRATION("0001_users")]);
    const b = await build("Add teams", 4, ["src/teams.ts", MIGRATION("0002_teams")]);
    const c = await build("Add roles", 5, ["src/roles.ts", MIGRATION("0003_roles")]);
    const d = await build("Add a timer", 6, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id, c.id, d.id);
    await tick();
    // A merges. B is behind a migration and has one itself: re-tested. C has one too: it waits
    // for B instead of being re-tested twice. D changes none and merges on its own CI.
    expect(merged()).toEqual([a.pr.ref.number, d.pr.ref.number]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toBe(
      `Re-testing against main (it and main both changed database migrations (${MIGRATION("0002_teams")}; on main: ${MIGRATION("0001_users")})): updating it (1 commit behind), then CI runs on the new head`,
    );
    expect(item(c.id).note).toBe(
      `Every check passed; merges after #${b.pr.ref.number} (both change database migrations, so it is tested on top of it)`,
    );

    // B's CI passes on the new head: it merges, and C is tested on top of it in turn.
    await tick();
    expect(merged()).toHaveLength(2);
    b.pr.checks = "success";
    await tick();
    expect(merged()).toContain(b.pr.ref.number);
    expect(item(b.id).mergePath).toBe("retested");
    expect(updated()).toEqual([b.pr.ref.number, c.pr.ref.number]);
    c.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toContain(c.pr.ref.number);
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({
      fastMerges7d: 1,
      retestedMerges7d: 2,
    });
  });

  it.each<{ case: string; files: string[]; onMain: string[]; pr?: Partial<FakePr> }>([
    {
      case: "a lockfile change in the PR only",
      files: ["src/timer.ts", "pnpm-lock.yaml"],
      onMain: ["docs/notes.md"],
    },
    {
      case: "a migration on main only",
      files: ["src/timer.ts"],
      onMain: ["apps/server/drizzle/0042_fast.sql"],
    },
    {
      case: "a shared barrel changed on both sides",
      files: ["src/timer.ts", "packages/contracts/src/index.ts"],
      onMain: ["packages/contracts/src/index.ts"],
    },
    {
      case: "a merge state that lags behind its checks",
      files: ["src/timer.ts"],
      onMain: ["docs/notes.md"],
      pr: { mergeState: "unstable" },
    },
  ])("merges on its own CI despite $case", async ({ files, onMain, pr }) => {
    await start();
    const b = await build("Add a timer", 4, files);
    Object.assign(b.pr, pr ?? {});
    env.gh.pushMain(onMain);
    review(b.id);
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(updated()).toEqual([]);
    expect(item(b.id).mergePath).toBe("fast");
  });

  it.each<{
    case: string;
    files: string[];
    onMain: string[];
    pr?: Partial<FakePr>;
    why: RegExp;
  }>([
    {
      case: "dependency changes on both sides",
      files: ["src/timer.ts", "pnpm-lock.yaml"],
      onMain: ["apps/web/package.json"],
      why: /it and main both changed dependency files \(pnpm-lock\.yaml; on main: apps\/web\/package\.json\)/,
    },
    {
      case: "a migration on both sides",
      files: ["src/timer.ts", "apps/server/drizzle/0043_timer.sql"],
      onMain: ["apps/server/drizzle/0042_fast.sql"],
      why: /it and main both changed database migrations/,
    },
    {
      case: "a merge state a merge can't pass",
      files: ["src/timer.ts"],
      onMain: ["docs/notes.md"],
      pr: { mergeState: "blocked" },
      why: /GitHub reports its merge state as blocked/,
    },
    {
      case: "more files than GitHub lists",
      files: ["src/timer.ts"],
      onMain: ["docs/notes.md"],
      pr: { changedFiles: 3001 },
      why: /too many changed files to compare/,
    },
  ])("re-tests on $case", async ({ files, onMain, pr, why }) => {
    await start();
    const b = await build("Add a timer", 4, files);
    Object.assign(b.pr, pr ?? {});
    env.gh.pushMain(onMain);
    review(b.id);
    await tick();
    expect(merged()).toEqual([]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toMatch(/^Re-testing against main \(/);
    expect(item(b.id).note).toMatch(why);
  });

  it("goes strict without counting a refusal when branch protection wants PRs up to date, and says so once", async () => {
    await start();
    env.gh.requireUpToDate = true;
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    env.gh.pushMain(["docs/notes.md"]);
    review(b.id);
    await tick();
    // GitHub reports the merge state `behind`: the strict path, and the user hears why.
    expect(merged()).toEqual([]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toMatch(/branch protection requires it to be up to date with main/);
    expect(refusals(b.id)).toEqual([]);
    const notice = env.inbox.find(strictProtectionInboxId(env.project.id));
    expect(notice).toMatchObject({ status: "open", notify: "factory", priority: "low" });
    env.inbox.close(notice as NonNullable<typeof notice>, "dismissed", { note: "seen" });
    b.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("retested");

    // GitHub's merge state lags and says clean, but it refuses the merge: no refusal counted,
    // the same head goes strict at once, and the notice isn't raised again.
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    c.pr.mergeState = "clean";
    env.gh.pushMain(["docs/more-notes.md"]);
    review(c.id);
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(updated()).toEqual([b.pr.ref.number, c.pr.ref.number]);
    expect(refusals(c.id)).toEqual([]);
    expect(item(c.id).note).toMatch(
      /GitHub didn't merge it on its own CI: Head branch is out of date/,
    );
    expect(env.inbox.find(strictProtectionInboxId(env.project.id))?.status).toBe("dismissed");
  });

  it("re-tests one PR at a time where branch protection wants PRs up to date", async () => {
    await start();
    env.gh.requireUpToDate = true;
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    env.gh.pushMain(["docs/notes.md"]);
    await approveInOrder(a.id, b.id);
    await tick();
    // Each merge puts the others behind again, so only the first in line is brought up to date.
    expect(updated()).toEqual([a.pr.ref.number]);
    expect(item(b.id).note).toBe("Every check passed; queued to merge (number 2 in line)");
    a.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toEqual([a.pr.ref.number]);
    expect(updated()).toEqual([a.pr.ref.number, b.pr.ref.number]);
  });

  it("reverts a fast merge that breaks main, then re-tests every PR until main is green", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    const d = await build("Add a calendar", 6, ["src/calendar.ts"]);
    await approveInOrder(a.id, b.id);
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("fast");

    // CI on main fails after B: the watch reverts it, pauses the loop and holds fast merges.
    env.gh.commitState.set(item(b.id).mergeSha as string, "failure");
    env.gh.main.checks = "failure";
    await tick();
    expect(item(b.id).stage).toBe("reverted");
    expect(env.gh.reverts.map((r) => r.prNumber)).toEqual([b.pr.ref.number]);
    expect(loop()).toMatchObject({
      state: "paused",
      fastMergeHold: `CI on main failed after #${b.pr.ref.number} merged`,
    });

    // Resumed while main is still red: C changes nothing that clashes, but it is re-tested.
    review(c.id);
    env.factory.resume(env.project.id);
    await tick();
    expect(updated()).toEqual([c.pr.ref.number]);
    expect(item(c.id).note).toMatch(/fast merges resume once it is green/);
    c.pr.checks = "success";
    await tick();
    expect(merged()).toContain(c.pr.ref.number);
    expect(item(c.id).mergePath).toBe("retested");

    // Main is green again: D merges on its own CI.
    env.gh.main.checks = "success";
    review(d.id);
    await tick();
    expect(merged()).toContain(d.pr.ref.number);
    expect(updated()).toEqual([c.pr.ref.number]);
    expect(item(d.id).mergePath).toBe("fast");
    expect(loop().fastMergeHold).toBeNull();
    expect((await env.factory.status(env.project.id)).stats).toMatchObject({
      fastMerges7d: 2,
      retestedMerges7d: 1,
      fastReverts7d: 1,
    });
  });

  it("judges merges stacked on an unverified main in order, and reverts only the one that broke it", async () => {
    await start();
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    await approveInOrder(a.id, b.id);
    env.gh.commitState.set(`merge${a.pr.ref.number}`, "pending");
    env.gh.commitState.set(`merge${b.pr.ref.number}`, "pending");
    // CI on main still runs after A: B merges on top of it on the same tick.
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(a.id).stage).toBe("watching");
    expect(item(b.id).nudges[`merged_after_${a.id}`]).toBeDefined();

    // B's CI fails first: it waits for the verdict on A, merged before it.
    env.gh.commitState.set(`merge${b.pr.ref.number}`, "failure");
    await tick();
    expect(item(b.id)).toMatchObject({
      stage: "watching",
      note: `CI on main failed; waiting for the verdict on #${a.pr.ref.number}, merged before it`,
    });
    expect(env.gh.reverts).toEqual([]);

    // A broke main: A is reverted, and B isn't blamed for it.
    env.gh.commitState.set(`merge${a.pr.ref.number}`, "failure");
    await tick();
    await tick();
    expect(env.gh.reverts.map((r) => r.prNumber)).toEqual([a.pr.ref.number]);
    // A's revert merged and main is green: A went back to its builder, still on record as reverted.
    expect(item(a.id).nudges.reverted_at).toBeDefined();
    expect(item(a.id).stage).toBe("building");
    expect(item(b.id).stage).toBe("merged");
    expect(item(b.id).note).toMatch(
      new RegExp(`#${a.pr.ref.number} merged before it, broke it and is being reverted`),
    );
  });
});

describe("the strict merge policy", () => {
  it("always brings a PR behind main up to date first, one at a time", async () => {
    await start({ mergePolicy: "strict" });
    const a = await build("Add a counter", 3, ["src/counter.ts"]);
    const b = await build("Add a timer", 4, ["src/timer.ts"]);
    const c = await build("Add a clock", 5, ["src/clock.ts"]);
    await approveInOrder(a.id, b.id, c.id);
    await tick();
    expect(merged()).toEqual([a.pr.ref.number]);
    expect(updated()).toEqual([b.pr.ref.number]);
    expect(item(b.id).note).toBe(
      "Updating it with main (1 commit behind), then CI runs on the new head",
    );
    expect(item(c.id).note).toBe("Every check passed; queued to merge (number 2 in line)");
    await tick();
    expect(updated()).toEqual([b.pr.ref.number]);
    b.pr.checks = "success";
    await tick();
    await tick();
    expect(merged()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    expect(item(b.id).mergePath).toBe("retested");
    expect(updated()).toEqual([b.pr.ref.number, c.pr.ref.number]);
    expect(loop().fastMergeHold).toBeNull();
  });
});
