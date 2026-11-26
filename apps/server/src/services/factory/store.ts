import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type FactoryDigest,
  type FactoryItem,
  type FactoryItemStage,
  type FactoryLesson,
  type FactoryLoop,
  FactoryTuning,
  LEGACY_SIZE_LIMITS,
  pipelineStep,
  ScoutState,
} from "@agent-rishi/contracts";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  factoryDigests,
  factoryItems,
  factoryLessons,
  factoryLoops,
} from "../../db/schema-factory";
import type { EventStore } from "../../events/store";
import { ItemReads } from "./item-reads";
import { localDay } from "./policy";
import { keepScoutReports } from "./scout-merge";

/** A new item: the identifying fields, plus anything else to set. */
export type NewFactoryItem = Pick<
  FactoryItem,
  "projectId" | "workKey" | "title" | "summary" | "source" | "stage"
> &
  Partial<Omit<FactoryItem, "id" | "createdAt" | "updatedAt">>;

/** Stages of items that are still moving through the loop. */
export const ACTIVE_STAGES: FactoryItemStage[] = ["building", "verifying", "watching"];
/** Stages of items waiting to be classified or for a free agent. */
export const WAITING_STAGES: FactoryItemStage[] = ["candidate", "backlog"];
/** Stages whose pull request the loop still owns outside verification (see `owned.ts`). */
export const OWNED_STAGES: FactoryItemStage[] = ["failed", "escalated"];
/** Stages after which an item's sessions have nothing left to do (see `cleanup.ts`). */
export const FINISHED_STAGES: FactoryItemStage[] = ["merged", "reverted", "rejected", "failed"];
/** Nudge a merge sets while the item's review follow-ups wait to be filed (`follow-ups.ts`). */
export const FOLLOW_UPS_DUE = "follow_ups_due";
/** Nudge an item carries while some of its follow-ups are held for the scout (`follow-ups-held.ts`). */
export const FOLLOW_UPS_HELD = "follow_ups_held";
/** Nudge set when reverted work went back to its builder for a new PR (`revert.ts`), once per item. */
export const AFTER_REVERT = "after_revert";
/** The newest items the Factory view lists (`status.ts`); the loop itself reads them all. */
export const VIEW_ITEMS = 500;

/** Final stages. */
export const DONE_STAGES: FactoryItemStage[] = [
  "merged",
  "reverted",
  "rejected",
  "failed",
  "escalated",
];

/**
 * Factory state (§10.1) over the event log: reads come from the `factory_*` projections,
 * writes append `factory.*` events (projected in the same transaction).
 */
export class FactoryStore {
  /** When each project's loop last ticked (see `saveTick`); not persisted. */
  private readonly lastTicks = new Map<string, string>();
  /** Per project, the items a running tick read once (`readOnce`). */
  private readonly reads: ItemReads;

  constructor(
    private readonly db: Db,
    private readonly events: EventStore,
  ) {
    this.reads = new ItemReads((projectId) =>
      this.db
        .select()
        .from(factoryItems)
        .where(eq(factoryItems.projectId, projectId))
        .all()
        .map((r) => withItemDefaults(r.item)),
    );
  }

  loop(projectId: string): FactoryLoop | undefined {
    const loop = this.db
      .select()
      .from(factoryLoops)
      .where(eq(factoryLoops.projectId, projectId))
      .get()?.loop;
    return loop ? upgradeLoop(loop) : undefined;
  }

  /** The project's loop, or a fresh idle one (not saved). */
  loopOrNew(projectId: string, now = new Date()): FactoryLoop {
    return (
      this.loop(projectId) ?? {
        projectId,
        state: "idle",
        pausedReason: null,
        consecutiveFailures: 0,
        day: localDay(now),
        mergesToday: 0,
        discovery: [],
        nextArea: 0,
        lastDiscoveryAt: null,
        scout: ScoutState.parse({}),
        lastDigestDay: null,
        enabledAt: null,
        seenFailedShas: [],
        fastMergeHold: null,
        tuning: FactoryTuning.parse({}),
        drain: null,
        failedSessionsSweptAt: null,
        holds: [],
        lastTickAt: null,
        updatedAt: now.toISOString(),
      }
    );
  }

  /**
   * Save the loop; writes only when something besides its stamps (`lastTickAt`, `updatedAt`)
   * changed. The log is never pruned (§6) and every loop event refreshes the open factory
   * panels, while an idle factory ticks every 30 s. What the scout and its area reviewers
   * reported in the round since the caller read the loop is kept (`keepScoutReports`).
   */
  saveLoop(changed: FactoryLoop): FactoryLoop {
    const current = this.loop(changed.projectId);
    const loop = current
      ? { ...changed, scout: keepScoutReports(changed.scout, current.scout) }
      : changed;
    if (current && sameLoop(current, loop)) return { ...loop, updatedAt: current.updatedAt };
    const next = { ...loop, updatedAt: new Date().toISOString() };
    this.events.append([
      { type: "factory.loop.updated", sessionId: null, payload: { loop: next } },
    ]);
    return next;
  }

  /**
   * End a tick: remember when it ran and save the loop if the tick changed it. A tick that
   * changed nothing saves nothing, so the time is kept in memory for the panel's "last check".
   */
  saveTick(loop: FactoryLoop, at: string): FactoryLoop {
    this.lastTicks.set(loop.projectId, at);
    return this.saveLoop({ ...loop, lastTickAt: at });
  }

  /** When the project's loop last ticked in this process (none yet after a restart). */
  lastTick(projectId: string): string | undefined {
    return this.lastTicks.get(projectId);
  }

  /**
   * Run `run` (a tick) reading the project's items from the database at most once: its reads
   * share one copy, kept current by this store's writes (`createItem`, `updateItem`, the only
   * writers of `factory_items`). See `ItemReads`.
   */
  readOnce<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    return this.reads.during(projectId, run);
  }

  item(id: string): FactoryItem | undefined {
    const read = this.reads.find(id);
    if (read) return read;
    const item = this.db.select().from(factoryItems).where(eq(factoryItems.id, id)).get()?.item;
    return item ? withItemDefaults(item) : undefined;
  }

  /**
   * The project's items in `stages` (every stage without), last updated first. All of them:
   * intake, recovery and the other steps that dedupe or reconcile must see old items too. Only
   * a list for display passes a `limit` (`VIEW_ITEMS`).
   */
  items(
    projectId: string,
    stages?: FactoryItemStage[],
    opts: { limit?: number } = {},
  ): FactoryItem[] {
    const read = this.reads.list(projectId);
    if (read) {
      const list = stages ? read.filter((i) => stages.includes(i.stage)) : read;
      return opts.limit === undefined ? list : list.slice(0, opts.limit);
    }
    const where = stages
      ? and(eq(factoryItems.projectId, projectId), inArray(factoryItems.stage, stages))
      : eq(factoryItems.projectId, projectId);
    const query = this.db
      .select()
      .from(factoryItems)
      .where(where)
      .orderBy(desc(factoryItems.updatedAt))
      .$dynamic();
    const rows = opts.limit === undefined ? query.all() : query.limit(opts.limit).all();
    return rows.map((r) => withItemDefaults(r.item));
  }

  /**
   * Items with sessions still to archive (`cleanup.ts`): finished ones not cleaned up yet, and
   * any holding an earlier attempt's sessions. Every one, so an old item is reached however
   * much work came after it.
   */
  itemsToClean(projectId: string): FactoryItem[] {
    const read = this.reads.list(projectId);
    if (read) {
      // The query's test, on the copy the tick read.
      const pending = (i: FactoryItem) =>
        (FINISHED_STAGES.includes(i.stage) && i.sessionsArchivedAt == null) ||
        (i.earlierSessionIds?.length ?? 0) > 0;
      return read.filter(pending).reverse();
    }
    const field = (path: string) => sql`json_extract(${factoryItems.item}, ${path})`;
    const pending = or(
      and(
        inArray(factoryItems.stage, FINISHED_STAGES),
        sql`${field("$.sessionsArchivedAt")} is null`,
      ),
      sql`json_array_length(${field("$.earlierSessionIds")}) > 0`,
    );
    return this.db
      .select()
      .from(factoryItems)
      .where(and(eq(factoryItems.projectId, projectId), pending))
      .orderBy(asc(factoryItems.updatedAt))
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /**
   * Items whose spot-check (`spot-checks.ts`) is pending, or, with `checkedSince`, was recorded at
   * or after it. Every one, however old the merge: a spot-check waits until a person looks.
   */
  spotCheckItems(projectId: string, checkedSince: string | null): FactoryItem[] {
    const keep = (i: FactoryItem) =>
      i.spotCheck != null &&
      (i.spotCheck.state === "pending" ||
        (checkedSince !== null && (i.spotCheck.checkedAt ?? "") >= checkedSince));
    const read = this.reads.list(projectId);
    if (read) return read.filter(keep);
    const field = (path: string) => sql`json_extract(${factoryItems.item}, ${path})`;
    const pending = sql`${field("$.spotCheck.state")} = 'pending'`;
    const wanted =
      checkedSince === null
        ? pending
        : or(pending, sql`${field("$.spotCheck.checkedAt")} >= ${checkedSince}`);
    return this.db
      .select()
      .from(factoryItems)
      .where(and(eq(factoryItems.projectId, projectId), wanted))
      .all()
      .map((r) => withItemDefaults(r.item))
      .filter(keep);
  }

  /**
   * Merged items whose review follow-ups wait to be filed (`follow-ups.ts`): the merge set the
   * `follow_ups_due` nudge. Oldest first.
   */
  itemsWithFollowUpsDue(projectId: string): FactoryItem[] {
    return this.itemsWithNudge(projectId, FOLLOW_UPS_DUE);
  }

  /**
   * Items whose review follow-ups are held for the scout (`follow-ups-held.ts`): they carry the
   * `follow_ups_held` nudge. Oldest first.
   */
  itemsWithFollowUpsHeld(projectId: string): FactoryItem[] {
    return this.itemsWithNudge(projectId, FOLLOW_UPS_HELD);
  }

  /** Items carrying the nudge `key`, oldest first: however old, so none is missed. */
  private itemsWithNudge(projectId: string, key: string): FactoryItem[] {
    const read = this.reads.list(projectId);
    if (read) return read.filter((i) => i.nudges?.[key] != null).reverse();
    const path = `$.nudges.${key}`;
    const due = sql`json_extract(${factoryItems.item}, ${path}) is not null`;
    return this.db
      .select()
      .from(factoryItems)
      .where(and(eq(factoryItems.projectId, projectId), due))
      .orderBy(asc(factoryItems.updatedAt))
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /**
   * Finished items the Factory view may still show (`status.ts` narrows them with
   * `viewRecentItems`): every escalated item; failed items that failed since `failedSince`, still
   * have an open PR, or are rebuilds without a PR of their own (whose original may still be
   * open); and items merged since `mergedSince`. Not capped like the view's item list
   * (`VIEW_ITEMS`), so no amount of newer history hides an unresolved one.
   */
  viewCandidates(projectId: string, failedSince: string, mergedSince: string): FactoryItem[] {
    const field = (path: string) => sql`json_extract(${factoryItems.item}, ${path})`;
    const failed = and(
      eq(factoryItems.stage, "failed"),
      or(
        sql`${field("$.finishedAt")} >= ${failedSince}`,
        sql`${field("$.pr.state")} in ('open', 'draft')`,
        and(sql`${field("$.pr")} is null`, sql`${field("$.rebuiltFrom")} is not null`),
      ),
    );
    const merged = and(
      eq(factoryItems.stage, "merged"),
      sql`${field("$.mergedAt")} >= ${mergedSince}`,
    );
    return this.db
      .select()
      .from(factoryItems)
      .where(
        and(
          eq(factoryItems.projectId, projectId),
          or(eq(factoryItems.stage, "escalated"), failed, merged),
        ),
      )
      .orderBy(desc(factoryItems.updatedAt))
      .all()
      .map((r) => withItemDefaults(r.item));
  }

  /** The item a builder, reviewer or revert session works on. */
  itemForSession(projectId: string, sessionId: string): FactoryItem | undefined {
    return this.items(projectId, [...ACTIVE_STAGES, ...WAITING_STAGES]).find(
      (i) => i.builderSessionId === sessionId || i.reviewerSessionId === sessionId,
    );
  }

  /** Create an item; everything not given starts empty. */
  createItem(draft: NewFactoryItem): FactoryItem {
    const now = new Date().toISOString();
    const item: FactoryItem = {
      ...ITEM_DEFAULTS,
      area: null,
      acceptanceCriteria: [],
      score: null,
      issue: null,
      pr: null,
      builderSessionId: null,
      builderProvider: null,
      reviewerSessionId: null,
      reviewerProvider: null,
      reviewerNote: null,
      review: null,
      checks: [],
      attempts: 0,
      reason: null,
      note: null,
      mergeSha: null,
      revertOf: null,
      triageRequestedAt: null,
      nudges: {},
      largeChange: null,
      mergedAt: null,
      finishedAt: null,
      ...draft,
      id: randomUUID(),
      stepSince: now,
      createdAt: now,
      updatedAt: now,
    };
    const tracked = { ...item, sessionIds: trackedSessions(item) };
    this.events.append([
      { type: "factory.item.updated", sessionId: null, payload: { item: tracked } },
    ]);
    this.reads.remember(tracked);
    return tracked;
  }

  /**
   * Apply a change to an item; writes only when something changed. `touch: false` keeps
   * `updatedAt`, for bookkeeping that isn't progress (the digest and the recent list go by it).
   * A change that moves the item to another pipeline step restarts `stepSince`. Every session
   * the item had or has now stays in `sessionIds`, for its cost.
   */
  updateItem(
    id: string,
    change: (item: FactoryItem) => FactoryItem,
    opts: { touch?: boolean } = {},
  ): FactoryItem {
    const current = this.item(id);
    if (!current) throw new Error(`No factory item ${id}`);
    const proposed = change(current);
    // A change that changes nothing writes nothing, not even the sessions it would track (an
    // item from before `sessionIds` gets them with its next real change).
    if (JSON.stringify(proposed) === JSON.stringify(current)) return current;
    const changed = { ...proposed, sessionIds: trackedSessions(proposed, current) };
    const now = new Date().toISOString();
    const stepped =
      pipelineStep(changed) === pipelineStep(current) ? changed : { ...changed, stepSince: now };
    const next = opts.touch === false ? stepped : { ...stepped, updatedAt: now };
    this.events.append([
      { type: "factory.item.updated", sessionId: null, payload: { item: next } },
    ]);
    this.reads.remember(next);
    return next;
  }

  digests(projectId: string, limit = 10): FactoryDigest[] {
    return this.db
      .select()
      .from(factoryDigests)
      .where(eq(factoryDigests.projectId, projectId))
      .orderBy(desc(factoryDigests.createdAt))
      .limit(limit)
      .all()
      .map((r) => r.digest);
  }

  saveDigest(digest: FactoryDigest): void {
    this.events.append([{ type: "factory.digest.created", sessionId: null, payload: { digest } }]);
  }

  /** The project's lessons in force (not forgotten), last recorded first; all without `limit`. */
  lessons(projectId: string, limit?: number): FactoryLesson[] {
    const query = this.db
      .select()
      .from(factoryLessons)
      .where(and(eq(factoryLessons.projectId, projectId), isNull(factoryLessons.removedAt)))
      .orderBy(desc(factoryLessons.lastSeenAt), desc(factoryLessons.id));
    return (limit === undefined ? query.all() : query.limit(limit).all()).map((r) => r.lesson);
  }

  /** One lesson of the project, forgotten or not. */
  lesson(projectId: string, id: string): FactoryLesson | undefined {
    return this.db
      .select()
      .from(factoryLessons)
      .where(and(eq(factoryLessons.projectId, projectId), eq(factoryLessons.id, id)))
      .get()?.lesson;
  }

  /** The project's lesson with this `lessonKey`, forgotten or not. */
  lessonByKey(projectId: string, key: string): FactoryLesson | undefined {
    return this.db
      .select()
      .from(factoryLessons)
      .where(and(eq(factoryLessons.projectId, projectId), eq(factoryLessons.key, key)))
      .get()?.lesson;
  }

  /** Record a new lesson or a change to one (an upsert). */
  saveLesson(lesson: FactoryLesson): FactoryLesson {
    this.events.append([{ type: "factory.lesson.updated", sessionId: null, payload: { lesson } }]);
    return lesson;
  }
}

/** Fields items saved before 0.6 lack (the projection keeps the JSON as it was written). */
const ITEM_DEFAULTS = {
  type: null,
  classification: null,
  trust: "trusted",
  author: null,
  admittedBy: null,
  investigation: null,
  specApproval: null,
  nudges: {},
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  sessionIds: [],
  itemBudgetSince: null,
  failureKind: null,
  rebuiltFrom: null,
  stepSince: null,
  mergePath: null,
  followUps: [],
  spotCheck: null,
  lessonsNote: null,
  stop: null,
} satisfies Partial<FactoryItem>;

/** An item as read from the projection, with the fields newer versions added. */
export function withItemDefaults(item: FactoryItem): FactoryItem {
  return { ...ITEM_DEFAULTS, ...item };
}

/**
 * `sessionIds` after a write: what it held, plus the builder, reviewer and earlier sessions of
 * the item before and after the change, so a session a change clears from those fields (a
 * replaced reviewer, an earlier attempt once archived) is still counted in the item's cost.
 */
function trackedSessions(next: FactoryItem, before?: FactoryItem): string[] {
  const ids = new Set([...(before?.sessionIds ?? []), ...(next.sessionIds ?? [])]);
  for (const i of before ? [before, next] : [next]) {
    for (const id of [i.builderSessionId, i.reviewerSessionId, ...(i.earlierSessionIds ?? [])]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Same loop apart from the stamps a save sets; key order and `undefined` fields don't count. */
function sameLoop(a: FactoryLoop, b: FactoryLoop): boolean {
  const content = ({ lastTickAt: _tick, updatedAt: _saved, ...rest }: FactoryLoop) =>
    JSON.parse(JSON.stringify(rest)) as unknown;
  return isDeepStrictEqual(content(a), content(b));
}

const TUNING_DEFAULTS = FactoryTuning.parse({});

/** A loop as read from the projection: newer tuning knobs and the scout filled in. */
export function upgradeLoop(loop: FactoryLoop): FactoryLoop {
  return upgradeSizeLimits({
    ...loop,
    discovery: loop.discovery ?? [],
    fastMergeHold: loop.fastMergeHold ?? null,
    scout: ScoutState.parse(loop.scout ?? {}),
    tuning: { ...TUNING_DEFAULTS, ...loop.tuning },
    // Loops saved before drains existed have none.
    drain: loop.drain ? { ...loop.drain, deadline: loop.drain.deadline ?? null } : null,
    // Loops saved before the sweep of failed sessions (#411) haven't run it.
    failedSessionsSweptAt: loop.failedSessionsSweptAt ?? null,
    // Loops saved before holds (#593) have none.
    holds: loop.holds ?? [],
  });
}

/**
 * Loops saved before 0.4.4 carry the old default size limits (800 lines, 40 files, counting
 * lockfiles and generated files), which blocked ordinary scaffolds. Untouched old defaults
 * become the current defaults; limits someone chose are kept.
 */
export function upgradeSizeLimits(loop: FactoryLoop): FactoryLoop {
  const t = loop.tuning;
  if (
    t.maxChangedLines !== LEGACY_SIZE_LIMITS.maxChangedLines ||
    t.maxChangedFiles !== LEGACY_SIZE_LIMITS.maxChangedFiles
  ) {
    return loop;
  }
  const defaults = FactoryTuning.parse({});
  return {
    ...loop,
    tuning: {
      ...t,
      maxChangedLines: defaults.maxChangedLines,
      maxChangedFiles: defaults.maxChangedFiles,
    },
  };
}
