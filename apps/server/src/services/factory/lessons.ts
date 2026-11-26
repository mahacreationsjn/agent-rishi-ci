import { randomUUID } from "node:crypto";
import {
  type DigestLesson,
  type FactoryItem,
  type FactoryLesson,
  isRetiredLesson,
  LESSONS_IN_BRIEF,
  lessonInBriefsAt,
  lessonKey,
} from "@agent-rishi/contracts";
import { notFound } from "../errors";
import { commentersText, untrustedCommenters } from "./comment-trust";
import type { FactoryContext } from "./context";
import { localDay } from "./policy";
import type { BriefLessons } from "./prompts";

/**
 * The factory's lessons (§10.1): general rules its reviewers record with their verdicts, kept per
 * project and given to every later builder and reviewer in its brief, so a finding that comes back
 * item after item stops costing a revise round. "Learn from reviews" (`learnFromReviews`) switches
 * it off; a person can forget a lesson, which then is never learned again.
 *
 * A lesson outlives its item and reaches every later brief, so it needs a source no stranger could
 * steer: it is kept only from trusted work whose issue and pull request nobody the project doesn't
 * trust commented on (`comment-trust.ts`). A new lesson is listed in the day's digest and goes
 * into briefs only a day after it was learned (`LESSON_BRIEF_DELAY_MS`), so a person sees it, and
 * can forget it, before it steers anyone.
 */

/** Whether the project's factory learns from its reviews. */
export function learnsFromReviews(ctx: FactoryContext, projectId: string): boolean {
  return ctx.store.loopOrNew(projectId, ctx.now()).tuning.learnFromReviews;
}

/**
 * The project's lessons in force, last recorded first: not forgotten, and not retired advice
 * (`isRetiredLesson`) kept before Agent Rishi retired it.
 */
export function lessonsInForce(ctx: FactoryContext, projectId: string): FactoryLesson[] {
  return ctx.store.lessons(projectId).filter((l) => !isRetiredLesson(l.text));
}

/** The lessons in force that briefs carry now: past their delay, newest first. */
function lessonsInBriefs(ctx: FactoryContext, projectId: string): string[] {
  const now = ctx.now().getTime();
  return lessonsInForce(ctx, projectId)
    .filter((l) => lessonInBriefsAt(l).getTime() <= now)
    .slice(0, LESSONS_IN_BRIEF)
    .map((l) => l.text);
}

/**
 * What a new builder's or reviewer's brief gets: the lessons in briefs (if learning), and who
 * commented on the item's issue or pull request without the project's trust (none named when
 * GitHub can't be read; the brief's rules still cover them).
 */
export async function briefLessons(ctx: FactoryContext, item: FactoryItem): Promise<BriefLessons> {
  const untrusted = (await untrustedCommenters(ctx, item)) ?? [];
  if (!learnsFromReviews(ctx, item.projectId)) return { lessons: [], learn: false, untrusted };
  return { lessons: lessonsInBriefs(ctx, item.projectId), learn: true, untrusted };
}

/** What became of a verdict's lessons: how many were kept, or why none were. */
export interface KeptLessons {
  kept: number;
  /** Why they weren't kept (also the item's `lessonsNote`); null when kept or there were none. */
  dropped: string | null;
}

/**
 * Keep the lessons of a verdict on `item` (already cleaned, see `cleanLessons`), when their
 * source is trusted: nothing is kept from work let in from an untrusted author, nor from work a
 * stranger commented on, nor when GitHub can't be read to tell. A dropped verdict's reason goes
 * on the item (`lessonsNote`). Never throws.
 */
export async function keepLessons(
  ctx: FactoryContext,
  item: FactoryItem,
  lessons: readonly string[],
): Promise<KeptLessons> {
  if (lessons.length === 0 || item.trust !== "trusted") return { kept: 0, dropped: null };
  if (!learnsFromReviews(ctx, item.projectId)) return { kept: 0, dropped: null };
  const untrusted = await untrustedCommenters(ctx, item);
  const count =
    lessons.length === 1 ? "Its lesson wasn't" : `Its ${lessons.length} lessons weren't`;
  const dropped =
    untrusted === null
      ? `${count} kept: GitHub couldn't be read to check who commented on the work`
      : untrusted.length > 0
        ? `${count} kept: ${commentersText(untrusted)} commented without the project's trust, and a lesson reaches every later brief`
        : null;
  if (ctx.store.item(item.id)?.lessonsNote !== dropped) {
    ctx.store.updateItem(item.id, (i) => ({ ...i, lessonsNote: dropped }), { touch: false });
  }
  if (dropped) {
    ctx.log?.(`factory: ${item.id}: ${dropped}`);
    return { kept: 0, dropped };
  }
  return { kept: recordLessons(ctx, item, lessons).length, dropped: null };
}

/**
 * Record lessons from trusted work (`keepLessons` checked their source). A lesson the project has
 * is recorded again (`times`, `lastSeenAt`); a forgotten one stays forgotten, and retired advice
 * (`isRetiredLesson`) is never recorded. Returns the lessons recorded.
 */
function recordLessons(
  ctx: FactoryContext,
  item: FactoryItem,
  lessons: readonly string[],
): FactoryLesson[] {
  const at = ctx.now().toISOString();
  const recorded: FactoryLesson[] = [];
  for (const text of lessons) {
    const key = lessonKey(text);
    if (!key || isRetiredLesson(text)) continue;
    const known = ctx.store.lessonByKey(item.projectId, key);
    if (known?.removedAt) continue;
    const lesson: FactoryLesson = known
      ? { ...known, times: known.times + 1, lastSeenAt: at }
      : {
          id: randomUUID(),
          projectId: item.projectId,
          text,
          key,
          itemId: item.id,
          prNumber: item.pr?.number ?? null,
          reviewerProvider: item.reviewerProvider,
          times: 1,
          createdAt: at,
          lastSeenAt: at,
          removedAt: null,
        };
    recorded.push(ctx.store.saveLesson(lesson));
  }
  return recorded;
}

/** The lessons first learned on `day` (local) and not forgotten, for that day's digest. */
export function digestLessons(ctx: FactoryContext, projectId: string, day: string): DigestLesson[] {
  return ctx.store
    .lessons(projectId)
    .filter((l) => localDay(new Date(l.createdAt)) === day)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((l) => ({
      lessonId: l.id,
      text: l.text,
      issueNumber: ctx.store.item(l.itemId)?.issue?.number ?? null,
      prNumber: l.prNumber,
    }));
}

/** Forget a lesson: it leaves the briefs and is never learned again. */
export function forgetLesson(
  ctx: FactoryContext,
  projectId: string,
  lessonId: string,
): FactoryLesson {
  const lesson = ctx.store.lesson(projectId, lessonId);
  if (!lesson) throw notFound("No such lesson", "lesson_not_found");
  if (lesson.removedAt) return lesson;
  return ctx.store.saveLesson({ ...lesson, removedAt: ctx.now().toISOString() });
}
