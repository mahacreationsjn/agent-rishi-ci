import { join } from "node:path";
import { agentEventToNewEvent, type FactoryItem, type Session } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_STARTER } from "../src/services/factory/sessions";
import { sampleSession } from "./helpers";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #411: factory sessions that failed for provider reasons (a CLI too old, a sign-in that
 * expired, a usage limit) were replaced by a fresh session that did the work, but the failed
 * ones were never archived: they stayed in the sidebar as red "Failed" rows long after their
 * items merged. A failed session is archived once its replacement has started, and with its
 * item when the item finishes; a one-time sweep archives the ones left from before. A failed
 * session that is still the item's current one stays, since it needs attention.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, enable, backlogItem, openPr, review, verifying } = factorySteps(() => env);

const TOO_OLD = "Gemini CLI 0.36.0 is older than 0.68.0, the oldest Agent Rishi supports.";

/** One loop step, then the archives it queued. */
const tick = async () => {
  await env.factory.tick(env.project.id);
  await env.factory.archiver.idle();
};
/** Let the background provider detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));
const session = (id: string) => env.repo.get(id);
const reviewerOf = (id: string) => item(id).reviewerSessionId as string;

/** The runner refused to open the session (its CLI is too old): it failed before it started. */
function refusedOpen(sessionId: string) {
  env.repo.update(sessionId, (s) => ({
    ...s,
    status: "failed",
    startError: { code: "open_failed", message: TOO_OLD, kind: "setup" },
  }));
}

/** The session's turn fails on its provider's usage limit; it waits idle for a retry. */
function hitsUsageLimit(sessionId: string) {
  const T = `t-${sessionId}`;
  const retryAt = new Date(Date.now() + 30 * 60_000).toISOString();
  env.store.append(
    [
      { type: "thread.started", thread: { id: T } } as const,
      { type: "turn.started", threadId: T, turnId: "u1" } as const,
      {
        type: "turn.failed",
        threadId: T,
        turnId: "u1",
        error: { message: "Usage limit", kind: "usage_limit", retryAt },
      } as const,
    ].map((e) => agentEventToNewEvent(sessionId, e)),
  );
  env.repo.update(sessionId, (s) => ({ ...s, status: "idle" }));
}

/**
 * A feature PR in verification whose first reviewer, on Gemini, failed to open; the factory
 * started a fresh reviewer on another provider. `cleanWorktree`: the builder's worktree was
 * cleaned up while the item waited, so the reviewers work in worktrees of their own.
 */
async function replacedReviewer(opts: { cleanWorktree?: boolean } = {}) {
  env = createFactoryEnv({ providers: ["claude", "codex", "gemini"] });
  enable("dark_factory", {
    tuning: { builderProvider: "claude", reviewerProvider: "gemini", reviewerFallback: "any" },
  });
  await tick();
  await settle();
  const created = backlogItem("Add a counter", 3);
  await tick();
  const { builder } = await openPr(created.id);
  if (opts.cleanWorktree) {
    env.repo.update(builder, (s) => ({ ...s, worktreeRemovedAt: new Date().toISOString() }));
  }
  await tick();
  const failed = reviewerOf(created.id);
  expect(session(failed).provider).toBe("gemini");
  refusedOpen(failed);
  await tick(); // The failed reviewer is let go...
  await tick(); // ...and a fresh one starts elsewhere.
  const replacement = reviewerOf(created.id);
  expect(replacement).toBeTruthy();
  expect(replacement).not.toBe(failed);
  expect(session(replacement).provider).not.toBe("gemini");
  return { id: created.id, builder, failed, replacement };
}

/** Review, merge and wait out main CI until the item is merged and cleaned up. */
async function mergeAndClean(id: string, replacement: string) {
  review(id);
  await tick();
  await env.setStatus(replacement, "idle");
  for (let n = 0; n < 4 && !item(id).sessionsArchivedAt; n++) await tick();
  expect(item(id).stage).toBe("merged");
  expect(item(id).sessionsArchivedAt).not.toBeNull();
}

const old = "2026-11-14T16:00:00.000Z";
const meta = { workspaceMode: "worktree", workspaceFallback: null, forced: null } as const;

/** A factory session as an earlier version left it (in a worktree of its own by default). */
function factorySession(id: string, patch: Partial<Session>): string {
  const worktree = join(env.dir, "wt", id);
  env.repo.create(
    {
      ...sampleSession,
      id,
      projectId: env.project.id,
      role: "agent",
      startedBy: FACTORY_STARTER,
      status: "completed",
      cwd: worktree,
      worktreePath: worktree,
      createdAt: old,
      updatedAt: old,
      ...patch,
    },
    { ...meta, queuedBehind: [] },
  );
  return id;
}

/** An item as an earlier version left it. */
function oldItem(patch: Partial<FactoryItem>): FactoryItem {
  const created = env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${patch.issue?.number ?? 1}`,
    title: patch.title ?? "Old work",
    summary: "From before",
    source: "issue",
    stage: "merged",
  });
  return env.factory.data.updateItem(created.id, (i) => ({ ...i, ...patch }), { touch: false });
}

const pr = (number: number) => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  state: "merged" as const,
});

describe("failed factory sessions are archived (#411)", () => {
  it("archives a failed reviewer once its replacement has started", async () => {
    const { id, failed, replacement } = await replacedReviewer();
    expect(session(failed).archivedAt).not.toBeNull();
    expect(env.archived).toEqual([failed]);
    // The replacement keeps working, and the item still knows the failed session.
    expect(session(replacement).archivedAt).toBeNull();
    expect(item(id).sessionIds).toEqual(expect.arrayContaining([failed, replacement]));
  });

  it("archives a reviewer stopped at its usage limit only once a fresh one has started", async () => {
    env = createFactoryEnv();
    enable();
    const { id } = await verifying("pending");
    const first = reviewerOf(id);
    hitsUsageLimit(first);
    await tick();
    // The factory stopped it and let it go; nothing has replaced it yet, so it stays.
    expect(session(first).status).toBe("stopped");
    expect(item(id).reviewerSessionId).toBeNull();
    expect(session(first).archivedAt).toBeNull();
    await tick();
    const fresh = reviewerOf(id);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(first);
    expect(session(first).archivedAt).not.toBeNull();
    expect(session(fresh).archivedAt).toBeNull();
  });

  it("archives an item's failed sessions when it merges, wherever they worked", async () => {
    const { id, builder, failed, replacement } = await replacedReviewer({ cleanWorktree: true });
    // The reviewers worked in worktrees of their own, not in the builder's.
    expect(session(failed).worktreePath).not.toBeNull();
    expect(session(failed).cwd).not.toBe(session(builder).worktreePath);
    await mergeAndClean(id, replacement);
    expect(session(replacement).archivedAt).not.toBeNull();
    expect(session(builder).archivedAt).not.toBeNull();
    expect(session(failed).archivedAt).not.toBeNull();
    expect(session(failed).worktreeRemovedAt).not.toBeNull();
  });

  it("archives a finished item's failed sessions it never recorded as earlier ones", async () => {
    env = createFactoryEnv();
    enable();
    await tick(); // The one-time sweep is done: this is the cleanup of a finished item.
    // In flight during the upgrade: an earlier version let its failed reviewer go without
    // recording it. The reviewer that approved worked in the builder's worktree; the failed one
    // in a worktree of its own.
    const builder = factorySession("b-260", { workKey: "issue:260", status: "idle" });
    const worktree = session(builder).worktreePath as string;
    const reviewer = factorySession("r-261", {
      workKey: "factory:review:261",
      status: "idle",
      cwd: worktree,
      worktreePath: null,
    });
    const failed = factorySession("x-261", { workKey: "factory:review:261", status: "failed" });
    const merged = oldItem({
      workKey: "issue:260",
      stage: "merged",
      pr: pr(261),
      builderSessionId: builder,
      reviewerSessionId: reviewer,
      sessionIds: [builder, failed, reviewer],
      finishedAt: old,
    });
    await tick();
    expect(item(merged.id).sessionsArchivedAt).not.toBeNull();
    expect([...env.archived].sort()).toEqual([builder, failed, reviewer].sort());
    // The builder goes last, so its worktree isn't kept for a session still shown in it.
    expect(env.archived.at(-1)).toBe(builder);
    expect(session(failed).worktreeRemovedAt).not.toBeNull();
  });
});

describe("the one-time sweep of failed sessions left from before (#411)", () => {
  it("archives superseded failed sessions and leaves an item's current failed one", async () => {
    env = createFactoryEnv();
    enable();
    // A merged item: its builder and the reviewer that approved were archived with it (someone
    // restored the builder since, which stopped it), but the reviewer that failed on its
    // provider before was missed.
    const merged = {
      builder: factorySession("m-builder", { workKey: "issue:243", status: "stopped" }),
      reviewer: factorySession("m-reviewer", { workKey: "factory:review:244", archivedAt: old }),
      failed: factorySession("m-failed", { workKey: "factory:review:244", status: "failed" }),
    };
    oldItem({
      workKey: "issue:243",
      stage: "merged",
      pr: pr(244),
      builderSessionId: merged.builder,
      reviewerSessionId: merged.reviewer,
      sessionIds: Object.values(merged),
      sessionsArchivedAt: old,
      finishedAt: old,
    });
    // A failed item: its builder failed and is still its current session, so it needs
    // attention; an earlier reviewer of it failed and was replaced.
    const stuck = {
      builder: factorySession("f-builder", { workKey: "issue:250", status: "failed" }),
      reviewer: factorySession("f-reviewer", { workKey: "factory:review:251", archivedAt: old }),
      failed: factorySession("f-failed", { workKey: "factory:review:251", status: "failed" }),
    };
    oldItem({
      workKey: "issue:250",
      stage: "failed",
      failureKind: "checks",
      reason: "review: request_changes: still has gaps",
      pr: { ...pr(251), state: "closed" },
      builderSessionId: stuck.builder,
      reviewerSessionId: stuck.reviewer,
      sessionIds: Object.values(stuck),
      sessionsArchivedAt: old,
      finishedAt: old,
    });

    // The first start after the upgrade.
    env.restart();
    await tick();
    expect([...env.archived].sort()).toEqual([merged.failed, stuck.failed].sort());
    expect(session(merged.failed).archivedAt).not.toBeNull();
    expect(session(stuck.failed).archivedAt).not.toBeNull();
    expect(session(stuck.builder).archivedAt).toBeNull();
    expect(session(merged.builder).archivedAt).toBeNull();
    // Once: a later start leaves what someone restored since alone.
    expect(env.factory.data.loop(env.project.id)?.failedSessionsSweptAt).not.toBeNull();
    env.repo.update(merged.failed, (s) => ({ ...s, archivedAt: null }));
    env.restart();
    await tick();
    expect(session(merged.failed).archivedAt).toBeNull();
  });

  it("archives an in-play item's failed sessions a later builder or reviewer superseded", async () => {
    env = createFactoryEnv();
    enable();
    const at = (h: number) => new Date(Date.parse(old) + h * 3_600_000).toISOString();
    // A revise round in flight during the upgrade: its first builder failed on its provider and
    // a fresh one took over; a reviewer failed before the fresh builder started. The fresh
    // builder is still working.
    const building = {
      first: factorySession("p-builder-1", { workKey: "issue:270", status: "failed" }),
      reviewer: factorySession("p-reviewer", {
        workKey: "factory:review:271",
        status: "failed",
        createdAt: at(1),
      }),
      current: factorySession("p-builder-2", {
        workKey: "issue:270",
        status: "running",
        createdAt: at(2),
      }),
    };
    oldItem({
      workKey: "issue:270",
      stage: "building",
      pr: { ...pr(271), state: "open" },
      builderSessionId: building.current,
      reviewerSessionId: null,
      sessionIds: Object.values(building),
    });
    // Another item in flight whose reviewer failed after its builder started, and nothing has
    // replaced it yet: it stays.
    const waiting = {
      builder: factorySession("w-builder", { workKey: "issue:280", status: "running" }),
      failed: factorySession("w-reviewer", {
        workKey: "factory:review:281",
        status: "failed",
        createdAt: at(1),
      }),
    };
    oldItem({
      workKey: "issue:280",
      stage: "building",
      pr: { ...pr(281), state: "open" },
      builderSessionId: waiting.builder,
      reviewerSessionId: null,
      sessionIds: Object.values(waiting),
    });

    env.restart();
    await tick();
    expect([...env.archived].sort()).toEqual([building.first, building.reviewer].sort());
    expect(session(building.current).archivedAt).toBeNull();
    expect(session(waiting.failed).archivedAt).toBeNull();
    expect(session(waiting.builder).archivedAt).toBeNull();
  });

  it("reaches a failed session however many failed or stopped sessions came after it", async () => {
    env = createFactoryEnv();
    enable();
    // A merged item whose failed reviewer an earlier version missed...
    const builder = factorySession("o-builder", { workKey: "issue:290", archivedAt: old });
    const failed = factorySession("o-failed", { workKey: "factory:review:291", status: "failed" });
    oldItem({
      workKey: "issue:290",
      stage: "merged",
      pr: pr(291),
      builderSessionId: builder,
      reviewerSessionId: null,
      sessionIds: [builder, failed],
      sessionsArchivedAt: old,
      finishedAt: old,
    });
    // ...and a busy project's history since: a thousand sessions someone stopped (not archived,
    // so they are read too, and a capped read would still miss the failed one).
    const later = Date.parse(old) + 3_600_000;
    env.store.append(
      Array.from({ length: 1000 }, (_, n) => {
        const ts = new Date(later + n * 1000).toISOString();
        const id = `stopped-${n}`;
        const s: Session = {
          ...sampleSession,
          id,
          projectId: env.project.id,
          workKey: `request:${n}`,
          status: "stopped",
          createdAt: ts,
          updatedAt: ts,
        };
        return { type: "session.created" as const, sessionId: id, payload: { session: s } };
      }),
    );

    env.restart();
    await tick();
    expect(env.archived).toEqual([failed]);
    expect(session(failed).archivedAt).not.toBeNull();
    // The sessions people stopped aren't the factory's to archive.
    expect(session("stopped-0").archivedAt).toBeNull();
  });
});
