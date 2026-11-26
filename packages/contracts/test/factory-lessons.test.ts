import { describe, expect, it } from "vitest";
import {
  cleanLessons,
  DigestLesson,
  EventEnvelope,
  FactoryDigest,
  FactoryItem,
  FactoryLesson,
  FactoryLessonResponse,
  FactoryStatus,
  FactoryTuning,
  FactoryTuningPatch,
  isRetiredLesson,
  LESSON_BRIEF_DELAY_MS,
  LESSON_MAX,
  LESSONS_PER_VERDICT,
  lessonInBriefsAt,
  lessonKey,
  ReviewVerdict,
  ReviewVerdictSubmission,
} from "../src";
import { ts } from "./fixtures";

/** The factory's lessons (§10.1, #326): what reviewers record and later briefs carry. */

const lesson: FactoryLesson = {
  id: "l1",
  projectId: "p1",
  text: "Every user-facing change adds a changelog fragment in changes/.",
  key: lessonKey("Every user-facing change adds a changelog fragment in changes/."),
  itemId: "i1",
  prNumber: 12,
  reviewerProvider: "codex",
  times: 2,
  createdAt: ts,
  lastSeenAt: ts,
  removedAt: null,
};

const verdict = {
  verdict: "approve",
  summary: "ok",
  vision: { aligned: true },
  tests: { adequate: true },
  security: {},
};

describe("factory lessons", () => {
  it("round-trip a lesson, its event and the forget response", () => {
    expect(FactoryLesson.parse(JSON.parse(JSON.stringify(lesson)))).toEqual(lesson);
    const forgotten = { ...lesson, removedAt: ts };
    expect(FactoryLessonResponse.parse({ lesson: forgotten }).lesson).toEqual(forgotten);
    const env = EventEnvelope.parse({
      seq: 1,
      type: "factory.lesson.updated",
      sessionId: null,
      ts,
      payload: { lesson },
    });
    expect(env.type === "factory.lesson.updated" && env.payload.lesson).toEqual(lesson);
    expect(FactoryLesson.safeParse({ ...lesson, text: "" }).success).toBe(false);
    expect(FactoryLesson.safeParse({ ...lesson, text: "x".repeat(LESSON_MAX + 1) }).success).toBe(
      false,
    );
    expect(FactoryLesson.safeParse({ ...lesson, times: 0 }).success).toBe(false);
  });

  it("key a lesson the same way however it is cased, spaced or ended", () => {
    const key = lessonKey("Run the focused tests first.");
    expect(lessonKey("  run the   FOCUSED tests first ")).toBe(key);
    expect(lessonKey("Run the focused tests first!")).toBe(key);
    expect(lessonKey("Run the focused tests first...")).toBe(key);
    expect(lessonKey("Run the focused tests later")).not.toBe(key);
    expect(lessonKey(" . ")).toBe("");
  });

  it("clean submitted lessons: trimmed, masked, cut, deduped, at most three", () => {
    expect(
      cleanLessons([
        "  Add a changelog\n fragment.  ",
        "",
        "   ",
        "add a changelog fragment",
        "x".repeat(LESSON_MAX + 100),
        "Pass token=abc123secretvalue to the CLI",
        "A fourth lesson",
      ]),
    ).toEqual([
      "Add a changelog fragment.",
      `${"x".repeat(LESSON_MAX - 1)}…`,
      "Pass token=*** to the CLI",
    ]);
    expect(cleanLessons([])).toEqual([]);
    for (const text of cleanLessons(["y".repeat(5_000)])) {
      expect(text.length).toBeLessThanOrEqual(LESSON_MAX);
    }
  });

  it("retire advice to clear Agent Rishi's internal variables before tests (#422)", () => {
    const retired = [
      "Unset AGENT_RISHI_HOME and AGENT_RISHI_DEPS_INSTALLER before running tests.",
      "Run the suite with env -u AGENT_RISHI_DEPS_INSTALLER -u AGENT_RISHI_HOME pnpm test.",
      "On Windows, Remove-Item Env:AGENT_RISHI_* before pnpm test.",
      "Agent sessions inherit AGENT_RISHI_DEPS_INSTALLER; unset it before running provider tests.",
      "Clear the inherited AGENT_RISHI* variables so vitest uses its temp homes.",
    ];
    for (const text of retired) expect(isRetiredLesson(text), text).toBe(true);
    for (const text of [
      "Don't remove the AGENT_RISHI_* filter in agentEnv().",
      "Run the focused test file before the whole suite.",
      "Unset NODE_OPTIONS before running tests.",
      "Tests that need AGENT_RISHI_HOME set it themselves.",
    ]) {
      expect(isRetiredLesson(text), text).toBe(false);
    }
    expect(cleanLessons([retired[0] as string, "Add a changelog fragment."])).toEqual([
      "Add a changelog fragment.",
    ]);
  });

  it("keep lessons that guard the AGENT_RISHI_* filters, even when they name tests (#450)", () => {
    const guards = [
      "Don't remove the AGENT_RISHI_* filter from vitest.config.ts.",
      "Do not delete the AGENT_RISHI_* guard in agent-env.test.ts.",
      "Never strip the AGENT_RISHI_HOME filter from agentEnv(); its tests depend on it.",
      "Don't drop AGENT_RISHI_* from the vitest config's env filter.",
      "If you remove the AGENT_RISHI_* filter from vitest.config.ts, test workers inherit Agent Rishi's home.",
      "No need to unset AGENT_RISHI_HOME before running tests.",
      "You don't have to clear AGENT_RISHI_* before pnpm test; agent sessions never inherit them.",
    ];
    expect(guards.filter((text) => isRetiredLesson(text))).toEqual([]);
    expect(cleanLessons(guards)).toEqual(guards.slice(0, LESSONS_PER_VERDICT));
    // Advice to clear them is still retired, negation or filter nearby or not.
    const stale = [
      "Don't forget to unset AGENT_RISHI_HOME before running tests.",
      "Tests fail if you don't unset AGENT_RISHI_DEPS_INSTALLER first.",
      "Don't run the suite before you remove Env:AGENT_RISHI_*.",
      "Get-ChildItem Env: -Filter AGENT_RISHI_* | Remove-Item before pnpm test.",
    ];
    expect(stale.filter((text) => !isRetiredLesson(text))).toEqual([]);
  });

  it("verdicts carry at most three lessons; ones stored before lessons existed parse", () => {
    const old = ReviewVerdict.parse(verdict);
    expect(old.lessons).toEqual([]);
    const withLessons = ReviewVerdict.parse({
      ...verdict,
      lessons: ["Run pnpm lint before pushing"],
    });
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(withLessons)))).toEqual(withLessons);
    const four = ["a", "b", "c", "d"];
    expect(four.length).toBeGreaterThan(LESSONS_PER_VERDICT);
    expect(ReviewVerdict.safeParse({ ...verdict, lessons: four }).success).toBe(false);
    expect(
      ReviewVerdict.safeParse({ ...verdict, lessons: ["z".repeat(LESSON_MAX + 1)] }).success,
    ).toBe(false);
    // The tool's input takes any lessons; it cleans them before they are stored.
    const submitted = ReviewVerdictSubmission.parse({
      ...verdict,
      lessons: [...four, "z".repeat(LESSON_MAX + 1), ""],
    });
    expect(submitted.lessons).toHaveLength(6);
    expect(
      ReviewVerdict.safeParse({ ...submitted, lessons: cleanLessons(submitted.lessons) }).success,
    ).toBe(true);
  });

  it("learn from reviews by default; the switch saves as a patch; status lists none by default", () => {
    expect(FactoryTuning.parse({}).learnFromReviews).toBe(true);
    expect(FactoryTuningPatch.parse({ learnFromReviews: false })).toEqual({
      learnFromReviews: false,
    });
    expect(FactoryTuningPatch.parse({})).toEqual({});
    expect(FactoryStatus.shape.lessons.parse(undefined)).toEqual([]);
  });

  it("go into briefs a day after they are learned; digests list them, older ones none (#391)", () => {
    expect(lessonInBriefsAt(lesson).getTime() - Date.parse(ts)).toBe(LESSON_BRIEF_DELAY_MS);
    expect(LESSON_BRIEF_DELAY_MS).toBe(24 * 60 * 60 * 1000);
    const learned: DigestLesson = {
      lessonId: "l1",
      text: lesson.text,
      issueNumber: 3,
      prNumber: 12,
    };
    expect(DigestLesson.parse(JSON.parse(JSON.stringify(learned)))).toEqual(learned);
    expect(DigestLesson.safeParse({ ...learned, issueNumber: 0 }).success).toBe(false);
    expect(FactoryDigest.shape.lessons.parse(undefined)).toEqual([]);
    expect(FactoryItem.shape.lessonsNote.parse(undefined)).toBeNull();
  });
});
