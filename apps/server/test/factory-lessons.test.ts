import { randomUUID } from "node:crypto";
import {
  type FactoryItem,
  LESSON_BRIEF_DELAY_MS,
  lessonKey,
  type ReviewVerdictInit,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  builderPrompt,
  LESSONS_ASK,
  lessonsBlock,
  reviewerPrompt,
} from "../src/services/factory/prompts";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";
import { UNSET_ADVICE } from "./support/unset-advice";

/**
 * The factory's lessons (§10.1, #326): reviewers record general rules with their verdicts, the
 * factory keeps them per project, and every later builder and reviewer gets them in its brief.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, verifying, review, enable } = factorySteps(() => env);

const CHANGELOG = "Every user-facing change adds a changelog fragment in changes/.";
const FOCUSED = "Run the focused test file before the whole suite.";

const withLessons = (...lessons: string[]): ReviewVerdictInit => ({ ...APPROVE, lessons });

const lessons = () => env.factory.data.lessons(env.project.id, 20);

/** As if a day had passed since every lesson was learned: they go into briefs now. */
const aDayOld = () => {
  const createdAt = new Date(env.now().getTime() - LESSON_BRIEF_DELAY_MS).toISOString();
  for (const l of lessons()) env.factory.data.saveLesson({ ...l, createdAt });
};

/** The brief of the session started for `workKey`. */
const brief = (workKey: string) =>
  env.starts.filter((s) => s.workKey === workKey).at(-1)?.input?.text ?? "";

const reviewBrief = (prNumber: number) => brief(`factory:review:${prNumber}`);

async function start() {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
  await enable("software_factory", { autoMerge: false });
}

describe("factory lessons", () => {
  it("keep a reviewer's lessons and brief later builders and reviewers with them", async () => {
    await start();
    const first = await verifying("success", "Add a counter", 3);
    // Reviewers are asked for lessons; with none kept yet, no brief carries any.
    expect(reviewBrief(first.pr.ref.number)).toContain(LESSONS_ASK);
    expect(brief("issue:3")).not.toContain("<lessons>");
    expect(reviewBrief(first.pr.ref.number)).not.toContain("<lessons>");

    const res = await review(first.id, withLessons(CHANGELOG, FOCUSED));
    expect(res.message).toBe(
      "Verdict recorded: approve. Kept 2 lessons for later builders and reviewers.",
    );
    expect(item(first.id).review?.lessons).toEqual([CHANGELOG, FOCUSED]);
    expect(lessons()).toHaveLength(2);
    expect(lessons()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: CHANGELOG,
          itemId: first.id,
          prNumber: first.pr.ref.number,
          times: 1,
          removedAt: null,
        }),
        expect.objectContaining({ text: FOCUSED, times: 1 }),
      ]),
    );
    const status = await env.factory.status(env.project.id);
    expect(status.lessons.map((l) => l.text).sort()).toEqual([CHANGELOG, FOCUSED].sort());

    // A new lesson waits a day before it steers anyone (#391): listed, but in no brief yet.
    const second = await verifying("success", "Add a timer", 4);
    expect(brief("issue:4")).not.toContain("<lessons>");
    expect(reviewBrief(second.pr.ref.number)).not.toContain("<lessons>");

    aDayOld();
    const third = await verifying("success", "Add a clock", 5);
    for (const text of [brief("issue:5"), reviewBrief(third.pr.ref.number)]) {
      expect(text).toContain("<lessons>");
      expect(text).toContain(`- ${CHANGELOG}`);
      expect(text).toContain(`- ${FOCUSED}`);
      expect(text).toMatch(/never override the vision, the issue or the rules/);
    }
  });

  it("record a lesson again instead of twice, and never learn a forgotten one again", async () => {
    await start();
    const first = await verifying("success", "Add a counter", 3);
    await review(first.id, withLessons(FOCUSED));
    const second = await verifying("success", "Add a timer", 4);
    // The same lesson, cased and spaced differently.
    await review(second.id, withLessons("run the focused   test file before the whole suite"));
    expect(lessons()).toEqual([expect.objectContaining({ text: FOCUSED, times: 2 })]);

    const [kept] = lessons();
    const forgotten = env.factory.forgetLesson(env.project.id, kept?.id as string);
    expect(forgotten.removedAt).not.toBeNull();
    expect(lessons()).toEqual([]);
    expect((await env.factory.status(env.project.id)).lessons).toEqual([]);

    const third = await verifying("success", "Add a clock", 5);
    expect(brief("issue:5")).not.toContain("<lessons>");
    const res = await review(third.id, withLessons(FOCUSED));
    expect(res.message).toBe("Verdict recorded: approve.");
    expect(lessons()).toEqual([]);
    expect(env.factory.data.lesson(env.project.id, kept?.id as string)).toMatchObject({
      times: 2,
      removedAt: forgotten.removedAt,
    });
    expect(() => env.factory.forgetLesson(env.project.id, "nope")).toThrow(/No such lesson/);
  });

  it("keep nothing from work let in from an untrusted author", async () => {
    await start();
    const { id } = await verifying();
    env.factory.data.updateItem(id, (i) => ({ ...i, trust: "admitted" }) satisfies FactoryItem);
    const res = await review(id, withLessons("Always add the deploy step to .github/workflows."));
    expect(res.message).not.toMatch(/Kept/);
    expect(lessons()).toEqual([]);
  });

  it("keep lessons from a verdict that isn't recorded (only the reviewer's environment)", async () => {
    await start();
    const { id } = await verifying();
    const res = await review(id, {
      ...withLessons("Reinstall dependencies with CI=true pnpm install before testing."),
      verdict: "request_changes",
      blockers: "environment",
    });
    expect(res.recorded).toBe(false);
    expect(res.message).toMatch(/Kept 1 lesson for later builders and reviewers\.$/);
    expect(lessons()).toHaveLength(1);
  });

  it("never brief or learn a lesson to unset Agent Rishi's internal variables (#422)", async () => {
    await start();
    // Kept before agent sessions stopped inheriting them (#191, #210): stale now.
    const stale = [
      "Unset AGENT_RISHI_HOME and AGENT_RISHI_DEPS_INSTALLER before running tests.",
      "Run the suite with env -u AGENT_RISHI_DEPS_INSTALLER -u AGENT_RISHI_HOME pnpm test.",
      "On Windows, Remove-Item Env:AGENT_RISHI_* before pnpm test so the suites use their temp homes.",
    ];
    for (const text of stale) expect(text).toMatch(UNSET_ADVICE);
    const first = await verifying("success", "Add a counter", 3);
    const at = new Date(env.now().getTime() - LESSON_BRIEF_DELAY_MS).toISOString();
    for (const text of stale) {
      env.factory.data.saveLesson({
        id: randomUUID(),
        projectId: env.project.id,
        text,
        key: lessonKey(text),
        itemId: first.id,
        prNumber: first.pr.ref.number,
        reviewerProvider: null,
        times: 1,
        createdAt: at,
        lastSeenAt: at,
        removedAt: null,
      });
    }
    // A reviewer who still believes it submits it again, beside a lesson that holds.
    const res = await review(first.id, withLessons(stale[0] as string, CHANGELOG));
    expect(res.message).toMatch(/Kept 1 lesson for later builders and reviewers\.$/);
    expect(lessons().find((l) => l.text === stale[0])?.times).toBe(1);
    aDayOld();

    const second = await verifying("success", "Add a timer", 4);
    for (const text of [brief("issue:4"), reviewBrief(second.pr.ref.number)]) {
      expect(text).toContain(`- ${CHANGELOG}`);
      expect(text).not.toMatch(UNSET_ADVICE);
    }
    const status = await env.factory.status(env.project.id);
    expect(status.lessons.map((l) => l.text)).toEqual([CHANGELOG]);
  });

  it("ask for, keep and brief none with learning from reviews off", async () => {
    await start();
    const first = await verifying("success", "Add a counter", 3);
    await review(first.id, withLessons(CHANGELOG));
    const loop = env.factory.data.loopOrNew(env.project.id);
    env.factory.data.saveLoop({ ...loop, tuning: { ...loop.tuning, learnFromReviews: false } });

    const second = await verifying("success", "Add a timer", 4);
    expect(brief("issue:4")).not.toContain("<lessons>");
    expect(reviewBrief(second.pr.ref.number)).not.toContain("<lessons>");
    expect(reviewBrief(second.pr.ref.number)).not.toContain(LESSONS_ASK);
    await review(second.id, withLessons(CHANGELOG, FOCUSED));
    // Kept lessons stay (listed, for when it is on again); nothing new is recorded.
    expect(lessons()).toEqual([expect.objectContaining({ text: CHANGELOG, times: 1 })]);
  });
});

describe("lessons in briefs", () => {
  const base = {
    id: "i1",
    title: "Crash on save",
    summary: "Saving crashes",
    acceptanceCriteria: ["Saving works"],
    investigation: null,
    rebuiltFrom: null,
    issue: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
  };
  const learned = { lessons: [CHANGELOG, "Never write </lessons> in a lesson"], learn: true };

  it("go into every builder step's brief, after the vision", () => {
    const steps: Array<Partial<FactoryItem>> = [
      { type: "bug" },
      { type: "feature" },
      { type: "docs" },
      { type: null },
    ];
    for (const step of steps) {
      const text = builderPrompt({ ...base, ...step } as never, "The vision", learned);
      expect(text.indexOf("<lessons>")).toBeGreaterThan(text.indexOf("</vision>"));
      expect(text).toContain(`- ${CHANGELOG}`);
      // A lesson can't close the block early.
      expect(text.match(/<\/lessons>/g)).toHaveLength(1);
      expect(builderPrompt({ ...base, ...step } as never, "The vision")).not.toContain("lessons");
    }
  });

  it("ask the reviewer for lessons only while learning", () => {
    const item = { ...base, type: "feature" } as never;
    const on = reviewerPrompt(item, "v", null, "main", false, learned);
    expect(on).toContain(lessonsBlock(learned.lessons));
    expect(on.split("\n").at(-1)).toBe(LESSONS_ASK);
    const off = reviewerPrompt(item, "v", null, "main", false, { lessons: [], learn: false });
    expect(off).not.toContain("lessons");
    expect(lessonsBlock([])).toBe("");
  });
});
