import { randomUUID } from "node:crypto";
import {
  type DigestFollowUps,
  type DigestLesson,
  type DigestSpotChecks,
  type FactoryDigest,
  type FactoryItem,
  type FactoryLimits,
  type FactoryLoop,
  factoryNeed,
  factoryNeedLabel,
  HELD_FOLLOW_UP_DAYS,
  HELD_FOLLOW_UPS_MAX,
  type InboxItem,
  type Project,
  SPOT_CHECK_WINDOW_DAYS,
  spotCheckProblemPercent,
} from "@agent-rishi/contracts";
import type { InboxService } from "../inbox-service";
import { budgetSpend, type FactoryContext, factoryNotice, raiseInbox } from "./context";
import { drainLine } from "./drain";
import { digestFollowUps } from "./follow-ups-held";
import { digestLessons } from "./lessons";
import { prInboxIds } from "./merge";
import { localDay } from "./policy";
import { ownedPr } from "./pr-status";
import { recoverable } from "./recover";
import { specInboxId, specPending } from "./spec-approval";
import { digestSpotChecks, spotCheckInboxId } from "./spot-checks";
import { lastMergeReverted } from "./stats";
import { endedByStop } from "./stops";
import { OWNED_STAGES } from "./store";
import { DECISION_INBOX_PREFIX } from "./unattended";

/** Build, store and announce a day's digest: an inbox item and a notice to the orchestrator. */
export async function writeDigest(
  ctx: FactoryContext,
  inbox: InboxService,
  project: Project,
  loop: FactoryLoop,
  day: string,
): Promise<FactoryDigest> {
  const all = ctx.store.items(project.id);
  const items = all.filter((i) => localDay(new Date(i.updatedAt)) === day);
  const digest = buildDigest({
    projectId: project.id,
    projectName: project.name,
    day,
    items,
    needsYou: needsYouItems(ctx, project.id),
    inbox: inbox.list({ projectId: project.id }),
    settled: inbox.list({ projectId: project.id, status: "resolved" }),
    spend: budgetSpend(ctx, project.id, day, project.factoryLimits),
    limits: project.factoryLimits,
    pausedReason: loop.state === "paused" ? loop.pausedReason : null,
    draining: drainLine(ctx, project.id, loop),
    spotChecks: digestSpotChecks(ctx, project.id, day),
    lessons: digestLessons(ctx, project.id, day),
    // Every item: a follow-up of a merge weeks ago may have expired today.
    followUps: digestFollowUps(all, day),
    now: ctx.now(),
  });
  ctx.store.saveDigest(digest);
  raiseInbox(ctx, {
    id: `inbox:factory-digest:${project.id}:${day}`,
    kind: "automation_result",
    notify: "factory",
    priority: "low",
    projectId: project.id,
    title: `Factory digest: ${project.name}, ${day} (${digest.shipped.length} shipped, ${digest.rejected.length} rejected, ${digest.waiting.length} waiting)`,
    body: digest.text,
  });
  factoryNotice(ctx, {
    id: `factory.digest:${digest.id}`,
    projectId: project.id,
    target: "orchestrator",
    event: "digest",
    title: `Factory digest for ${project.name} (${day})`,
    text: digest.text,
    wake: false,
  });
  return digest;
}

/**
 * Work that waits on a person, whenever it happened, by the definition the Factory view's "Needs
 * you" uses (`factoryNeed`): escalations, failures with an open PR or from the last day that the
 * factory doesn't recover by itself, and specs waiting for approval.
 */
export function needsYouItems(ctx: FactoryContext, projectId: string): DigestNeed[] {
  const now = ctx.now().getTime();
  const specs = ctx.store.items(projectId, ["building"]).filter(specPending);
  return [...ctx.store.items(projectId, OWNED_STAGES), ...specs].flatMap((item) => {
    const open = ownedPr(ctx, item);
    const kind = factoryNeed(item, {
      stoppedOnPurpose: endedByStop(item),
      now,
      ownsOpenPr: open !== null,
      recovering: recoverable(item),
      specPending: specPending(item),
    });
    if (!kind) return [];
    const need = factoryNeedLabel(kind, {
      attempts: item.attempts,
      prNumber: open?.number ?? null,
    });
    return [{ item, need }];
  });
}

/** An item that waits on a person, and what it needs. */
export interface DigestNeed {
  item: FactoryItem;
  need: string;
}

/**
 * The daily digest (§10.1 step 7): what shipped, what was rejected and why, spend against the
 * budget, and what is waiting on the user. Pure; the service stores it, raises the inbox item
 * and notifies the orchestrator.
 */
export function buildDigest(opts: {
  projectId: string;
  projectName: string;
  day: string;
  /** Items that changed during the day. */
  items: FactoryItem[];
  /** Items still waiting on a person, whenever they happened (`needsYouItems`). */
  needsYou: DigestNeed[];
  /** The project's open inbox items. */
  inbox: InboxItem[];
  /** The project's resolved inbox items (failures the factory handled are among them). */
  settled?: InboxItem[];
  spend: { usd: number; tokens: number };
  limits: FactoryLimits;
  pausedReason: string | null;
  /** "Draining: 2 items in flight" while the kill switch's drain runs. */
  draining?: string | null;
  /** Spot-checks of the day and the window (`digestSpotChecks`); none by default. */
  spotChecks?: DigestSpotChecks;
  /** Lessons first learned during the day (`digestLessons`); none by default. */
  lessons?: DigestLesson[];
  /** Review follow-ups held, filed and dropped during the day (`digestFollowUps`). */
  followUps?: DigestFollowUps;
  now?: Date;
}): FactoryDigest {
  const shipped = opts.items
    .filter((i) => i.mergedAt !== null && dayOf(i.mergedAt) === opts.day)
    .map((i) => ({ itemId: i.id, title: i.title, pr: i.pr, reverted: lastMergeReverted(i) }));
  const rejected = opts.items
    .filter((i) => i.stage === "rejected" || i.stage === "failed")
    .map((i) => ({
      itemId: i.id,
      title: i.title,
      stage: i.stage,
      reason: i.reason ?? (i.stage === "rejected" ? "Rejected by the PM" : "Merge checks failed"),
    }));
  // The inbox items about those items (ready, protected area, stuck, a spec to approve) are
  // listed with them.
  const listed = new Set(
    opts.needsYou.flatMap(({ item }) => [...prInboxIds(item.id), specInboxId(item.id)]),
  );
  const waiting = [
    ...opts.needsYou.map(({ item, need }) => ({
      title: `${item.title}: ${need}${item.reason ? ` (${item.reason})` : ""}`,
      inboxItemId: null,
      itemId: item.id,
    })),
    ...opts.inbox
      .filter(
        (x) =>
          x.status === "open" &&
          !listed.has(x.id) &&
          !x.id.startsWith("inbox:factory-digest:") &&
          // Spot-checks have their own line (`spotChecks`); nothing waits on them.
          x.id !== spotCheckInboxId(opts.projectId) &&
          // Decisions the factory made on its own are reported, not waiting (unless flagged).
          !(x.id.startsWith(DECISION_INBOX_PREFIX) && x.priority !== "high") &&
          // Its own sessions' failures are the factory's to handle (reported under `handled`).
          !isFactoryFailure(x),
      )
      .map((x) => ({ title: x.title, inboxItemId: x.id, itemId: null })),
  ];
  const handled = (opts.settled ?? [])
    .filter((x) => isFactoryFailure(x) && dayOf(x.resolvedAt ?? x.createdAt) === opts.day)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((x) => ({ title: x.title, detail: x.body ?? "", inboxItemId: x.id }));
  const decisions = opts.inbox
    .filter((x) => x.id.startsWith(DECISION_INBOX_PREFIX) && dayOf(x.createdAt) === opts.day)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((x) => ({
      title: x.title,
      decision: /\*\*Decision:\*\* (.*)/.exec(x.body ?? "")?.[1] ?? "",
      needsHuman: x.priority === "high",
      inboxItemId: x.id,
    }));
  const spend = {
    usd: Math.round(opts.spend.usd * 100) / 100,
    tokens: opts.spend.tokens,
    budgetUsd: opts.limits.dailyBudget.usd ?? null,
    budgetTokens: opts.limits.dailyBudget.tokens ?? null,
  };
  const digest: Omit<FactoryDigest, "text"> = {
    id: randomUUID(),
    projectId: opts.projectId,
    day: opts.day,
    shipped,
    rejected,
    spend,
    waiting,
    decisions,
    handled,
    spotChecks: opts.spotChecks ?? {
      checkedToday: 0,
      problemsToday: 0,
      outstanding: 0,
      checked30d: 0,
      problems30d: 0,
    },
    lessons: opts.lessons ?? [],
    followUps: opts.followUps ?? { held: 0, filed: 0, dropped: 0, dismissed: 0, waiting: 0 },
    createdAt: (opts.now ?? new Date()).toISOString(),
  };
  return {
    ...digest,
    text: renderDigest(opts.projectName, digest, opts.pausedReason, opts.draining ?? null),
  };
}

/** A failed run of a factory session: the factory handles it by itself (`runFailedInbox`). */
function isFactoryFailure(x: InboxItem): boolean {
  return x.kind === "run_failed" && x.notify === "factory";
}

function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * "Spot-checks: 2 checked today (1 found a problem), 5 outstanding; over 30 days a person found a
 * problem in 1 of 7 checked merges (14%)"; null when there was nothing to spot-check.
 */
export function spotCheckLine(s: DigestSpotChecks | undefined): string | null {
  if (!s || s.checkedToday + s.outstanding + s.checked30d === 0) return null;
  const today = `${s.checkedToday} checked today${s.checkedToday > 0 ? ` (${s.problemsToday} found a problem)` : ""}`;
  const share = spotCheckProblemPercent(s.checked30d, s.problems30d);
  const window =
    share === null
      ? `none checked in the last ${SPOT_CHECK_WINDOW_DAYS} days`
      : `over ${SPOT_CHECK_WINDOW_DAYS} days a person found a problem in ${s.problems30d} of ${s.checked30d} checked merge${s.checked30d === 1 ? "" : "s"} (${share}%)`;
  return `Spot-checks: ${today}, ${s.outstanding} outstanding; ${window}.`;
}

/**
 * "Review follow-ups: 3 held for the scout, 1 filed, 2 dropped (duplicates, older than 14 days or
 * over the cap of 50), 1 dismissed; 7 held now."; null when there was nothing to say. Without the
 * scout's held list (nothing held that day or now, none dropped from it: a software factory, or a
 * dark factory whose scout runs no rounds) it doesn't mention holding: "Review follow-ups: 1 filed."
 */
export function followUpLine(f: DigestFollowUps | undefined): string | null {
  if (!f || f.held + f.filed + f.dropped + f.dismissed + f.waiting === 0) return null;
  if (f.held + f.waiting + f.dropped === 0) {
    const parts = [
      ...(f.filed > 0 ? [`${f.filed} filed`] : []),
      ...(f.dismissed > 0 ? [`${f.dismissed} dismissed`] : []),
    ];
    return `Review follow-ups: ${parts.join(", ")}.`;
  }
  const parts = [
    `${f.held} held for the scout`,
    `${f.filed} filed`,
    ...(f.dropped > 0
      ? [
          `${f.dropped} dropped (duplicates, older than ${HELD_FOLLOW_UP_DAYS} days or over the cap of ${HELD_FOLLOW_UPS_MAX})`,
        ]
      : []),
    ...(f.dismissed > 0 ? [`${f.dismissed} dismissed`] : []),
  ];
  return `Review follow-ups: ${parts.join(", ")}; ${f.waiting} held now.`;
}

/** "from #3": the issue of the work whose review taught it, else its pull request. */
function lessonSource(l: DigestLesson): string {
  const number = l.issueNumber ?? l.prNumber;
  return number !== null ? `from #${number}` : "from a review";
}

/** Markdown text of a digest (inbox body and orchestrator notice). */
export function renderDigest(
  projectName: string,
  d: Omit<FactoryDigest, "text">,
  pausedReason: string | null,
  draining: string | null = null,
): string {
  const budget = [
    d.spend.budgetUsd !== null
      ? `$${d.spend.usd.toFixed(2)} of $${d.spend.budgetUsd.toFixed(2)}`
      : `$${d.spend.usd.toFixed(2)}`,
    d.spend.budgetTokens !== null
      ? `${d.spend.tokens} of ${d.spend.budgetTokens} tokens`
      : `${d.spend.tokens} tokens`,
  ].join(", ");
  const lines = [`Factory digest for ${projectName}, ${d.day}`, ""];
  if (pausedReason) lines.push(`The loop is paused: ${pausedReason}.`, "");
  if (draining) {
    lines.push(`${draining}: the factory takes on no new work and stops once they finish.`, "");
  }
  lines.push(`Shipped (${d.shipped.length}):`);
  for (const s of d.shipped) {
    lines.push(
      `- ${s.title}${s.pr ? ` (#${s.pr.number} ${s.pr.url})` : ""}${s.reverted ? " (reverted)" : ""}`,
    );
  }
  if (d.shipped.length === 0) lines.push("- nothing");
  lines.push("", `Rejected or failed (${d.rejected.length}):`);
  for (const r of d.rejected) lines.push(`- ${r.title}: ${r.reason}`);
  if (d.rejected.length === 0) lines.push("- nothing");
  if (d.decisions.length > 0) {
    lines.push("", `Decided on its own (${d.decisions.length}):`);
    for (const x of d.decisions) {
      lines.push(`- ${x.title}${x.decision ? ` → ${x.decision}` : ""}`);
    }
  }
  if (d.handled.length > 0) {
    lines.push("", `Failures it handled on its own (${d.handled.length}):`);
    for (const h of d.handled) lines.push(`- ${h.title}${h.detail ? `: ${h.detail}` : ""}`);
  }
  if (d.lessons.length > 0) {
    lines.push(
      "",
      `Learned from reviews (${d.lessons.length}); each goes into briefs a day after it was learned, unless you forget it in the Factory view's Lessons:`,
    );
    for (const l of d.lessons) lines.push(`- New lesson: ${l.text}, ${lessonSource(l)}`);
  }
  lines.push("", `Spend: ${budget}`);
  const spot = spotCheckLine(d.spotChecks);
  if (spot) lines.push("", spot);
  const followUps = followUpLine(d.followUps);
  if (followUps) lines.push("", followUps);
  lines.push("", `Waiting on you (${d.waiting.length}):`);
  for (const w of d.waiting) lines.push(`- ${w.title}`);
  if (d.waiting.length === 0) lines.push("- nothing");
  return lines.join("\n");
}
