import type {
  FactoryItem,
  FactoryItemCost,
  FactoryScorecard,
  FactoryScorecardRow,
  ScorecardAgent,
  ScorecardDays,
} from "@agent-rishi/contracts";
import type { FactoryContext } from "./context";
import { itemCosts } from "./item-cost";
import { isInfraFailure } from "./recover";
import { median, revertedAt } from "./stats";

/**
 * The factory scorecard (§10.1, Visibility): first-pass merges, revise rounds, reverts, cost and
 * time to merge by builder and by reviewer (provider and model), and by the two together, over
 * the work that finished in a window. Read on demand, never part of `FactoryStatus`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** What the scorecard needs besides the items: each session's model and each item's cost. */
export interface ScorecardFacts {
  /** The model each session ran (null: the provider's default), by session id. */
  models: ReadonlyMap<string, string | null>;
  /** What each item cost, by item id (`itemCosts`). */
  costs: ReadonlyMap<string, FactoryItemCost>;
}

type Outcome = "merged" | "failed";

/**
 * How the item finished in the window, or null when it doesn't count: the factory's own reverts,
 * work without a builder, and anything that neither merged in the window nor failed in it
 * because of its own work (infrastructure failures go back by themselves; rejected, escalated,
 * ignored and unfinished work isn't a result).
 */
export function scorecardOutcome(item: FactoryItem, since: number, now: number): Outcome | null {
  if (item.source === "revert" || !item.builderProvider) return null;
  const inWindow = (at: string | null) => {
    if (!at) return false;
    const t = Date.parse(at);
    return t >= since && t <= now;
  };
  if (inWindow(item.mergedAt)) return "merged";
  if (item.mergedAt === null && item.stage === "failed" && !isInfraFailure(item)) {
    return inWindow(item.finishedAt) ? "failed" : null;
  }
  return null;
}

function agent(
  provider: string | null,
  sessionId: string | null,
  models: ScorecardFacts["models"],
): ScorecardAgent | null {
  if (!provider) return null;
  return { provider, model: (sessionId ? models.get(sessionId) : null) ?? null };
}

interface Tally {
  key: string;
  builder: ScorecardAgent | null;
  reviewer: ScorecardAgent | null;
  merged: number;
  failed: number;
  firstPass: number;
  reviseRounds: number;
  reverted: number;
  durations: number[];
  costUsd: number;
  estimatedUsd: number;
  unpricedTurns: number;
  apiEquivalent: boolean;
  spotChecked: number;
  spotProblems: number;
}

function add(
  rows: Map<string, Tally>,
  group: Pick<Tally, "builder" | "reviewer">,
  item: FactoryItem,
  outcome: Outcome,
  cost: FactoryItemCost | undefined,
): void {
  const key = JSON.stringify([group.builder, group.reviewer]);
  let row = rows.get(key);
  if (!row) {
    row = {
      key,
      ...group,
      merged: 0,
      failed: 0,
      firstPass: 0,
      reviseRounds: 0,
      reverted: 0,
      durations: [],
      costUsd: 0,
      estimatedUsd: 0,
      unpricedTurns: 0,
      apiEquivalent: false,
      spotChecked: 0,
      spotProblems: 0,
    };
    rows.set(key, row);
  }
  row.reviseRounds += item.attempts;
  if (outcome === "merged") {
    const reverted = revertedAt(item) !== null;
    // What a person found when they spot-checked the merge (`spot-checks.ts`).
    const spot = item.spotCheck?.state;
    if (spot === "looks_good" || spot === "problem") row.spotChecked++;
    if (spot === "problem") row.spotProblems++;
    row.merged++;
    // A merge reverted before its revise round (older items, `stage: reverted`) wasn't a pass.
    if (item.attempts === 0 && !reverted) row.firstPass++;
    if (reverted) row.reverted++;
    row.durations.push(
      Math.max(0, Date.parse(item.mergedAt as string) - Date.parse(item.createdAt)),
    );
  } else {
    row.failed++;
  }
  if (cost) {
    row.costUsd += cost.usd;
    row.estimatedUsd += cost.estimatedUsd;
    row.unpricedTurns += cost.unpricedTurns;
    row.apiEquivalent ||= cost.apiEquivalent;
  }
}

function toRow(t: Tally): FactoryScorecardRow {
  const costUsd = round(t.costUsd);
  return {
    key: t.key,
    builder: t.builder,
    reviewer: t.reviewer,
    finished: t.merged + t.failed,
    merged: t.merged,
    failed: t.failed,
    firstPass: t.firstPass,
    reviseRounds: t.reviseRounds,
    reverted: t.reverted,
    medianMergeMs: median(t.durations),
    costUsd,
    costPerMergeUsd: t.merged > 0 ? round(t.costUsd / t.merged) : null,
    estimatedUsd: round(t.estimatedUsd),
    unpricedTurns: t.unpricedTurns,
    apiEquivalent: t.apiEquivalent,
    spotChecked: t.spotChecked,
    spotProblems: t.spotProblems,
  };
}

/** Most finished work first, then most merges, then by key (code units) so the order is stable. */
function sorted(rows: Map<string, Tally>): FactoryScorecardRow[] {
  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()]
    .map(toRow)
    .sort((a, b) => b.finished - a.finished || b.merged - a.merged || byKey(a.key, b.key));
}

/**
 * The scorecard over `items` (the project's, any stage) for the `days` before `now`. Each item
 * counts for the builder and reviewer of its last attempt, with that session's model.
 */
export function scorecard(
  projectId: string,
  items: FactoryItem[],
  facts: ScorecardFacts,
  now: Date,
  days: ScorecardDays,
): FactoryScorecard {
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const builders = new Map<string, Tally>();
  const reviewers = new Map<string, Tally>();
  const pairs = new Map<string, Tally>();
  let finished = 0;
  for (const item of items) {
    const outcome = scorecardOutcome(item, since, end);
    if (!outcome) continue;
    finished++;
    const builder = agent(item.builderProvider, item.builderSessionId, facts.models);
    const reviewer = agent(item.reviewerProvider, item.reviewerSessionId, facts.models);
    const cost = facts.costs.get(item.id);
    add(builders, { builder, reviewer: null }, item, outcome, cost);
    add(reviewers, { builder: null, reviewer }, item, outcome, cost);
    add(pairs, { builder, reviewer }, item, outcome, cost);
  }
  return {
    projectId,
    days,
    since: new Date(since).toISOString(),
    finished,
    builders: sorted(builders),
    reviewers: sorted(reviewers),
    pairs: sorted(pairs),
  };
}

/**
 * `GET /api/projects/:id/factory/scorecard`: the project's items, the models of the counted
 * items' builder and reviewer sessions (looked up by id, archived or not, however many sessions
 * the project has had since) and what the counted items cost, from one ledger read.
 */
export async function buildScorecard(
  ctx: Pick<FactoryContext, "projects" | "now" | "store" | "repo" | "usage" | "sessions">,
  projectId: string,
  days: ScorecardDays,
): Promise<FactoryScorecard> {
  const project = ctx.projects.get(projectId);
  const now = ctx.now();
  const end = now.getTime();
  const since = end - days * DAY_MS;
  const counted = ctx.store
    .items(projectId)
    .filter((i) => scorecardOutcome(i, since, end) !== null);
  const models = ctx.repo.modelsOf(
    counted.flatMap((i) => [i.builderSessionId, i.reviewerSessionId].filter((id) => id !== null)),
  );
  const costs = await itemCosts(ctx, projectId, project.factoryLimits, counted);
  return scorecard(projectId, counted, { models, costs }, now, days);
}
