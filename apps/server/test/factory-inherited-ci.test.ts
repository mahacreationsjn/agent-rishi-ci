import type { FactoryItem } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import type { FakePr } from "./support/fake-factory-github";

/**
 * CI on main is red and every PR's CI runs on top of it (#516): a PR that fails only the checks
 * main fails waits for main instead of going back to its builder, is brought up to date once
 * main is green and is judged on that run. A PR that fails a check main passes is its own
 * failure. An item already failed on main's red CI goes back to verification once main is green.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, review, readAgainSoon } = factorySteps(() => env);

/** The checks that failed on main and on every PR on top of it in the incident. */
const RED = ["Build, test and install", "CI result"];

const updated = () => env.gh.updates.map((u) => u.number);
const merged = () => env.gh.merges.map((m) => m.number);
const ci = (id: string) => item(id).checks.find((c) => c.name === "ci");
const loop = () => env.factory.data.loopOrNew(env.project.id);
const reviseRounds = (id: string) =>
  env.messages.filter(
    (m) => m.sessionId === item(id).builderSessionId && /checks for your pull request/.test(m.text),
  ).length;

function start() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 8 } });
  return enable();
}

/** CI on main's head is red on `failed`, and was since now (GitHub's history of main). */
function mainRed(failed = RED) {
  Object.assign(env.gh.main, { checks: "failure", failed });
  env.gh.mainHistory.push({ at: env.now().toISOString(), ...env.gh.main });
}

function mainGreen(sha = "mainfix0001") {
  Object.assign(env.gh.main, { sha, checks: "success", failed: [] });
  env.gh.mainHistory.push({ at: env.now().toISOString(), ...env.gh.main });
}

/** A feature whose builder opened its PR, `files` changed, with CI as given. */
async function opened(
  title: string,
  issue: number,
  opts: { failed?: string[]; files?: string[]; source?: FactoryItem["source"] },
) {
  const created = backlogItem(title, issue);
  const { source } = opts;
  if (source) env.factory.data.updateItem(created.id, (i) => ({ ...i, source }));
  await tick();
  const builder = item(created.id).builderSessionId as string;
  const pr = env.gh.openPr({
    sessionId: builder,
    title,
    files: opts.files ?? ["src/counter.ts", "test/counter.test.ts"],
    checks: opts.failed ? "failure" : "success",
  });
  if (opts.failed) pr.failedChecks = opts.failed;
  return { id: created.id, pr, builder };
}

/** The builder ends its turn: the loop finds the PR and verifies it. */
async function verify<T extends { id: string; builder: string }>(built: T): Promise<T> {
  await env.setStatus(built.builder, "idle");
  await tick();
  await tick();
  return built;
}

describe("a PR whose CI fails only what fails on main", () => {
  it("waits for main: no revise round, nothing counted, and its ci check names main", async () => {
    start();
    mainRed();
    const { id } = await verify(await opened("Add a counter", 3, { failed: RED }));
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    expect(reviseRounds(id)).toBe(0);
    expect(ci(id)).toMatchObject({
      state: "pending",
      detail:
        "CI on main is red (Build, test and install, CI result on main000), and this PR fails only those checks: waiting for main to be green again",
    });
    // Ticks while main stays red change nothing.
    await tick();
    await tick();
    expect(item(id)).toMatchObject({ stage: "verifying", attempts: 0 });
    expect(loop().consecutiveFailures).toBe(0);
    expect(updated()).toEqual([]);
  });

  it("keeps waiting while CI runs on main, then is updated once main is green and merges", async () => {
    start();
    mainRed();
    const { id, pr } = await verify(await opened("Add a counter", 3, { failed: RED }));
    review(id);
    // A fix merged on main and its CI runs: main isn't known to be green yet.
    Object.assign(env.gh.main, { sha: "mainfix0001", checks: "pending", failed: [] });
    await tick();
    expect(ci(id)?.state).toBe("pending");
    expect(updated()).toEqual([]);

    mainGreen();
    await tick();
    expect(updated()).toEqual([pr.ref.number]);
    expect(ci(id)?.detail).toBe(
      "CI on main is green again: updating this PR with main, then CI runs on the new head",
    );
    expect(reviseRounds(id)).toBe(0);
    // Its CI passes on the fixed main: the approval still covers it (main was only merged in).
    Object.assign(pr, { checks: "success", failedChecks: [] });
    await tick();
    expect(merged()).toEqual([pr.ref.number]);
    expect(item(id)).toMatchObject({ stage: "watching", attempts: 0 });
  });

  it("is judged as usual once main is green when its CI then fails on its own", async () => {
    start();
    mainRed();
    const { id, pr } = await verify(await opened("Add a counter", 3, { failed: RED }));
    mainGreen();
    await tick();
    expect(updated()).toEqual([pr.ref.number]);
    // Red again on the fixed main: its own failure.
    Object.assign(pr, { checks: "failure", failedChecks: ["Build, test and install"] });
    await tick();
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
  });

  it("never holds up the merge queue, where the fix for main may be waiting", async () => {
    start();
    const a = await verify(
      await opened("Add a counter", 3, { files: ["src/a.ts", "test/a.test.ts"] }),
    );
    const b = await verify(await opened("Fix main", 4, { files: ["src/b.ts", "test/b.test.ts"] }));
    env.gh.pushMain(["src/broken.ts"]);
    mainRed();
    // Approved in order (A joins the queue first) while the loop holds merges.
    env.factory.data.saveLoop({ ...loop(), state: "paused", pausedReason: "held by the test" });
    for (const id of [a.id, b.id]) {
      review(id);
      await tick();
      later(1_000);
    }
    env.factory.resume(env.project.id);
    await tick();
    // Main is red: the first PR in line is re-tested on top of it, one at a time.
    expect(updated()).toEqual([a.pr.ref.number]);
    Object.assign(a.pr, { checks: "failure", failedChecks: RED });
    await tick();
    expect(ci(a.id)?.detail).toMatch(/^CI on main is red/);
    // A waits for main and is passed over: B, next in line, goes ahead.
    expect(updated()).toEqual([a.pr.ref.number, b.pr.ref.number]);
    b.pr.checks = "success";
    await tick();
    expect(merged()).toEqual([b.pr.ref.number]);
    expect(item(a.id)).toMatchObject({ stage: "verifying", attempts: 0 });
  });
});

describe("a PR whose CI fails a check main passes", () => {
  it("still gets a revise round", async () => {
    start();
    mainRed(["Build, test and install"]);
    const { id } = await verify(
      await opened("Add a counter", 3, { failed: ["Build, test and install", "lint"] }),
    );
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(reviseRounds(id)).toBe(1);
  });
});

describe("a repair of main whose CI fails only what fails on main", () => {
  it("still gets a revise round: it hasn't fixed main yet", async () => {
    start();
    mainRed();
    const { id } = await verify(
      await opened("Fix failing Build, test and install on the default branch", 3, {
        failed: RED,
        source: "failed_check",
      }),
    );
    expect(item(id)).toMatchObject({ stage: "building", attempts: 1 });
    expect(reviseRounds(id)).toBe(1);
    expect(ci(id)?.state).toBe("fail");
  });
});

describe("an item failed on main's red CI before the factory waited for main", () => {
  /** What the factory left before #516: failed on CI that only main's failure made red. */
  function failedAsBefore(id: string, pr: FakePr, failed = RED) {
    const at = env.now().toISOString();
    const detail = `CI failed: ${failed.join(", ")}`;
    env.factory.data.updateItem(id, (i) => ({
      ...i,
      stage: "failed",
      pr: pr.ref,
      attempts: 2,
      checks: [{ name: "ci", state: "fail", detail, escalate: false, at }],
      reason: `ci: ${detail}`,
      failureKind: "checks",
      finishedAt: at,
    }));
  }

  it("goes back to verification once main is green, is updated and merges", async () => {
    start();
    const built = await opened("Add a counter", 3, { failed: RED });
    mainRed();
    later(60_000);
    failedAsBefore(built.id, built.pr);
    await env.setStatus(built.builder, "idle");
    // Main is still red: it stays failed for now.
    await tick();
    expect(item(built.id).stage).toBe("failed");

    later(60_000);
    mainGreen();
    readAgainSoon(built.id);
    await tick();
    expect(item(built.id)).toMatchObject({
      stage: "verifying",
      reason: null,
      failureKind: null,
      note: "Back in verification: its CI failed only on checks that were red on main too (Build, test and install, CI result); re-tested now that main is green",
    });
    await tick();
    expect(updated()).toEqual([built.pr.ref.number]);
    review(built.id);
    Object.assign(built.pr, { checks: "success", failedChecks: [] });
    await tick();
    expect(merged()).toEqual([built.pr.ref.number]);
  });

  it("stays failed when main was green as it failed", async () => {
    start();
    const built = await opened("Add a counter", 3, { failed: ["Build, test and install"] });
    later(60_000);
    failedAsBefore(built.id, built.pr, ["Build, test and install"]);
    await env.setStatus(built.builder, "idle");
    await tick();
    readAgainSoon(built.id);
    await tick();
    expect(item(built.id).stage).toBe("failed");
    expect(updated()).toEqual([]);
  });

  it("stays failed when it was a repair of main: main was fixed without it", async () => {
    start();
    const built = await opened("Fix failing CI on the default branch", 3, {
      failed: RED,
      source: "failed_check",
    });
    mainRed();
    later(60_000);
    failedAsBefore(built.id, built.pr);
    await env.setStatus(built.builder, "idle");
    later(60_000);
    mainGreen();
    readAgainSoon(built.id);
    await tick();
    expect(item(built.id).stage).toBe("failed");
    expect(updated()).toEqual([]);
  });
});
