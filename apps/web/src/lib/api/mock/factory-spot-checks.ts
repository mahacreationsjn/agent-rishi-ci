import {
  type AutonomyMode,
  type FactorySpotCheckRequestInit,
  type FactorySpotChecks,
  type FactoryStatus,
  type FactoryTuning,
  type FactoryWorkItem,
  isFactoryMode,
  type SpotCheck,
  type SpotCheckEntry,
  type SpotCheckReason,
  spotCheckShare,
} from "@agent-rishi/contracts";
import type { MockWorld } from "./world";

/**
 * The mock client's spot-checks (§10.1): the demo factory's merged work, two merges waiting for a
 * person's look and one already checked, plus Looks good / Found a problem / File issue over the
 * in-memory status.
 */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const VERDICT = {
  verdict: "approve" as const,
  summary: "Meets every criterion; the tests cover the new path. Two things can wait.",
};

/** The demo factory's spot-check inbox item (one per project). */
export const spotCheckInboxId = (projectId: string) => `inbox:factory-spot-checks:${projectId}`;

function entry(w: FactoryWorkItem, check: SpotCheck): SpotCheckEntry {
  return {
    itemId: w.id,
    title: w.title,
    pr: w.pr,
    issue: w.issue,
    check,
    mergedAt: w.mergedAt,
    verdict: VERDICT,
  };
}

/** The demo's spot-checks over its merged items: the first two wait, the rest were checked. */
export function demoSpotChecks(
  mode: AutonomyMode,
  tuning: FactoryTuning,
  recent: FactoryWorkItem[],
): FactorySpotChecks {
  const percent = spotCheckShare(mode, tuning);
  const merged = recent.filter((w) => w.stage === "merged" && w.pr);
  if (!isFactoryMode(mode) || percent === 0 || merged.length === 0) {
    return { percent, outstanding: 0, checked30d: 0, problems30d: 0, pending: [], recent: [] };
  }
  const reasons: SpotCheckReason[] = ["sampled", "large_change"];
  const pending = merged.slice(0, 2).map((w, n) =>
    entry(w, {
      reason: reasons[n] ?? "sampled",
      state: "pending",
      sampledAt: w.mergedAt ?? minutesAgo(30),
      checkedAt: null,
      note: null,
      issue: null,
    }),
  );
  const checked = merged.slice(2, 4).map((w, n) =>
    entry(w, {
      reason: "sampled",
      state: n === 0 ? "problem" : "looks_good",
      sampledAt: w.mergedAt ?? minutesAgo(600),
      checkedAt: minutesAgo(90 + n * 60),
      note: n === 0 ? "The empty state shows twice when the list is filtered to nothing." : null,
      issue:
        n === 0
          ? {
              number: 431,
              url: "https://github.com/hearth-co/hearth/issues/431",
              title: `Spot-check: ${w.title}`,
            }
          : null,
    }),
  );
  return {
    percent,
    outstanding: pending.length,
    checked30d: checked.length + 9,
    problems30d: checked.filter((e) => e.check.state === "problem").length + 1,
    pending,
    recent: checked,
  };
}

/** The spot-check of an item in the status, if it has one. */
export function spotCheckOf(s: FactoryStatus, itemId: string): SpotCheck | null {
  const all = [...s.spotChecks.pending, ...s.spotChecks.recent];
  return all.find((e) => e.itemId === itemId)?.check ?? null;
}

/** Record a decision (and file its issue) in the status; resolves the inbox item once none waits. */
export function decideMockSpotCheck(
  world: MockWorld,
  s: FactoryStatus,
  itemId: string,
  req: FactorySpotCheckRequestInit,
  issueNumber: number,
): FactoryStatus {
  const waiting = s.spotChecks.pending.find((e) => e.itemId === itemId);
  if (!waiting) throw new Error("This merge's spot-check is already recorded");
  const problem = req.verdict === "problem";
  const fileIssue = problem && req.fileIssue !== false;
  const checked: SpotCheckEntry = {
    ...waiting,
    check: {
      ...waiting.check,
      state: req.verdict,
      checkedAt: new Date().toISOString(),
      note: req.note?.trim() || null,
      issue: fileIssue
        ? {
            number: issueNumber,
            url: `https://github.com/hearth-co/hearth/issues/${issueNumber}`,
            title: `Spot-check: ${waiting.title}`,
          }
        : null,
    },
  };
  const pending = s.spotChecks.pending.filter((e) => e.itemId !== itemId);
  const next: FactoryStatus = {
    ...s,
    spotChecks: {
      ...s.spotChecks,
      outstanding: pending.length,
      checked30d: s.spotChecks.checked30d + 1,
      problems30d: s.spotChecks.problems30d + (problem ? 1 : 0),
      pending,
      recent: [checked, ...s.spotChecks.recent].slice(0, 10),
    },
  };
  const ask = world.snapshot.inbox.find((x) => x.id === spotCheckInboxId(s.projectId));
  if (ask?.status === "open") {
    const at = new Date().toISOString();
    const n = pending.length;
    const item =
      n === 0
        ? { ...ask, status: "resolved" as const, resolvedAt: at, updatedAt: at, resolution: null }
        : { ...ask, title: ask.title.replace(/^\d+ merges?/, `${n} merge${n === 1 ? "" : "s"}`) };
    world.emitDomain({ type: "inbox.updated", sessionId: null, payload: { item } });
  }
  return next;
}

/** "File issue" for a problem recorded without one. */
export function fileMockSpotCheckIssue(
  s: FactoryStatus,
  itemId: string,
  issueNumber: number,
): FactoryStatus {
  const recent = s.spotChecks.recent.map((e) =>
    e.itemId === itemId && e.check.state === "problem" && !e.check.issue
      ? {
          ...e,
          check: {
            ...e.check,
            issue: {
              number: issueNumber,
              url: `https://github.com/hearth-co/hearth/issues/${issueNumber}`,
              title: `Spot-check: ${e.title}`,
            },
          },
        }
      : e,
  );
  return { ...s, spotChecks: { ...s.spotChecks, recent } };
}
