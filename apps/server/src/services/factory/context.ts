import type {
  BillingMode,
  FactoryItem,
  FactoryLimits,
  FactoryLoop,
  GitHubIssueRef,
  GitHubPrRef,
  InboxItem,
  ParsedVision,
  Project,
} from "@agent-rishi/contracts";
import type { SettingsStore } from "../../settings-store";
import type { Exec } from "../exec";
import type { InboxService } from "../inbox-service";
import type { NoticeDraft } from "../orchestration/notices";
import type { ProjectService } from "../projects/project-service";
import type { SessionRepo } from "../sessions/repo";
import type { RateLimitReading } from "./availability";
import type { FactoryGithub } from "./github-port";
import type { LedgerTurn } from "./item-cost";
import type { MainCiReads } from "./main-ci";
import type { PrFiles } from "./overlap";
import type { FactorySessions } from "./sessions";
import type { SlotBoard } from "./slots";
import type { FactoryStore } from "./store";
import { readVision } from "./vision";

/** Everything the loop steps need; built once by `FactoryService`. */
export interface FactoryContext {
  store: FactoryStore;
  github: FactoryGithub;
  sessions: FactorySessions;
  projects: ProjectService;
  repo: SessionRepo;
  usage: {
    spendSince(
      day: string,
      projectId?: string,
      sessionIds?: ReadonlySet<string>,
    ): { usd: number; tokens: number };
    /** Latest rate-limit window of every provider: a `limited` one makes it unavailable. */
    rateLimitWindows?(): RateLimitReading[];
    /** Priced ledger turns of these sessions, all time, for item costs (`item-cost.ts`). */
    turnsOf?(sessionIds: ReadonlySet<string>): LedgerTurn[];
    /** How each provider is paid for, for "API-equivalent" costs (§12.6). */
    providerBilling?(): Promise<Record<string, BillingMode>>;
  };
  inbox: InboxService;
  /** Record an orchestration notice (wakes its target unless `wake` is false). */
  notify: (draft: NoticeDraft, wake?: boolean) => void;
  settings: SettingsStore;
  exec: Exec;
  /** One call to the utility model (the "Identify type" step); null when none answered. */
  complete: (job: string, system: string, prompt: string) => Promise<string | null>;
  /**
   * Archive sessions of finished work in the background, in order, which removes their
   * worktrees (see `cleanup.ts`). Sessions gone, archived or busy by then are left alone.
   */
  archiveSessions: (sessionIds: string[]) => void;
  /** Who gets the next free agent slot (`slots.ts`), in memory. */
  slots: SlotBoard;
  /** Files changed by the factory's open PRs as last read, for overlap-aware scheduling. */
  prFiles: PrFiles;
  /**
   * Projects whose branch protection wants pull requests up to date before they merge, as the
   * merge queue last saw (in memory): there every PR is re-tested, one at a time (`queue.ts`).
   */
  upToDateRequired: Set<string>;
  /** CI on each project's default branch, read once per tick (`main-ci.ts`), in memory. */
  mainCi: MainCiReads;
  /**
   * Give GitHub a moment to work out the next queued PR against a default branch that just
   * moved (the merge before it), so merges follow each other within seconds (`queue.ts`).
   */
  settle: () => Promise<void>;
  /** Turn a project's kill switch on or off (a `project.updated` event); no-op when it is already. */
  setKillSwitch: (projectId: string, on: boolean) => void;
  now: () => Date;
  /**
   * How long CI may take to start on a commit (a PR's new head, a merge on the default branch)
   * before "no checks" counts as never started (default 10 minutes).
   */
  ciGraceMs: number;
  log?: (message: string) => void;
}

/** The branch factory PRs target. */
export function baseBranchOf(project: Project): string {
  return project.kind === "github"
    ? project.github.defaultBranch
    : (project.defaultBranch ?? "main");
}

/** The vision text and its parsed form ("" and empty when the file is missing). */
export function visionOf(project: Project): {
  text: string;
  parsed: ParsedVision;
  exists: boolean;
} {
  try {
    const v = readVision(project);
    return { text: v.exists ? v.contents : "", parsed: v.parsed, exists: v.exists };
  } catch {
    return {
      text: "",
      exists: false,
      parsed: {
        goals: [],
        users: [],
        principles: [],
        outOfScope: [],
        qualityBar: [],
        protectedAreas: { globs: [], topics: [] },
      },
    };
  }
}

/**
 * Raise (or refresh) a factory inbox item. `notify` says whether it needs the user (`needs_you`,
 * `failure`) or is the factory's own activity (`factory`), which toasts only when they ask for it.
 */
export function raiseInbox(
  ctx: FactoryContext,
  item: {
    id: string;
    kind: InboxItem["kind"];
    notify: InboxItem["notify"];
    projectId: string;
    title: string;
    body: string | null;
    priority?: InboxItem["priority"];
    sessionId?: string | null;
    issue?: GitHubIssueRef | null;
    pr?: GitHubPrRef | null;
    /** When what it asks about changed (its `updatedAt`); now by default. */
    at?: string;
  },
): void {
  const existing = ctx.inbox.find(item.id);
  const same =
    existing?.title === item.title &&
    existing.body === item.body &&
    (!item.at || existing.updatedAt === item.at);
  if (existing?.status === "open" && same) return;
  const now = item.at ?? ctx.now().toISOString();
  ctx.inbox.put({
    id: item.id,
    kind: item.kind,
    status: "open",
    priority: item.priority ?? "normal",
    notify: item.notify,
    title: item.title,
    body: item.body,
    projectId: item.projectId,
    sessionId: item.sessionId ?? null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: item.issue ?? null,
    pr: item.pr ?? null,
    automationRunId: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  });
}

/** Notice for the PM or the orchestrator about the loop. */
export function factoryNotice(
  ctx: FactoryContext,
  opts: {
    id: string;
    projectId: string;
    target: "pm" | "orchestrator";
    event:
      | "triage_needed"
      | "digest"
      | "paused"
      | "escalated"
      | "regression"
      | "merged"
      | "failed"
      | "ready"
      | "stopped";
    title: string;
    text: string;
    itemIds?: string[];
    wake?: boolean;
  },
): void {
  ctx.notify(
    {
      id: opts.id,
      type: "factory.update",
      projectId: opts.projectId,
      target: opts.target,
      sessionId: null,
      title: opts.title,
      data: { event: opts.event, text: opts.text, itemIds: opts.itemIds ?? [] },
    },
    opts.wake ?? true,
  );
}

/** Pause the loop (failures, regression, budget) with an inbox item for everything but budget. */
export function pauseLoop(
  ctx: FactoryContext,
  loop: FactoryLoop,
  reason: string,
  opts: { inbox: boolean; items?: FactoryItem[] } = { inbox: true },
): FactoryLoop {
  if (loop.state === "paused" && loop.pausedReason === reason) return loop;
  ctx.log?.(`factory: pausing ${loop.projectId}: ${reason}`);
  const next = { ...loop, state: "paused" as const, pausedReason: reason };
  if (opts.inbox) {
    raiseInbox(ctx, {
      id: `inbox:factory-paused:${loop.projectId}`,
      kind: "run_failed",
      notify: "failure",
      priority: "high",
      projectId: loop.projectId,
      title: "Factory loop paused",
      body: `${reason}. Resume it from the factory panel once you have looked.`,
    });
    factoryNotice(ctx, {
      id: `factory.paused:${loop.projectId}:${ctx.now().toISOString()}`,
      projectId: loop.projectId,
      target: "pm",
      event: "paused",
      title: "Factory loop paused",
      text: `${reason}. No new work starts until the user resumes the loop.`,
      itemIds: opts.items?.map((i) => i.id),
      wake: false,
    });
  }
  return next;
}

/**
 * Spend since `day` that counts against the project's daily factory budget: the factory's own
 * sessions (`budgetScope: "factory"`, the default) or the whole project (`"project"`).
 */
export function budgetSpend(
  ctx: Pick<FactoryContext, "usage" | "sessions">,
  projectId: string,
  day: string,
  limits: FactoryLimits,
): { usd: number; tokens: number } {
  if (limits.budgetScope === "project") return ctx.usage.spendSince(day, projectId);
  const ids = new Set(ctx.sessions.list(projectId).map((s) => s.id));
  return ctx.usage.spendSince(day, projectId, ids);
}
