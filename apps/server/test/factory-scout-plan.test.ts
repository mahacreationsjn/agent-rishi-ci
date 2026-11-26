import type { FactoryLoop, Session } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";

/**
 * `factory_plan_round` under load (#311): the scout's plan is recorded and the call returns at
 * once; the area reviewers start on later loop passes as agents free up, so a slow start or wake
 * never holds the scout's tool call, or the project's loop, for minutes. Reviewers that can't
 * start within 15 minutes close the round, and so does a round left unplanned.
 */

let env: FactoryEnv;
afterEach(() => env?.close());

const tick = () => env.factory.tick(env.project.id);
const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined) => env.repo.get(id as string);
const scoutStatus = async () => (await env.factory.status(env.project.id)).scout;
const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

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

function darkFactory(maxConcurrentSessions = 3) {
  env = createFactoryEnv({ limits: { maxConcurrentSessions } });
  env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions },
    tuning: { discoveryPerRound: 2, maxIssuesPerRound: 1 },
  });
}

/** A factory builder at work on issue #n: it holds an agent slot. */
function runningBuilder(n: number): string {
  const id = `builder-${n}`;
  env.repo.create(
    {
      ...sampleSession,
      id,
      projectId: env.project.id,
      startedBy: FACTORY_STARTER,
      workKey: `issue:${n}`,
      status: "running",
    },
    { workspaceMode: "worktree", workspaceFallback: null, forced: null, queuedBehind: [] },
  );
  return id;
}

/** Change the scout's part of the loop record, as time passing would. */
function saveScout(change: (l: FactoryLoop) => FactoryLoop["scout"]): void {
  const l = loop();
  env.factory.data.saveLoop({ ...l, scout: change(l) });
}

/**
 * Round 1 runs to its end with a `ux` area reviewer, then round 2 starts: the scout is planning
 * and the `ux` reviewer, idle between rounds, is reused. Returns the scout and the reviewer.
 */
async function secondRound(): Promise<{ scout: Session; lens: Session }> {
  darkFactory();
  await tick();
  const scout = session(loop().scout.sessionId);
  await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
  await tick();
  const lens = session(loop().scout.lensSessions.ux);
  await env.factory.reportFindings(lens, []);
  await env.setStatus(lens.id, "idle");
  await tick();
  await env.setStatus(scout.id, "idle");
  await tick();
  expect(loop().scout.round).toBeNull();
  // The interval passed (back-dated rather than moving the factory clock, which session
  // `updatedAt` doesn't follow, so turn checks keep working).
  saveScout((l) => ({ ...l.scout, lastRoundAt: minutesAgo(7 * 60) }));
  await tick();
  expect(loop().scout.round?.phase).toBe("planning");
  return { scout, lens };
}

/**
 * Waking the reviewer never finishes, as under load: a message to an idle long-lived session
 * resumes it on the runner, which may first recreate its worktree and run the project's setup.
 * Returns the wakes asked for.
 */
function wakingHangs(sessionId: string): string[] {
  const woken: string[] = [];
  const send = env.sessions.send.bind(env.sessions);
  env.sessions.send = ((id, req, from) => {
    if (id !== sessionId) return send(id, req, from);
    woken.push(req.input.text);
    return new Promise(() => {});
  }) as typeof send;
  return woken;
}

describe("factory_plan_round under load (#311)", () => {
  it("returns before any area reviewer starts, however long waking one takes", async () => {
    const { scout, lens } = await secondRound();
    const woken = wakingHangs(lens.id);
    const plan = env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "tables" }] });
    expect(await settlesWithin(plan, 2_000)).toBe(true);
    expect(await plan).toMatchObject({ lenses: [{ area: "ux", focus: "tables" }] });
    expect((await plan).next).toMatch(/End your turn now/);
    // Only recorded: the reviewer isn't woken yet, and the round waits for it.
    expect(woken).toEqual([]);
    expect(loop().scout.round).toMatchObject({ phase: "planning", plan: { pending: ["ux"] } });
    expect(await scoutStatus()).toMatchObject({ phase: "planning", waiting: ["ux"] });
  });

  it("never holds up the project's loop while area reviewers start", async () => {
    const { scout, lens } = await secondRound();
    const woken = wakingHangs(lens.id);
    void env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "tables" }] });
    expect(await settlesWithin(tick(), 2_000)).toBe(true);
    // The next pass woke it without waiting for the wake to finish.
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatch(/tables/);
    expect(loop().scout.round).toMatchObject({ phase: "reviewing", plan: { pending: [] } });
    expect(loop().scout.round?.lenses.map((l) => l.sessionId)).toEqual([lens.id]);
  });

  it("returns the same plan when the call is repeated, and starts nothing twice", async () => {
    darkFactory();
    await tick();
    const scout = session(loop().scout.sessionId);
    const req = { lenses: [{ area: "ux" as const, focus: "forms" }] };
    // Two calls in flight at once (a client that gave up and asked again): one plan.
    const [first, second] = await Promise.all([
      env.factory.planRound(scout, req),
      env.factory.planRound(scout, { lenses: [{ area: "bugs", focus: "saving" }] }),
    ]);
    expect(second).toEqual(first);
    expect(await env.factory.planRound(scout, req)).toEqual(first);
    await tick();
    expect(loop().scout.round?.phase).toBe("reviewing");
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout", "factory:lens:ux"]);
    const starts = env.starts.length;
    // A call whose answer the scout never got, repeated later (even with other areas).
    const again = await env.factory.planRound(scout, {
      lenses: [{ area: "security", focus: "the import endpoint" }],
    });
    expect(again).toEqual(first);
    await tick();
    expect(env.starts).toHaveLength(starts);
    expect(loop().scout.round?.lenses.map((l) => l.area)).toEqual(["ux"]);
  });

  it("starts area reviewers on later passes as agents free up", async () => {
    darkFactory(2);
    await tick();
    const scout = session(loop().scout.sessionId);
    await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
    // Builders take both agents before the next pass: the reviewer waits.
    const builder = runningBuilder(1);
    runningBuilder(2);
    await tick();
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout"]);
    expect(await scoutStatus()).toMatchObject({ phase: "planning", lenses: [], waiting: ["ux"] });
    // The scout ends its turn: no reminder while its plan waits for an agent.
    await env.setStatus(scout.id, "idle");
    await tick();
    expect(env.messages.filter((m) => m.sessionId === scout.id)).toHaveLength(0);
    expect(loop().scout.round?.phase).toBe("planning");
    // A builder ends its turn: the reviewer gets its agent.
    await env.setStatus(builder, "idle");
    await tick();
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout", "factory:lens:ux"]);
    expect(await scoutStatus()).toMatchObject({ phase: "reviewing", waiting: [] });
  });

  it("closes the round with a note when no agent is free for 15 minutes", async () => {
    darkFactory(2);
    await tick();
    const scout = session(loop().scout.sessionId);
    await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
    runningBuilder(1);
    runningBuilder(2);
    await tick();
    expect(loop().scout.round?.phase).toBe("planning");
    env.clock.offsetMs = 16 * 60_000;
    await tick();
    expect(env.starts.map((s) => s.workKey)).toEqual(["factory:scout"]);
    expect(loop().scout.round).toBeNull();
    // The next round is scheduled.
    expect(await scoutStatus()).toMatchObject({
      phase: "idle",
      lastRoundNote: "Closed: couldn't start area reviewers (ux): no free agent within 15 minutes.",
      lastRoundAt: expect.any(String),
      nextRoundAt: expect.any(String),
    });
  });

  it("closes a round left in planning without a plan 15 minutes after the scout's turn ended", async () => {
    const { scout } = await secondRound();
    // An earlier plan call never answered: the scout ended its turn having planned nothing, and
    // the server restarts 16 minutes later.
    await env.setStatus(scout.id, "idle");
    env.restart();
    env.clock.offsetMs = 16 * 60_000;
    const messages = env.messages.length;
    await tick();
    expect(loop().scout.round).toBeNull();
    expect(loop().scout.lastRoundAt).not.toBeNull();
    expect(loop().scout.lastRoundNote).toBe(
      "Closed: the scout ended its turn without planning the round.",
    );
    // Closed, not a reminder that wakes the scout.
    expect(env.messages).toHaveLength(messages);
  });

  it("queues at most one tick behind the one running, however often it is asked", async () => {
    darkFactory();
    // The first tick starts the scout's round, and starting its session doesn't finish.
    env.sessions.start = ((req) => {
      env.starts.push(req);
      return new Promise(() => {});
    }) as typeof env.sessions.start;
    const running = tick();
    await vi.waitFor(() => expect(env.starts).toHaveLength(1), { timeout: 10_000 });
    const queued = tick();
    expect(queued).not.toBe(running);
    expect(tick()).toBe(queued);
    expect(tick()).toBe(queued);
  });
});
