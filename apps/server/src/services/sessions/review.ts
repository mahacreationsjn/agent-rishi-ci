import { randomUUID } from "node:crypto";
import type {
  Project,
  ProviderInfo,
  ReviewSessionRequest,
  Session,
  UserInput,
} from "@agent-rishi/contracts";
import { badRequest, conflict, type ServiceError } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { type RunnerPort, toServiceError } from "../runner-port";
import { freezeChecks } from "./checks";
import type { ForkStart } from "./fork";
import { inheritedStarter } from "./origin";
import { readOnlyUnsupported } from "./permissions";
import type { SessionRepo, StoredStartMeta } from "./repo";
import { buildReviewBrief } from "./review-brief";
import { requireGitRepo } from "./start-workspace";

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);
const TITLE_MAX = 200;
const TITLE_PREFIX = "Review: ";
/** Writing a checkpoint stages the whole worktree; a big one can take a while. */
const SETTLE_TIMEOUT_MS = 120_000;

/**
 * A read-only session that reviews another one's changes, ready to be created and launched.
 * Its first message, the review brief from Agent Rishi, is `meta.handoffBrief`: the launcher sends
 * it with whichever start opens the session, as it does a handoff's.
 */
export interface ReviewPlan {
  session: Session;
  meta: StoredStartMeta;
  start: ForkStart;
}

export interface ReviewDeps {
  repo: SessionRepo;
  projects: ProjectService;
  /** The source's runner: it holds the source's checkpoints, and the review runs there. */
  runner: RunnerPort;
}

/**
 * Why `source`'s changes can't be reviewed right now, or null when they can (§9). A review
 * needs an agent session on a git branch that has had a turn, with no turn running or still to
 * start, and that isn't itself a review (a review changes nothing to review).
 */
export function reviewBlocker(source: Session, turns: number): ServiceError | null {
  if (source.role !== "agent") {
    return badRequest("Only agent sessions can be reviewed", "review_unsupported");
  }
  if (source.forkedFrom?.kind === "review") {
    return badRequest("A review session has no changes of its own to review", "review_unsupported");
  }
  if (source.status === "waiting") {
    return conflict(
      "Answer what the session is waiting on (an approval, a question or its plan) before reviewing it",
      "turn_running",
    );
  }
  if (BUSY.has(source.status)) {
    return conflict("Wait for the running turn to finish before reviewing", "turn_running");
  }
  if (NOT_STARTED.has(source.status)) {
    return conflict("The session hasn't started yet", "not_started");
  }
  if (!source.branch) {
    return badRequest(
      "Only sessions that work on a git branch can be reviewed",
      "review_unsupported",
    );
  }
  if (turns === 0) {
    return conflict("The session has no changes to review yet", "nothing_to_review");
  }
  return null;
}

/** `Review: <source title>`, kept within the title limit. */
export function reviewTitle(source: Session): string {
  const base = (source.title ?? source.purpose).trim();
  const room = TITLE_MAX - TITLE_PREFIX.length;
  return `${TITLE_PREFIX}${base.length <= room ? base : base.slice(0, room).trimEnd()}`;
}

/**
 * Review `sourceId`'s changes (§9): a new read-only session on `req.provider` with the source's
 * code, as a handoff has it, and a review brief as its first message.
 * 1. The source's latest checkpoint, once the runner has written the one for a turn that has
 *    just ended (`checkpoint.list` `settled`).
 * 2. The brief, from the source's transcript (no utility model: a review shouldn't wait on one,
 *    and the reviewer reads the change itself).
 * A turn that started meanwhile, even one that has already finished, would make the two
 * disagree, so that fails the review (409 `source_changed`) and nothing is created. The source
 * is only read. Throws `ServiceError`s.
 */
export async function planReview(
  deps: ReviewDeps,
  sourceId: string,
  req: ReviewSessionRequest,
): Promise<ReviewPlan> {
  const { repo, runner } = deps;
  const source = repo.get(sourceId);
  const turns = repo.turnCount(source.id);
  const blocker = reviewBlocker(source, turns);
  if (blocker) throw blocker;
  const project = reviewProject(deps.projects, source);
  const target = reviewerProvider(runner, req.provider);
  const { checkpoints } = await runner
    .request(
      { name: "checkpoint.list", cwd: project.path, sessionId: source.id, settled: true },
      SETTLE_TIMEOUT_MS,
    )
    .catch((error: unknown) => {
      throw toServiceError(error);
    });
  const checkpoint = checkpoints.at(-1)?.index ?? null;

  const now = repo.get(source.id);
  const late = reviewBlocker(now, repo.turnCount(source.id));
  if (late) throw late;
  if (repo.turnCount(source.id) !== turns) {
    throw conflict(
      "The session ran a turn while the review was being set up. Start the review again.",
      "source_changed",
    );
  }
  const baseBranch = now.baseBranch ?? project.defaultBranch ?? "main";
  const brief = buildReviewBrief({
    session: now,
    providerName: providerName(runner, now.provider),
    baseBranch,
    restored: checkpoint !== null,
    requests: repo
      .rootItems(now, ["user_message"])
      .flatMap((i) => (i.kind === "user_message" ? [i] : [])),
    lastReply: lastReply(repo, now),
    edits: repo.fileEdits(now.id),
    focus: req.focus,
  });
  return reviewPlan(now, project, target, checkpoint, brief, req);
}

/**
 * The review session: the source's project, purpose, scope and issue, started by the user on
 * `target` with read-only permissions and no plan mode, with the model and effort asked for
 * (else the source's on the same provider, else the provider's defaults). `forkedFrom` (kind
 * `review`) links it to the source and records who started the source's work when it wasn't
 * the user (`inheritedStarter`), so the review is trusted no more than its source. Its worktree
 * is made like a handoff's: a new branch from the source's branch with `checkpoint` restored,
 * the plan kept with its start metadata until the worktree exists. No §8.4 conflict check: it
 * is a deliberate, visible second opinion.
 */
export function reviewPlan(
  source: Session,
  project: Project,
  target: ProviderInfo,
  checkpoint: number | null,
  brief: string,
  req: ReviewSessionRequest,
): ReviewPlan {
  const same = target.id === source.provider;
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    projectId: project.id,
    role: "agent",
    parentSessionId: null,
    startedBy: { kind: "user" },
    purpose: source.purpose,
    workKey: `review:${source.id}`,
    scope: source.scope,
    progress: null,
    title: req.title ?? reviewTitle(source),
    provider: target.id,
    model: req.model ?? (same ? source.model : null),
    effort: req.effort ?? (same ? source.effort : null),
    // A reviewer reads and runs checks; it never edits, commits or pushes (§11.2).
    autonomy: "read_only",
    planMode: false,
    // A reviewer runs checks itself; it has nothing to fix, so the loop stays off.
    checks: freezeChecks(project.path, "agent", { untilPass: false }),
    status: "starting",
    cwd: project.path,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    issue: source.issue,
    pr: null,
    resumeToken: null,
    // The source's checkpoint lives on its runner: the review runs there.
    runnerId: source.runnerId,
    automationRunId: null,
    rootThreadId: null,
    forkedFrom: { sessionId: source.id, checkpoint, kind: "review", ...inheritedStarter(source) },
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };
  const start: ForkStart = {
    workspace: { mode: "worktree", baseRef: source.branch ?? undefined, fetch: false },
    fork: {
      baseBranch: source.baseBranch ?? project.defaultBranch ?? null,
      ...(checkpoint === null
        ? {}
        : { restoreCheckpoint: { sessionId: source.id, index: checkpoint } }),
    },
  };
  const input: UserInput = { text: brief, attachments: [], from: "agent-rishi" };
  return {
    session,
    start,
    meta: {
      workspaceMode: "worktree",
      workspaceFallback: null,
      forced: null,
      queuedBehind: [],
      forkStart: start,
      // Kept until a start delivers it, so a first start that fails doesn't lose it.
      handoffBrief: input,
    },
  };
}

/** The source's project, unless it is archived. */
function reviewProject(projects: ProjectService, source: Session): Project {
  if (!source.projectId) {
    throw badRequest("Only agent sessions can be reviewed", "review_unsupported");
  }
  const project = projects.get(source.projectId);
  if (project.archivedAt) throw badRequest("The project is archived", "project_archived");
  requireGitRepo(project);
  return project;
}

/**
 * The provider that reviews, as the source's runner loads it, once it can enforce read-only
 * permissions natively (`capabilities.readOnly`, §11.2): a reviewer must not change the code.
 */
function reviewerProvider(runner: RunnerPort, id: string): ProviderInfo {
  const target = runner.providers().find((p) => p.id === id);
  if (!target) throw badRequest(`Provider ${id} is not available`, "unknown_provider");
  const readOnly = readOnlyUnsupported("agent", "read_only", target);
  if (readOnly) {
    throw badRequest(`${readOnly}, so it can't review`, "read_only_unsupported");
  }
  return target;
}

function providerName(runner: RunnerPort, id: string): string {
  return runner.providers().find((p) => p.id === id)?.displayName ?? id;
}

function lastReply(repo: SessionRepo, session: Session): string | null {
  const replies = repo.rootItems(session, ["assistant_message"], 5);
  for (const item of replies.reverse()) {
    if (item.kind === "assistant_message" && item.text.trim()) return item.text;
  }
  return null;
}
