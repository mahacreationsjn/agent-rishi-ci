import {
  AutonomyMode,
  type FactoryItem,
  type FactoryItemCost,
  type FactoryLesson,
  FactoryLimits,
  FactoryLoop,
  FactoryStatus,
  FactoryTuning,
  type FactoryWorkItem,
  type GitHubIssueRef,
  type Investigation,
  isFactoryMode,
  lessonKey,
  parseVision,
  type ReviewVerdict,
  type SpecApproval,
} from "@agent-rishi/contracts";
import type { FactoryApi } from "../factory-api";
import { demoHeldFollowUps, withoutHeld } from "./factory-follow-ups";
import { demoScorecard } from "./factory-scorecard";
import {
  assertSpecVersion,
  isRevised,
  REVISED_DETAILS,
  reviseSpecLater,
  specInboxId,
} from "./factory-spec";
import {
  decideMockSpotCheck,
  demoSpotChecks,
  fileMockSpotCheckIssue,
  spotCheckOf,
} from "./factory-spot-checks";
import type { FixtureWorkItem } from "./fixtures/factory-fixture-types";
import { defaultFactoryLimits, factoryFor, visionDoc } from "./fixtures/ops";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const now = () => new Date().toISOString();

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The analysis of the mock's feature whose spec waits for approval. */
const DEMO_ANALYSIS: Omit<Investigation, "at"> = {
  kind: "analysis",
  outcome: "implement",
  summary: "Checkout takes card payments only; nothing redeems a gift card yet.",
  details: [
    "A **Gift card** field under the order summary, with an Apply button.",
    "",
    "- A valid code reduces the total by its balance, never below zero; the remainder stays on the card.",
    "- An invalid or used-up code shows an inline error and changes nothing.",
    "- The order records the code and the amount taken from it.",
    "- Docs: the checkout guide gets a short Gift cards section.",
  ].join("\n"),
  testPath: null,
};

const DEMO_CRITERIA = [
  "A valid code lowers the order total by up to its balance",
  "An invalid or used-up code shows an inline error and changes nothing",
  "The remaining balance is saved with the order",
];

/** A spec waiting for approval since `at`. */
const pendingSpec = (at: string): SpecApproval => ({
  state: "pending",
  requestedAt: at,
  decidedAt: null,
  by: null,
  feedback: null,
  rounds: 0,
  sentAt: null,
});

/** The approval merged mock items carry, with its non-blocking follow-ups. */
const MOCK_APPROVAL: ReviewVerdict = {
  verdict: "approve",
  summary: "Meets every criterion; the tests cover the new path. Two things can wait.",
  criteria: [],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
  lessons: [],
  followUps: [
    {
      title: "Archiving a container session deletes its unpushed commits",
      severity: "medium",
      area: "runner",
    },
    { title: "Document the container backend's limits", severity: "low", area: "docs" },
  ],
};

const FINISHED = ["merged", "reverted", "rejected", "failed", "escalated"];
const OWNING = ["backlog", "building", "verifying", "escalated", "failed"];

/** No agent has worked on items in these stages yet. */
const UNSTARTED = ["candidate", "ignored", "backlog"];

/**
 * A plausible cost for a demo item: a few dollars of API-equivalent spend, more for each revise
 * round, nothing before an agent worked on it.
 */
function demoCost(
  w: FixtureWorkItem,
  cap: FactoryLimits["itemBudget"] = {},
): FactoryItemCost | null {
  if (UNSTARTED.includes(w.stage) && !w.sessionId) return null;
  const seed = [...w.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const usd = Math.round((0.4 + (seed % 120) / 100 + (w.attempts ?? 0) * 2.6) * 100) / 100;
  const tokens = Math.round(usd * 310_000);
  return {
    usd,
    tokens,
    estimatedUsd: usd,
    unpricedTurns: 0,
    turns: 6 + (seed % 20) + (w.attempts ?? 0) * 8,
    sessions: 1 + (w.stage === "building" ? 0 : 1) + (w.attempts ?? 0),
    apiEquivalent: true,
    // Never retried: everything counts toward the per-item cap, when one is set.
    cap:
      cap.usd !== undefined || cap.tokens !== undefined
        ? { usd: cap.usd ?? null, tokens: cap.tokens ?? null, spentUsd: usd, spentTokens: tokens }
        : null,
  };
}

function work(w: FixtureWorkItem, limits?: Pick<FactoryLimits, "itemBudget">): FactoryWorkItem {
  const done = ["merged", "reverted", "rejected"].includes(w.stage);
  const since = minutesAgo(w.stepMinutesAgo ?? 4);
  return {
    id: w.id,
    title: w.title,
    workKey: w.workKey,
    issue: w.issue,
    pr: w.pr,
    score: w.score ?? null,
    sessionId: w.sessionId ?? null,
    reviewerSessionId: null,
    activeSessionId: w.sessionId ?? null,
    stage: w.stage,
    step: w.step ?? (done ? (w.stage === "merged" ? "done" : "stopped") : "queued"),
    type: w.type ?? (done ? "feature" : null),
    trust: w.trust ?? "trusted",
    author: w.author ?? "hearth-co",
    source: w.workKey.startsWith("issue:") ? "issue" : "discovery",
    specApproval: w.specApproval ?? null,
    attempts: w.attempts ?? 0,
    reason:
      w.reason ??
      (w.stage === "rejected"
        ? "Out of scope for the vision"
        : w.stage === "ignored"
          ? `Opened by @${w.author ?? "someone"}, who is not a trusted author`
          : null),
    note:
      w.note ??
      (w.stage === "verifying" && w.step === "merge"
        ? "Ready to merge: every check passed (auto-merge is off)"
        : null),
    failureKind: w.failureKind ?? null,
    // Owned while open, in the stages the factory keeps its PRs.
    ownedPr:
      OWNING.includes(w.stage) && (w.pr?.state === "open" || w.pr?.state === "draft") ? w.pr : null,
    recovering: w.stage === "failed" && w.failureKind === "infrastructure",
    checks: w.checks ?? null,
    stepSince: since,
    mergedAt: w.stage === "merged" || w.stage === "watching" ? since : null,
    finishedAt: FINISHED.includes(w.stage) ? since : null,
    cost: demoCost(w, limits?.itemBudget),
    updatedAt: since,
  };
}

/** In-memory factory API over the mock world's fixtures (§10.1). */
export function mockFactoryApi(world: MockWorld): FactoryApi {
  const visions = new Map<string, string>();
  /** Decisions on specs that waited for approval, by item id. */
  const specs = new Map<string, SpecApproval>();
  reviseSpecLater(world, specs);
  /** Follow-ups filed with "File issue", by `<itemId>:<index>`. */
  const filedFollowUps = new Map<string, GitHubIssueRef>();
  /** Held follow-ups dismissed from the scout's list, by `<itemId>:<index>`. */
  const dismissedFollowUps = new Set<string>();
  /** Issues filed from spot-checks so far (their numbers). */
  /**
   * `?crowd=N` in the mock UI's URL adds N more builders, for measuring Floor mode with a busy
   * floor (#476). Mock only: the real server never sees it.
   */
  const crowd = (items: FactoryWorkItem[]): FactoryWorkItem[] => {
    const n = Number(new URLSearchParams(globalThis.location?.search ?? "").get("crowd") ?? 0);
    const template = items.find((w) => w.stage === "building");
    if (!template || !(n > 0)) return items;
    const sessions = items.map((w) => w.sessionId).filter((id): id is string => Boolean(id));
    return [
      ...items,
      ...Array.from({ length: Math.min(200, n) }, (_, i) => ({
        ...template,
        id: `fw-crowd-${i}`,
        title: `Crowd item ${i + 1}`,
        workKey: `issue:${900 + i}`,
        issue: {
          number: 900 + i,
          url: `https://github.com/hearth-co/storefront/issues/${900 + i}`,
        },
        pr: null,
        ownedPr: null,
        sessionId: sessions[i % Math.max(1, sessions.length)] ?? null,
        activeSessionId: sessions[i % Math.max(1, sessions.length)] ?? null,
        step: i % 3 === 0 ? ("analyze" as const) : ("implement" as const),
      })),
    ];
  };
  let spotIssues = 0;
  const project = (id: string) => world.snapshot.projects.find((p) => p.id === id);
  const status = (projectId: string): FactoryStatus => {
    const cached = world.factory.get(projectId);
    if (cached) return cached;
    const p = project(projectId);
    const f = factoryFor(
      projectId,
      p?.autonomyMode ?? "assisted",
      p?.factoryLimits ?? defaultFactoryLimits,
    );
    const toWork = (w: FixtureWorkItem) => work(w, f.limits);
    // Spec approval is on where a spec waits for it.
    const tuning = FactoryTuning.parse({ specApproval: f.inProgress.some((w) => w.specApproval) });
    const s = FactoryStatus.parse({
      ...f,
      experimental: isFactoryMode(f.mode),
      pausedReason: null,
      globalKillSwitch: world.snapshot.settings.factory.killSwitch,
      tuning,
      activeSessions: Math.min(f.inProgress.length, f.limits.maxConcurrentSessions),
      // The work-in-progress limit follows the agent limit (no `maxOpenPrs` set).
      wip: {
        openPrs: f.inProgress.filter((w) => w.pr).length,
        limit: f.limits.maxConcurrentSessions,
        holding: f.inProgress.filter((w) => w.pr).length >= f.limits.maxConcurrentSessions,
      },
      backlog: f.backlog.map(toWork),
      inProgress: crowd(
        f.inProgress.map(toWork).map((w) => {
          // Check counts from the fixture's merge checks of the same pull request.
          const c = f.mergeChecks.find((m) => m.prNumber === w.pr?.number)?.checks;
          if (!c) return w;
          const passed = c.filter((x) => x.state === "pass" || x.state === "skipped").length;
          const failed = c.filter((x) => x.state === "fail").length;
          return { ...w, checks: { passed, failed, total: c.length } };
        }),
      ),
      recent: f.recent.map(toWork),
      // What a server keeps for the view beyond the capped recent list.
      viewRecent: f.recent
        .map(toWork)
        .filter((w) => ["escalated", "failed", "merged"].includes(w.stage)),
      ignored: f.ignored.map(toWork),
      held: f.held ?? [],
      githubLogin: "hearth-co",
      scout:
        f.mode === "dark_factory"
          ? {
              // The round moves on by itself in the mock, so Floor's Lookout has work to show:
              // its area reviewers at their pods, then capsules dropping while it files.
              phase: Math.floor(Date.now() / 20_000) % 2 ? "filing" : "reviewing",
              sessionId: "s-audit",
              lenses: [
                { area: "ux", sessionId: "s-a11y", reported: true, active: false },
                { area: "performance", sessionId: "s-search", reported: false, active: true },
                { area: "security", sessionId: "s-checkout", reported: false, active: true },
                { area: "docs", sessionId: "s-docs-audit", reported: false, active: false },
              ],
              findings: 3,
              filed: 0,
              lastRoundAt: null,
              nextRoundAt: null,
              rounds: 4,
              runNowBlockedBy: "A scout round is already running.",
              heldFollowUps: demoHeldFollowUps(f.recent.map(toWork), MOCK_APPROVAL.followUps?.[1]),
            }
          : null,
      stats: { mergedToday: f.mergesToday, ...f.stats },
      mergeChecks: f.mergeChecks.map((c, i) => ({
        itemId: f.inProgress.find((w) => w.pr?.number === c.prNumber)?.id ?? `fw-c${i}`,
        prNumber: c.prNumber,
        title: c.title,
        checks: c.checks.map((x) => ({ ...x, detail: x.detail ?? null, at: now() })),
        reviewerProvider: "codex",
        reviewerNote: null,
        verdict: null,
      })),
      lessons: isFactoryMode(f.mode) ? demoLessons(projectId) : [],
      spotChecks: demoSpotChecks(f.mode, tuning, f.recent.map(toWork)),
      lastDigest: null,
      lastTickAt: now(),
    });
    world.factory.set(projectId, s);
    return s;
  };
  const find = (projectId: string, itemId: string): FactoryWorkItem => {
    const s = status(projectId);
    const w = [...s.backlog, ...s.inProgress, ...s.recent, ...s.ignored].find(
      (x) => x.id === itemId,
    );
    if (!w) throw new Error(`No factory item ${itemId}`);
    return w;
  };
  const item = (projectId: string, itemId: string): FactoryItem => {
    const { cost: _cost, specApproval: specState, ...w } = find(projectId, itemId);
    const s = status(projectId);
    // A waiting spec's version is its inbox item's `updatedAt`, as the server raises it.
    const asked = world.snapshot.inbox.find((x) => x.id === specInboxId(itemId))?.updatedAt;
    const spec = specState
      ? (specs.get(itemId) ?? pendingSpec(asked ?? w.stepSince ?? now()))
      : null;
    return {
      ...w,
      projectId,
      summary: `Work item "${w.title}" from the ${w.source}.`,
      area: null,
      classification: w.type
        ? { type: w.type, confidence: "high", rationale: "From its label", by: "label", at: now() }
        : null,
      admittedBy: null,
      investigation: spec
        ? {
            ...DEMO_ANALYSIS,
            ...(isRevised(itemId) ? { details: REVISED_DETAILS } : {}),
            at: spec.requestedAt,
          }
        : null,
      specApproval: spec,
      acceptanceCriteria: spec
        ? DEMO_CRITERIA
        : ["Behaviour covered by tests", "No visual regressions"],
      builderSessionId: w.sessionId,
      builderProvider: "claude",
      reviewerSessionId: null,
      reviewerProvider: "codex",
      reviewerNote: null,
      review: w.mergedAt ? demoReview(itemId) : null,
      lessonsNote: itemId === DROPPED_LESSONS.itemId ? DROPPED_LESSONS.note : null,
      // Merged: the first follow-up is filed already, the other waits for "File issue".
      spotCheck: spotCheckOf(s, itemId),
      followUps: w.mergedAt
        ? (MOCK_APPROVAL.followUps ?? []).map((f, n) => ({
            ...f,
            issue:
              filedFollowUps.get(`${itemId}:${n}`) ??
              (n === 0
                ? { number: 412, url: "https://github.com/hearth-co/hearth/issues/412" }
                : null),
            // In the dark factory, the scout's held list says which one waits for a round.
            ...(s.scout?.heldFollowUps.some((h) => h.itemId === itemId && h.index === n)
              ? { heldAt: w.mergedAt as string }
              : {}),
            ...(dismissedFollowUps.has(`${itemId}:${n}`)
              ? {
                  heldAt: w.mergedAt as string,
                  dropped: { reason: "dismissed" as const, at: now() },
                }
              : {}),
          }))
        : [],
      checks: s.mergeChecks.find((c) => c.itemId === itemId)?.checks ?? [],
      attempts: w.attempts,
      failureKind: w.failureKind,
      stop: null,
      rebuiltFrom: null,
      mergeSha: null,
      mergePath: w.mergedAt ? "fast" : null,
      revertOf: null,
      triageRequestedAt: null,
      nudges: {},
      largeChange: null,
      sessionsArchivedAt: null,
      earlierSessionIds: [],
      sessionIds: w.sessionId ? [w.sessionId] : [],
      itemBudgetSince: null,
      stepSince: w.stepSince,
      createdAt: w.updatedAt,
      mergedAt: w.mergedAt,
      finishedAt: w.finishedAt,
    };
  };
  const loop = (projectId: string) =>
    FactoryLoop.parse({
      projectId,
      state: status(projectId).loopState,
      pausedReason: null,
      consecutiveFailures: 0,
      day: now().slice(0, 10),
      mergesToday: status(projectId).mergesToday,
      discovery: [],
      nextArea: 0,
      lastDiscoveryAt: null,
      lastDigestDay: null,
      enabledAt: null,
      lastTickAt: now(),
      updatedAt: now(),
    });

  return {
    status: (id) => delay(status(id), 140),
    item: (id, itemId) => delay({ item: item(id, itemId), cost: find(id, itemId).cost }),
    scorecard: (id, days) =>
      delay(demoScorecard(id, days, isFactoryMode(project(id)?.autonomyMode ?? "assisted"))),
    async setMode(projectId, req) {
      const p = project(projectId);
      if (!p) throw new Error(`No project ${projectId}`);
      const limits = FactoryLimits.parse(req.limits ?? p.factoryLimits);
      const mode = AutonomyMode.parse(req.mode);
      world.emitDomain({
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...p, autonomyMode: mode, factoryLimits: limits } },
      });
      world.factory.delete(projectId);
      return { projectId, mode, limits, experimental: isFactoryMode(mode) };
    },
    async vision(projectId) {
      const contents = visions.get(projectId) ?? visionDoc;
      const path = project(projectId)?.visionPath ?? ".agent-rishi/VISION.md";
      return { path, exists: true, contents, parsed: parseVision(contents) };
    },
    async saveVision(projectId, contents) {
      visions.set(projectId, contents);
      const path = project(projectId)?.visionPath ?? ".agent-rishi/VISION.md";
      return { path, exists: true, contents, parsed: parseVision(contents) };
    },
    async killSwitch(scope, on, opts = {}) {
      if (scope === "global") {
        if (on && opts.mode === "drain") throw new Error("Draining is per project");
        const settings = { ...world.snapshot.settings, factory: { killSwitch: on } };
        world.emitDomain({ type: "settings.updated", sessionId: null, payload: { settings } });
        world.factory.clear();
        return { on, stoppedSessions: [], draining: false, inFlight: 0 };
      }
      const s = status(scope.projectId);
      // A drain: the work in flight finishes first (the mock keeps it draining until resumed).
      const inFlight = s.inProgress.length;
      if (on && opts.mode === "drain" && inFlight > 0) {
        const at = now();
        const deadline = opts.drainLimitMin
          ? new Date(Date.parse(at) + opts.drainLimitMin * 60_000).toISOString()
          : null;
        world.factory.set(scope.projectId, {
          ...s,
          loopState: "draining",
          drain: { since: at, inFlight, total: inFlight, deadline },
        });
        return { on: false, stoppedSessions: [], draining: true, inFlight };
      }
      world.factory.set(scope.projectId, {
        ...s,
        killSwitch: on,
        loopState: on ? "stopped" : "building",
        drain: null,
      });
      const p = project(scope.projectId);
      if (p)
        world.emitDomain({
          type: "project.updated",
          sessionId: null,
          payload: { project: { ...p, killSwitch: on } },
        });
      return { on, stoppedSessions: [], draining: false, inFlight: 0 };
    },
    async resume(id) {
      const s = status(id);
      if (s.drain) world.factory.set(id, { ...s, drain: null, loopState: "building" });
      return delay(loop(id));
    },
    tick: (id) => delay(status(id)),
    async runScout(projectId) {
      const s = status(projectId);
      const blocked =
        s.scout?.runNowBlockedBy ?? (s.scout ? null : "Only a dark factory has a scout.");
      if (blocked) throw new Error(blocked);
      const next: FactoryStatus = {
        ...s,
        scout: s.scout && {
          ...s.scout,
          phase: "planning",
          lenses: [],
          findings: 0,
          filed: 0,
          rounds: s.scout.rounds + 1,
          nextRoundAt: null,
          runNowBlockedBy: "A scout round is already running.",
        },
      };
      world.factory.set(projectId, next);
      return delay(next);
    },
    async digest(projectId) {
      return {
        id: `digest-${projectId}`,
        projectId,
        day: now().slice(0, 10),
        shipped: [],
        rejected: [],
        spend: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
        waiting: [],
        decisions: [],
        handled: [],
        spotChecks: {
          checkedToday: 0,
          problemsToday: 0,
          outstanding: status(projectId).spotChecks.outstanding,
          checked30d: status(projectId).spotChecks.checked30d,
          problems30d: status(projectId).spotChecks.problems30d,
        },
        lessons: [],
        followUps: {
          held: 0,
          filed: filedFollowUps.size,
          dropped: 0,
          dismissed: dismissedFollowUps.size,
          waiting: status(projectId).scout?.heldFollowUps.length ?? 0,
        },
        text: "Nothing shipped yet today.",
        createdAt: now(),
      };
    },
    admit: async (id, req) => ({
      ...item(id, req.itemId),
      stage: "candidate",
      trust: "admitted",
      admittedBy: "user",
    }),
    setType: async (id, req) => ({ ...item(id, req.itemId), type: req.type }),
    retry: async (id, itemId, opts) => {
      const it = item(id, itemId);
      const open = it.pr?.state === "open" || it.pr?.state === "draft";
      // With its PR open the PR goes back to review; otherwise the work starts over.
      return opts?.mode !== "rebuild" && open
        ? { ...it, stage: "verifying", review: null, attempts: 0 }
        : { ...it, stage: "backlog", pr: null };
    },
    dismiss: async (id, itemId, req) => ({
      ...item(id, itemId),
      stage: "rejected",
      reason: req?.reason ? `Dismissed by you: ${req.reason}` : "Dismissed by you",
    }),
    async decideSpec(id, itemId, req) {
      const current = item(id, itemId).specApproval;
      if (current?.state !== "pending") throw new Error("This spec doesn't wait for approval");
      assertSpecVersion(current, req.version);
      const approve = req.decision === "approve";
      specs.set(itemId, {
        ...current,
        state: approve ? "approved" : "changes_requested",
        decidedAt: now(),
        by: "user",
        feedback: approve ? current.feedback : req.feedback,
        rounds: current.rounds + (approve ? 0 : 1),
      });
      const s = status(id);
      const decided = (w: FactoryWorkItem): FactoryWorkItem =>
        w.id !== itemId
          ? w
          : {
              ...w,
              specApproval: approve ? "approved" : "changes_requested",
              step: approve ? "implement" : "analyze",
              note: approve
                ? "Spec approved: the builder implements it next"
                : "Changes requested to the spec: the builder revises it",
            };
      world.factory.set(id, { ...s, inProgress: s.inProgress.map(decided) });
      // Its inbox item no longer waits on you.
      const ask = world.snapshot.inbox.find((x) => x.id === specInboxId(itemId));
      if (ask?.status === "open") {
        const at = now();
        world.emitDomain({
          type: "inbox.updated",
          sessionId: null,
          payload: {
            item: { ...ask, status: "resolved", resolvedAt: at, updatedAt: at, resolution: null },
          },
        });
      }
      return delay(item(id, itemId));
    },
    forgetLesson: async (id, lessonId) => {
      const s = status(id);
      const lesson = s.lessons.find((l) => l.id === lessonId);
      if (!lesson) throw new Error(`No lesson ${lessonId}`);
      world.factory.set(id, { ...s, lessons: s.lessons.filter((l) => l.id !== lessonId) });
      return delay({ ...lesson, removedAt: now() });
    },
    async fileFollowUp(id, itemId, index) {
      const it = item(id, itemId);
      if (!it.followUps[index]) throw new Error(`No follow-up ${index}`);
      const key = `${itemId}:${index}`;
      if (!filedFollowUps.has(key)) {
        const number = 500 + filedFollowUps.size;
        filedFollowUps.set(key, {
          number,
          url: `https://github.com/hearth-co/hearth/issues/${number}`,
        });
      }
      world.factory.set(id, withoutHeld(status(id), itemId, index));
      return delay(item(id, itemId));
    },
    async dismissFollowUp(id, itemId, index) {
      const key = `${itemId}:${index}`;
      if (filedFollowUps.has(key)) throw new Error("Already filed");
      dismissedFollowUps.add(key);
      world.factory.set(id, withoutHeld(status(id), itemId, index));
      return delay(item(id, itemId));
    },
    async spotCheck(id, itemId, req) {
      const next = decideMockSpotCheck(world, status(id), itemId, req, 600 + spotIssues++);
      world.factory.set(id, next);
      return delay({ item: item(id, itemId), issueError: null });
    },
    async fileSpotCheckIssue(id, itemId) {
      world.factory.set(id, fileMockSpotCheckIssue(status(id), itemId, 600 + spotIssues++));
      return delay({ item: item(id, itemId), issueError: null });
    },
  };
}

/**
 * The demo's merged item whose review lessons weren't kept: someone the project doesn't trust
 * commented on its pull request.
 */
const DROPPED_LESSONS = {
  itemId: "fw-8",
  lesson: "Always run the deploy workflow from a pull request branch.",
  note: "Its lesson wasn't kept: @drive-by (on #55) commented without the project's trust, and a lesson reaches every later brief",
};

/** A merged demo item's verdict. */
function demoReview(itemId: string): ReviewVerdict {
  if (itemId !== DROPPED_LESSONS.itemId) return MOCK_APPROVAL;
  return { ...MOCK_APPROVAL, lessons: [DROPPED_LESSONS.lesson] };
}

/** Lessons the demo factory's reviewers recorded: one in briefs, one new and still waiting. */
function demoLessons(projectId: string): FactoryLesson[] {
  const lesson = (n: number, text: string, prNumber: number, times: number, ago: number) => ({
    id: `lesson-${n}`,
    projectId,
    text,
    key: lessonKey(text),
    itemId: `fw-l${n}`,
    prNumber,
    reviewerProvider: "codex",
    times,
    createdAt: minutesAgo(times > 1 ? 3 * 24 * 60 : ago),
    lastSeenAt: minutesAgo(ago),
    removedAt: null,
  });
  return [
    lesson(
      1,
      "Every user-facing change adds a changelog fragment in changes/<issue>-<slug>.md; never edit CHANGELOG.md.",
      214,
      3,
      40,
    ),
    lesson(
      2,
      "Put unit tests next to their package in test/, not beside the source file.",
      209,
      1,
      180,
    ),
  ];
}
