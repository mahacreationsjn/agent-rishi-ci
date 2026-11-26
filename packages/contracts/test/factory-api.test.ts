import { describe, expect, it } from "vitest";
import {
  DRAIN_LIMIT_MAX_MIN,
  drainText,
  EventEnvelope,
  FactoryAllowLargeChangeRequest,
  FactoryDecisionRequest,
  FactoryDigest,
  FactoryFileFollowUpRequest,
  FactoryItem,
  FactoryLimits,
  FactoryLoop,
  FactoryStatus,
  FactoryTuning,
  FactoryTuningPatch,
  HELD_FOLLOW_UP_DAYS,
  HELD_FOLLOW_UPS_MAX,
  HeldFollowUp,
  isFactoryMode,
  KillSwitchRequest,
  KillSwitchResponse,
  Notice,
  REVIEW_FOLLOW_UPS_MAX,
  REVIEW_SUMMARY_MAX,
  REVIEW_SUMMARY_TRUNCATED,
  ReviewVerdict,
  ReviewVerdictSubmission,
  SCOUT_UNAVAILABLE,
  ScoutStatus,
  SetAutonomyModeRequest,
  sameFollowUpTitle,
  truncateReviewSummary,
} from "../src";
import { ts } from "./fixtures";

const item: FactoryItem = {
  id: "i1",
  projectId: "p1",
  workKey: "issue:3",
  title: "Add a counter",
  summary: "Users count things",
  source: "discovery",
  area: "features",
  acceptanceCriteria: ["Counter increments"],
  score: 0.8,
  stage: "verifying",
  type: "feature",
  classification: {
    type: "feature",
    confidence: "high",
    rationale: "Asks for new behaviour",
    by: "model",
    at: ts,
  },
  trust: "trusted",
  author: "octocat",
  admittedBy: null,
  investigation: {
    kind: "analysis",
    outcome: "implement",
    summary: "Not there yet",
    details: "A counter in the header",
    testPath: null,
    at: ts,
  },
  specApproval: {
    state: "approved",
    requestedAt: ts,
    decidedAt: ts,
    by: "user",
    feedback: "Show the count in the tab title too",
    rounds: 1,
    sentAt: ts,
  },
  issue: { number: 3, url: "https://github.com/acme/app/issues/3" },
  pr: { number: 4, url: "https://github.com/acme/app/pull/4", state: "open" },
  builderSessionId: "s1",
  builderProvider: "claude",
  reviewerSessionId: "s2",
  reviewerProvider: "codex",
  reviewerNote: null,
  review: null,
  lessonsNote: null,
  followUps: [],
  spotCheck: null,
  checks: [{ name: "ci", state: "pass", detail: null, escalate: false, at: ts }],
  attempts: 0,
  reason: null,
  stop: null,
  failureKind: null,
  rebuiltFrom: null,
  note: null,
  mergeSha: null,
  mergePath: null,
  revertOf: null,
  triageRequestedAt: ts,
  nudges: { verifying: ts },
  largeChange: null,
  sessionsArchivedAt: null,
  earlierSessionIds: [],
  sessionIds: ["s1", "s2"],
  itemBudgetSince: null,
  stepSince: ts,
  createdAt: ts,
  updatedAt: ts,
  mergedAt: null,
  finishedAt: null,
};

describe("review summaries (§10.1)", () => {
  const verdict = (summary: string) => ({
    verdict: "request_changes",
    summary,
    vision: { aligned: true },
    tests: { adequate: false },
    security: {},
  });

  it("keeps a summary up to the limit and cuts a longer one with a marker", () => {
    const fits = "a".repeat(REVIEW_SUMMARY_MAX);
    expect(truncateReviewSummary(fits)).toBe(fits);
    const cut = truncateReviewSummary(`${"b".repeat(REVIEW_SUMMARY_MAX)} and more`);
    expect(cut.length).toBeLessThanOrEqual(REVIEW_SUMMARY_MAX);
    expect(cut.endsWith(` ${REVIEW_SUMMARY_TRUNCATED}`)).toBe(true);
    expect(cut.startsWith("bbbb")).toBe(true);
    // An emoji at the cut is dropped whole, never split into half a surrogate pair.
    const keep = REVIEW_SUMMARY_MAX - REVIEW_SUMMARY_TRUNCATED.length - 2;
    const emoji = truncateReviewSummary(`${"c".repeat(keep)}😀${"d".repeat(100)}`);
    expect(emoji).toBe(`${"c".repeat(keep)} ${REVIEW_SUMMARY_TRUNCATED}`);
  });

  it("accepts a submission of any length but stores at most the limit", () => {
    const long = "e".repeat(REVIEW_SUMMARY_MAX + 1);
    expect(ReviewVerdictSubmission.safeParse(verdict(long)).success).toBe(true);
    expect(ReviewVerdictSubmission.safeParse(verdict("")).success).toBe(false);
    expect(ReviewVerdict.safeParse(verdict(long)).success).toBe(false);
    expect(ReviewVerdict.safeParse(verdict(truncateReviewSummary(long))).success).toBe(true);
    // Verdicts stored under the old 4,000-character limit still parse.
    expect(ReviewVerdict.safeParse(verdict("f".repeat(4_000))).success).toBe(true);
  });
});

describe("factory API contracts (§10.1)", () => {
  it("round-trips items, loops and the item event", () => {
    expect(FactoryItem.parse(item)).toEqual(item);
    const finished = {
      ...item,
      stage: "backlog" as const,
      sessionsArchivedAt: ts,
      earlierSessionIds: ["s1", "s2"],
    };
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(finished)))).toEqual(finished);
    // A rebuilt item that failed for a reason outside its code.
    const rebuilt = {
      ...item,
      stage: "failed" as const,
      failureKind: "infrastructure" as const,
      rebuiltFrom: { number: 4, url: "https://github.com/acme/app/pull/4", state: "closed" },
    };
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(rebuilt)))).toEqual(rebuilt);
    expect(FactoryItem.safeParse({ ...item, failureKind: "flaky" }).success).toBe(false);
    const loop = FactoryLoop.parse({
      projectId: "p1",
      state: "building",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-07",
      mergesToday: 1,
      discovery: [{ sessionId: "s3", area: "ux", startedAt: ts }],
      nextArea: 2,
      lastDiscoveryAt: ts,
      lastDigestDay: null,
      enabledAt: ts,
      lastTickAt: null,
      updatedAt: ts,
    });
    expect(loop.tuning.maxChangedLines).toBe(5_000);
    expect(loop.tuning.maxChangedFiles).toBeNull();
    expect(loop.tuning.areas).toContain("security");
    // Loops saved before the idle grace existed get its default.
    expect(loop.tuning.idleGraceMin).toBe(10);
    expect(loop.seenFailedShas).toEqual([]);
    expect(loop.scout).toEqual({
      sessionId: null,
      lensSessions: {},
      round: null,
      lastRoundAt: null,
      lastRoundNote: null,
      rounds: 0,
    });
    // Items stored before `largeChange`, the pipelines and session cleanup existed still parse,
    // as trusted work whose sessions were not archived yet.
    const {
      largeChange: _l,
      sessionsArchivedAt: _sa,
      earlierSessionIds: _es,
      type: _t,
      classification: _c,
      trust: _tr,
      author: _a,
      admittedBy: _ab,
      investigation: _i,
      specApproval: _spec,
      failureKind: _fk,
      rebuiltFrom: _rf,
      stepSince: _ss,
      mergePath: _mp,
      followUps: _fu,
      spotCheck: _sc,
      lessonsNote: _ln,
      sessionIds: _sid,
      itemBudgetSince: _ibs,
      ...old
    } = item;
    expect(FactoryItem.parse(old)).toMatchObject({
      followUps: [],
      spotCheck: null,
      lessonsNote: null,
      sessionIds: [],
      itemBudgetSince: null,
      mergePath: null,
      failureKind: null,
      rebuiltFrom: null,
      stepSince: null,
      largeChange: null,
      sessionsArchivedAt: null,
      earlierSessionIds: [],
      type: null,
      trust: "trusted",
      investigation: null,
      specApproval: null,
    });
    // A tuning change carries only what it sets: the rest of the saved tuning is kept.
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { maxChangedLines: null } })
        .tuning,
    ).toEqual({ maxChangedLines: null });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { maxChangedLines: 0 } })
        .success,
    ).toBe(false);
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { idleGraceMin: 30 } }).tuning,
    ).toEqual({ idleGraceMin: 30 });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { idleGraceMin: 0 } })
        .success,
    ).toBe(false);
    // Loops saved before the reviewer settings (and spec approval) keep today's behaviour.
    expect(loop.tuning).toMatchObject({
      builderModel: null,
      reviewerProvider: "auto",
      reviewerModel: null,
      reviewerFallback: "builder",
      specApproval: false,
    });
    // Turning spec approval on carries only that knob.
    expect(
      SetAutonomyModeRequest.parse({ mode: "software_factory", tuning: { specApproval: true } })
        .tuning,
    ).toEqual({ specApproval: true });
    expect(FactoryTuning.parse({ specApproval: true }).specApproval).toBe(true);
    expect(FactoryTuning.safeParse({ specApproval: "yes" }).success).toBe(false);
    const agents = {
      builderProvider: "claude",
      builderModel: "claude-opus-5-5",
      reviewerProvider: "codex",
      reviewerModel: "gpt-5.5",
      reviewerFallback: "wait",
    } as const;
    const tuned = FactoryTuning.parse(agents);
    expect(FactoryTuning.parse(JSON.parse(JSON.stringify(tuned)))).toEqual(tuned);
    expect(tuned).toMatchObject(agents);
    expect(SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: agents }).tuning).toEqual(
      agents,
    );
    expect(FactoryTuning.safeParse({ reviewerFallback: "never" }).success).toBe(false);
    expect(FactoryTuning.safeParse({ reviewerModel: "" }).success).toBe(false);
    // Model routing: loops saved before it build docs like everything else and scout on auto.
    expect(loop.tuning).toMatchObject({
      docsBuilderProvider: null,
      docsBuilderModel: null,
      scoutProvider: "auto",
      scoutModel: null,
    });
    const routed = {
      docsBuilderProvider: "claude",
      docsBuilderModel: "claude-haiku-5-5",
      scoutProvider: "codex",
      scoutModel: "gpt-5.5-mini",
    } as const;
    const routedTuning = FactoryTuning.parse(routed);
    expect(FactoryTuning.parse(JSON.parse(JSON.stringify(routedTuning)))).toEqual(routedTuning);
    expect(routedTuning).toMatchObject(routed);
    expect(FactoryTuningPatch.parse({ scoutModel: "gpt-5.5-mini" })).toEqual({
      scoutModel: "gpt-5.5-mini",
    });
    expect(FactoryTuningPatch.parse({ docsBuilderProvider: null })).toEqual({
      docsBuilderProvider: null,
    });
    expect(FactoryTuning.safeParse({ scoutModel: "" }).success).toBe(false);
    // The WIP limit follows the agent limit until someone sets it; null sets it back.
    expect(loop.tuning.maxOpenPrs).toBeNull();
    const wip = FactoryTuning.parse({ maxOpenPrs: 4 });
    expect(FactoryTuning.parse(JSON.parse(JSON.stringify(wip))).maxOpenPrs).toBe(4);
    expect(FactoryTuning.safeParse({ maxOpenPrs: 0 }).success).toBe(false);
    expect(FactoryTuningPatch.parse({ maxOpenPrs: null })).toEqual({ maxOpenPrs: null });
    expect(FactoryTuningPatch.parse({ maxFixAttempts: 1 })).not.toHaveProperty("maxOpenPrs");
    expect(
      FactoryAllowLargeChangeRequest.parse({ itemId: "i1", reason: "Initial scaffold" }),
    ).toEqual({ itemId: "i1", reason: "Initial scaffold" });
    const event = EventEnvelope.parse({
      seq: 1,
      sessionId: null,
      ts,
      type: "factory.item.updated",
      payload: { item },
    });
    expect(event.type).toBe("factory.item.updated");
  });

  it("round-trips how the merge queue merged an item and the fast-merge hold (#301)", () => {
    for (const mergePath of ["current", "fast", "retested"] as const) {
      const merged = { ...item, stage: "watching" as const, mergeSha: "abc1234", mergePath };
      expect(FactoryItem.parse(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    }
    expect(FactoryItem.safeParse({ ...item, mergePath: "rebased" }).success).toBe(false);
    const base = {
      projectId: "p1",
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-14",
      mergesToday: 0,
      lastDigestDay: null,
      enabledAt: ts,
      lastTickAt: null,
      updatedAt: ts,
    };
    // Loops saved before the hold existed may merge fast.
    expect(FactoryLoop.parse(base).fastMergeHold).toBeNull();
    const held = FactoryLoop.parse({ ...base, fastMergeHold: "CI on main failed after #12" });
    expect(FactoryLoop.parse(JSON.parse(JSON.stringify(held)))).toEqual(held);
    expect(held.fastMergeHold).toBe("CI on main failed after #12");
  });

  it("round-trips the kill switch's modes and a loop's drain (#286)", () => {
    // Clients from before the modes send only `on`: that stops now, as it always did.
    expect(KillSwitchRequest.parse({ on: true })).toEqual({ on: true, mode: "now" });
    const drain = KillSwitchRequest.parse({ on: true, mode: "drain", drainLimitMin: 60 });
    expect(KillSwitchRequest.parse(JSON.parse(JSON.stringify(drain)))).toEqual(drain);
    expect(KillSwitchRequest.parse({ on: true, mode: "drain", drainLimitMin: null })).toEqual({
      on: true,
      mode: "drain",
      drainLimitMin: null,
    });
    expect(KillSwitchRequest.safeParse({ on: true, mode: "later" }).success).toBe(false);
    expect(KillSwitchRequest.safeParse({ on: true, mode: "drain", drainLimitMin: 0 }).success).toBe(
      false,
    );
    expect(
      KillSwitchRequest.safeParse({
        on: true,
        mode: "drain",
        drainLimitMin: DRAIN_LIMIT_MAX_MIN + 1,
      }).success,
    ).toBe(false);
    // Responses from before drains read as not draining.
    expect(KillSwitchResponse.parse({ on: true, stoppedSessions: ["s1"] })).toEqual({
      on: true,
      stoppedSessions: ["s1"],
      draining: false,
      inFlight: 0,
    });
    const res = KillSwitchResponse.parse({
      on: false,
      stoppedSessions: [],
      draining: true,
      inFlight: 2,
    });
    expect(KillSwitchResponse.parse(JSON.parse(JSON.stringify(res)))).toEqual(res);
    // A loop saved before drains has none; a draining one keeps its snapshot across a restart.
    const base = {
      projectId: "p1",
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-14",
      mergesToday: 0,
      lastDigestDay: null,
      enabledAt: ts,
      lastTickAt: null,
      updatedAt: ts,
    };
    expect(FactoryLoop.parse(base).drain).toBeNull();
    const draining = FactoryLoop.parse({
      ...base,
      state: "draining",
      drain: { startedAt: ts, itemIds: ["i1", "i2"] },
    });
    expect(draining.drain).toEqual({ startedAt: ts, itemIds: ["i1", "i2"], deadline: null });
    expect(FactoryLoop.parse(JSON.parse(JSON.stringify(draining)))).toEqual(draining);
    expect(drainText(1)).toBe("Draining: 1 item in flight");
    expect(drainText(2)).toBe("Draining: 2 items in flight");
  });

  it("round-trips when the loop swept failed sessions left from before (#411)", () => {
    const base = {
      projectId: "p1",
      state: "idle",
      pausedReason: null,
      consecutiveFailures: 0,
      day: "2026-11-15",
      mergesToday: 0,
      lastDigestDay: null,
      enabledAt: ts,
      lastTickAt: null,
      updatedAt: ts,
    };
    // A loop saved before the sweep existed hasn't run it yet.
    expect(FactoryLoop.parse(base).failedSessionsSweptAt).toBeNull();
    const swept = FactoryLoop.parse({ ...base, failedSessionsSweptAt: ts });
    expect(FactoryLoop.parse(JSON.parse(JSON.stringify(swept)))).toEqual(swept);
    expect(swept.failedSessionsSweptAt).toBe(ts);
  });

  it("round-trips review follow-ups on verdicts and merged items (#339)", () => {
    const base = {
      verdict: "approve",
      summary: "ok",
      vision: { aligned: true },
      tests: { adequate: true },
      security: { concerns: [] },
    };
    const verdict = ReviewVerdict.parse({
      ...base,
      followUps: [
        { title: "  Archiving deletes unpushed commits  ", severity: "medium", area: "runner" },
        { title: "Document the limits" },
      ],
    });
    // Titles are trimmed; severity and area are optional.
    expect(verdict.followUps).toEqual([
      { title: "Archiving deletes unpushed commits", severity: "medium", area: "runner" },
      { title: "Document the limits" },
    ]);
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(verdict)))).toEqual(verdict);
    expect(ReviewVerdictSubmission.parse(verdict).followUps).toEqual(verdict.followUps);
    // Verdicts stored before follow-ups existed still parse, without any.
    expect(ReviewVerdict.parse(base).followUps).toBeUndefined();
    // A short list: capped, and every entry needs a title and a known severity.
    const many = Array.from({ length: REVIEW_FOLLOW_UPS_MAX + 1 }, (_, n) => ({ title: `F${n}` }));
    expect(ReviewVerdict.safeParse({ ...base, followUps: many }).success).toBe(false);
    expect(ReviewVerdict.safeParse({ ...base, followUps: [{ title: "  " }] }).success).toBe(false);
    expect(
      ReviewVerdict.safeParse({ ...base, followUps: [{ title: "x", severity: "urgent" }] }).success,
    ).toBe(false);
    // A merged item keeps them, each with its issue once filed.
    const merged = FactoryItem.parse({
      ...item,
      stage: "merged",
      review: verdict,
      followUps: [
        {
          ...verdict.followUps?.[0],
          issue: { number: 12, url: "https://github.com/acme/app/issues/12" },
        },
        { title: "Document the limits" },
      ],
    });
    expect(merged.followUps[1]).toEqual({ title: "Document the limits", issue: null });
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    expect(FactoryFileFollowUpRequest.parse({ index: 1 })).toEqual({ index: 1 });
    expect(FactoryFileFollowUpRequest.safeParse({ index: -1 }).success).toBe(false);
    expect(sameFollowUpTitle(" Fix  the Runner ", "fix the runner")).toBe(true);
    expect(sameFollowUpTitle("Fix the runner", "Fix the web")).toBe(false);
  });

  it("round-trips follow-ups held for the scout, in the status and the digest (#435)", () => {
    // A follow-up held, then filed, and one dropped from the held list.
    const merged = FactoryItem.parse({
      ...item,
      stage: "merged",
      followUps: [
        {
          title: "Debounce the save",
          severity: "low",
          heldAt: ts,
          filedAt: ts,
          issue: { number: 14, url: "https://github.com/acme/app/issues/14" },
        },
        { title: "Rename the helper", heldAt: ts, dropped: { reason: "expired", at: ts } },
      ],
    });
    expect(FactoryItem.parse(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    expect(merged.followUps[1]?.dropped).toEqual({ reason: "expired", at: ts });
    expect(
      FactoryItem.safeParse({
        ...merged,
        followUps: [{ title: "x", heldAt: ts, dropped: { reason: "forgotten", at: ts } }],
      }).success,
    ).toBe(false);
    // The scout's held list: each with its source (item, position, PR), title, severity and area.
    const held = {
      id: "fu-i1-2",
      title: "Rename the helper",
      severity: null,
      area: "web",
      itemId: "i1",
      index: 1,
      itemTitle: "Add a counter",
      pr: { number: 12, url: "https://github.com/acme/app/pull/12", state: "merged" },
      heldAt: ts,
    } as const;
    const scout = ScoutStatus.parse({
      phase: "idle",
      sessionId: null,
      lenses: [],
      findings: 0,
      filed: 0,
      lastRoundAt: null,
      nextRoundAt: null,
      rounds: 0,
      heldFollowUps: [held],
    });
    expect(ScoutStatus.parse(JSON.parse(JSON.stringify(scout)))).toEqual(scout);
    expect(scout.heldFollowUps[0]).toEqual(held);
    expect(HeldFollowUp.safeParse({ ...held, index: -1 }).success).toBe(false);
    // A status from before #435 holds none; a digest from before counts nothing.
    expect(ScoutStatus.parse({ ...scout, heldFollowUps: undefined }).heldFollowUps).toEqual([]);
    const digest = FactoryDigest.parse({
      id: "d1",
      projectId: "p1",
      day: "2026-11-15",
      shipped: [],
      rejected: [],
      spend: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      waiting: [],
      text: "",
      createdAt: ts,
    });
    expect(digest.followUps).toEqual({ held: 0, filed: 0, dropped: 0, dismissed: 0, waiting: 0 });
    const counted = FactoryDigest.parse({
      ...digest,
      followUps: { held: 3, filed: 1, waiting: 2 },
    });
    expect(FactoryDigest.parse(JSON.parse(JSON.stringify(counted)))).toEqual(counted);
    expect(counted.followUps.dropped).toBe(0);
    expect(HELD_FOLLOW_UPS_MAX).toBe(50);
    expect(HELD_FOLLOW_UP_DAYS).toBe(14);
  });

  it("validates verdicts, reports and mode requests", () => {
    const verdict = ReviewVerdict.parse({
      verdict: "approve",
      summary: "ok",
      vision: { aligned: true },
      tests: { adequate: true },
      security: {},
    });
    expect(verdict.criteria).toEqual([]);
    expect(verdict.security.concerns).toEqual([]);
    expect(ReviewVerdict.safeParse({ verdict: "maybe", summary: "x" }).success).toBe(false);
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(verdict)))).toEqual(verdict);
    expect(verdict.blockers).toBeUndefined();
    // A request for changes blocked only by the reviewer's environment (#206).
    const environment = ReviewVerdict.parse({
      ...verdict,
      verdict: "request_changes",
      blockers: "environment",
    });
    expect(ReviewVerdict.parse(JSON.parse(JSON.stringify(environment)))).toEqual(environment);
    expect(ReviewVerdictSubmission.parse(environment).blockers).toBe("environment");
    expect(ReviewVerdict.safeParse({ ...verdict, blockers: "flaky" }).success).toBe(false);
    const decision = FactoryDecisionRequest.parse({
      question: "Polish index.html or migrate first?",
      decision: "Migrate first",
      reasoning: "The vision names the stack",
    });
    expect(decision.needsHuman).toBe(false);
    expect(FactoryDecisionRequest.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    expect(FactoryDecisionRequest.safeParse({ ...decision, reasoning: "" }).success).toBe(false);
    // Digests stored before decisions existed still parse.
    const digest = FactoryDigest.parse({
      id: "d1",
      projectId: "p1",
      day: "2026-11-09",
      shipped: [],
      rejected: [],
      spend: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      waiting: [],
      text: "",
      createdAt: ts,
    });
    expect(digest.decisions).toEqual([]);
    // "autopilot" is the software factory's id from before 0.6.
    const req = SetAutonomyModeRequest.parse({
      mode: "autopilot",
      limits: { dailyBudget: { usd: 5 } },
      tuning: { maxFixAttempts: 2 },
    });
    expect(req.mode).toBe("software_factory");
    expect(req.limits?.maxConcurrentSessions).toBe(2);
    expect(req.limits?.autoMerge).toBe(false);
    expect(isFactoryMode("software_factory")).toBe(true);
    expect(isFactoryMode("assisted")).toBe(false);
  });

  it("carries the factory panel status and factory notices", () => {
    const status = FactoryStatus.parse({
      projectId: "p1",
      mode: "dark_factory",
      experimental: true,
      loopState: "verifying",
      pausedReason: null,
      killSwitch: false,
      globalKillSwitch: false,
      limits: FactoryLimits.parse({ dailyBudget: { usd: 5 } }),
      tuning: {},
      spendToday: { usd: 1.5, tokens: 1000 },
      mergesToday: 1,
      consecutiveFailures: 0,
      activeSessions: 1,
      backlog: [],
      inProgress: [],
      mergeChecks: [
        {
          itemId: "i1",
          prNumber: 4,
          title: "Add a counter",
          checks: item.checks,
          reviewerProvider: "codex",
          reviewerNote: null,
          verdict: null,
        },
      ],
      recent: [],
      visionExists: true,
      lastDigest: null,
      lastTickAt: null,
    });
    expect(status.tuning.requireCi).toBe(true);
    // A status from before drains reads as not draining; a draining one round-trips.
    expect(status.drain).toBeNull();
    const draining = FactoryStatus.parse({
      ...status,
      loopState: "draining",
      drain: { since: ts, inFlight: 2, total: 3, deadline: null },
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(draining)))).toEqual(draining);
    expect(
      FactoryStatus.safeParse({ ...draining, drain: { ...draining.drain, inFlight: -1 } }).success,
    ).toBe(false);
    // A status from before the Factory view's stats still parses, with empty figures.
    expect(status.stats).toEqual({
      mergedToday: 0,
      failedToday: 0,
      revertedToday: 0,
      medianMergeMs7d: null,
      merged7d: 0,
      fastMerges7d: 0,
      retestedMerges7d: 0,
      fastReverts7d: 0,
    });
    const paths = FactoryStatus.parse({
      ...status,
      stats: {
        mergedToday: 2,
        merged7d: 5,
        fastMerges7d: 3,
        retestedMerges7d: 1,
        fastReverts7d: 1,
      },
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(paths)))).toEqual(paths);
    expect(FactoryStatus.safeParse({ ...status, stats: { fastMerges7d: -1 } }).success).toBe(false);
    // A status from before the WIP limit reads as not holding anything back.
    expect(status.wip).toEqual({
      openPrs: 0,
      limit: 2,
      holding: false,
      waitingOnProvider: 0,
      note: null,
    });
    const holding = FactoryStatus.parse({
      ...status,
      wip: { openPrs: 3, limit: 3, holding: true },
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(holding)))).toEqual(holding);
    // PRs waiting on a provider round-trip with the note that says so.
    const waiting = FactoryStatus.parse({
      ...status,
      wip: {
        openPrs: 1,
        limit: 2,
        holding: false,
        waitingOnProvider: 1,
        note: "1 PR waits on Codex (not signed in) and doesn't count",
      },
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(waiting)))).toEqual(waiting);
    expect(FactoryStatus.safeParse({ ...status, wip: { openPrs: 1, limit: 0 } }).success).toBe(
      false,
    );
    const work = {
      id: "i1",
      title: "Add a counter",
      workKey: "issue:3",
      issue: item.issue,
      pr: item.pr,
      score: null,
      sessionId: "s1",
      stage: "failed",
      step: "stopped",
      source: "issue",
      reason: "Checks failed",
      note: null,
      updatedAt: ts,
    };
    // Work items from before it lack the step time, merge and finish times, failure kind and
    // check counts; a status without the view's uncapped list reads it as empty.
    const before = FactoryStatus.parse({ ...status, recent: [work] });
    expect(before.recent[0]).toMatchObject({
      stepSince: null,
      mergedAt: null,
      finishedAt: null,
      failureKind: null,
      checks: null,
      ownedPr: null,
      recovering: false,
    });
    expect(before.viewRecent).toEqual([]);
    const owning = FactoryStatus.parse({
      ...status,
      viewRecent: [{ ...work, pr: null, ownedPr: item.pr }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(owning)))).toEqual(owning);
    expect(owning.viewRecent[0]?.ownedPr?.number).toBe(4);
    const withChecks = FactoryStatus.parse({
      ...status,
      viewRecent: [{ ...work, checks: { passed: 5, failed: 1, total: 8 } }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(withChecks)))).toEqual(withChecks);
    expect(withChecks.viewRecent[0]?.checks).toEqual({ passed: 5, failed: 1, total: 8 });
    expect(
      FactoryStatus.safeParse({
        ...status,
        viewRecent: [{ ...work, checks: { passed: -1, failed: 0, total: 1 } }],
      }).success,
    ).toBe(false);
    const viewed = FactoryStatus.parse({
      ...status,
      stats: {
        mergedToday: 2,
        failedToday: 1,
        revertedToday: 1,
        medianMergeMs7d: 5_400_000,
        merged7d: 9,
      },
      recent: [{ ...work, stepSince: ts, finishedAt: ts, failureKind: "stuck" }],
    });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(viewed)))).toEqual(viewed);
    expect(
      FactoryStatus.safeParse({ ...status, stats: { ...viewed.stats, failedToday: -1 } }).success,
    ).toBe(false);
    // A status from before the merge queue still parses; its entries round-trip.
    expect(status.pullRequests).toEqual([]);
    const pullRequests = [
      {
        itemId: "i1",
        title: "Add a counter",
        pr: item.pr,
        state: "queued",
        queuePosition: 1,
        note: "Queued to merge",
      },
      {
        itemId: "i2",
        title: "Fix the header",
        pr: { number: 5, url: "https://github.com/acme/app/pull/5", state: "open" },
        state: "rebasing",
        queuePosition: null,
        note: null,
      },
      {
        itemId: "i3",
        title: "Fix the footer",
        pr: { number: 2, url: "https://github.com/acme/app/pull/2", state: "open" },
        state: "superseded",
        queuePosition: null,
        note: "Superseded by #6: closing it",
      },
    ];
    const withQueue = FactoryStatus.parse({ ...status, pullRequests });
    expect(FactoryStatus.parse(JSON.parse(JSON.stringify(withQueue)))).toEqual(withQueue);
    expect(withQueue.pullRequests.map((p) => p.state)).toEqual([
      "queued",
      "rebasing",
      "superseded",
    ]);
    expect(
      FactoryStatus.safeParse({
        ...status,
        pullRequests: [{ ...pullRequests[0], queuePosition: 0 }],
      }).success,
    ).toBe(false);
    expect(
      FactoryStatus.safeParse({ ...status, pullRequests: [{ ...pullRequests[0], state: "idle" }] })
        .success,
    ).toBe(false);
    // The scout: a status from before "Run scout now" still parses; the reason round-trips.
    const scout = {
      phase: "idle",
      sessionId: null,
      lenses: [],
      findings: 0,
      filed: 0,
      lastRoundAt: null,
      nextRoundAt: null,
      rounds: 0,
    } as const;
    expect(ScoutStatus.parse(scout).runNowBlockedBy).toBeNull();
    const blocked = ScoutStatus.parse({ ...scout, runNowBlockedBy: "A round is already running" });
    expect(ScoutStatus.parse(JSON.parse(JSON.stringify(blocked)))).toEqual(blocked);
    expect(SCOUT_UNAVAILABLE).toBe("scout_unavailable");
    // Setting the backlog threshold alone carries nothing else; 0 is allowed, negatives aren't.
    expect(
      SetAutonomyModeRequest.parse({ mode: "dark_factory", tuning: { minBacklog: 0 } }).tuning,
    ).toEqual({ minBacklog: 0 });
    expect(
      SetAutonomyModeRequest.safeParse({ mode: "dark_factory", tuning: { minBacklog: -1 } })
        .success,
    ).toBe(false);
    const notice = Notice.parse({
      id: "n1",
      type: "factory.update",
      projectId: "p1",
      target: "orchestrator",
      sessionId: null,
      title: "Factory digest",
      createdAt: ts,
      deliveredAt: null,
      data: { event: "digest", text: "Shipped 1" },
    });
    expect(notice.type === "factory.update" && notice.data.itemIds).toEqual([]);
  });
});
