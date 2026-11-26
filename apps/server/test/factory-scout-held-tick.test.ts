import type { Session } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * The scout's and its area reviewers' tools while a loop pass is held (#311): each answers in
 * under a second instead of waiting behind the tick, and the tick, which read the loop before,
 * keeps what they recorded when it saves. Each is safe to repeat after a timeout.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined) => env.repo.get(id as string);
const finding = {
  title: "Editor loses focus",
  summary: "Typing in the editor loses focus after a save",
  type: "bug" as const,
  severity: "medium" as const,
  acceptanceCriteria: ["Focus stays after a save"],
};

/**
 * Whether the promise settles within `ms`. Only a bound for a failing run: a passing one
 * settles at once.
 */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    const settled = p.then(
      () => true,
      () => true,
    );
    return await Promise.race([settled, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function darkFactory(): Promise<Session> {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 3 } });
  await env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions: 3 },
    tuning: { discoveryPerRound: 2, maxIssuesPerRound: 2 },
  });
  await tick();
  expect(loop().scout.round?.phase).toBe("planning");
  return session(loop().scout.sessionId);
}

/**
 * Start a tick and hold it mid-pass (reading the default branch's head, after it read the loop)
 * until the returned `release` is called; `done` is the tick.
 */
async function heldTick(): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const mainHead = env.gh.mainHead.bind(env.gh);
  env.gh.mainHead = (async () => {
    entered = true;
    await held;
    return mainHead();
  }) as typeof env.gh.mainHead;
  const done = tick();
  await vi.waitFor(() => expect(entered).toBe(true), { timeout: 10_000 });
  return { release, done };
}

describe("the scout's tools while a loop pass is held (#311)", () => {
  it("plans in under a second, and the held pass starts the reviewer instead of a reminder", async () => {
    const scout = await darkFactory();
    const pass = await heldTick();
    const plan = env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
    expect(await settlesWithin(plan, 1_000)).toBe(true);
    expect(loop().scout.round?.plan?.pending).toEqual(["ux"]);
    // The scout ends its turn; the pass, which read the loop before the plan, carries on.
    await env.setStatus(scout.id, "idle");
    const messages = env.messages.length;
    pass.release();
    await pass.done;
    expect(loop().scout.round).toMatchObject({ phase: "reviewing", plan: { pending: [] } });
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout", "factory:lens:ux"]);
    expect(env.messages.slice(messages).map((m) => m.sessionId)).not.toContain(scout.id);
  });

  it("plans a round without area reviewers in under a second while a pass is held", async () => {
    const scout = await darkFactory();
    const pass = await heldTick();
    const plan = env.factory.planRound(scout, { lenses: [] });
    expect(await settlesWithin(plan, 1_000)).toBe(true);
    expect((await plan).next).toMatch(/Review by yourself now/);
    pass.release();
    await pass.done;
    // The pass, which read the loop before the plan, kept it.
    expect(loop().scout.round).toMatchObject({ phase: "filing", plan: { lenses: [] } });
  });

  it("records findings in under a second, keeps them through the held pass, and once only", async () => {
    const scout = await darkFactory();
    await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
    await tick();
    const lens = session(loop().scout.lensSessions.ux);
    const pass = await heldTick();
    const report = env.factory.reportFindings(lens, [finding]);
    expect(await settlesWithin(report, 1_000)).toBe(true);
    expect(await report).toMatchObject({ recorded: 1 });
    // A retry after a timeout records nothing twice.
    expect(await env.factory.reportFindings(lens, [finding])).toMatchObject({
      recorded: 0,
      message: "Already reported this round.",
    });
    pass.release();
    await pass.done;
    // The held pass kept the findings and gave them to the scout to file.
    expect(loop().scout.round?.findings.map((f) => f.id)).toEqual(["ux-1"]);
    expect(loop().scout.round?.phase).toBe("filing");
    expect(env.messages.at(-1)?.sessionId).toBe(scout.id);
    expect(env.messages.at(-1)?.text).toContain("Editor loses focus");
  });

  it("files an issue in under a second, once, and the held pass keeps the count", async () => {
    const scout = await darkFactory();
    await env.factory.planRound(scout, { lenses: [] });
    expect(loop().scout.round?.phase).toBe("filing");
    const pass = await heldTick();
    const issue = { ...finding, priority: "high" as const };
    const filed = env.factory.fileIssue(scout, issue);
    expect(await settlesWithin(filed, 1_000)).toBe(true);
    // A retry after a timeout gets the issue the first call filed.
    expect(await env.factory.fileIssue(scout, issue)).toEqual(await filed);
    expect(env.gh.issues).toHaveLength(1);
    pass.release();
    await pass.done;
    expect(loop().scout.round?.filed).toBe(1);
  });

  it("files once when the retry arrives while the first call still waits on GitHub", async () => {
    const scout = await darkFactory();
    await env.factory.planRound(scout, { lenses: [] });
    let answer = () => {};
    const github = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const createIssue = env.gh.createIssue.bind(env.gh);
    env.gh.createIssue = (async (...args: Parameters<typeof createIssue>) => {
      await github;
      return createIssue(...args);
    }) as typeof createIssue;
    const issue = { ...finding, priority: "high" as const };
    const first = env.factory.fileIssue(scout, issue);
    const retry = env.factory.fileIssue(scout, issue);
    answer();
    expect(await retry).toEqual(await first);
    expect(env.gh.issues).toHaveLength(1);
    expect(loop().scout.round?.filed).toBe(1);
  });
});
