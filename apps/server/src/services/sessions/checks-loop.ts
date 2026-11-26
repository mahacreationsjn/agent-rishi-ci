import {
  type AgentEventOf,
  agentEventToNewEvent,
  CHECK_RUN_NOTICE,
  type CheckResult,
  CheckRunData,
  type CheckRunOutcome,
  checkRunItemId,
  checkTimeoutMs,
  type Item,
  type Project,
  type RawEventEnvelope,
  type Session,
  type UserInput,
} from "@agent-rishi/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import type { RunnerPort } from "../runner-port";
import { cardMessage, checksMessage, failingChecks, loopSkipReason } from "./checks";
import type { SessionRepo } from "./repo";

/** Added to a check's own timeout before Agent Rishi stops waiting for the runner's answer. */
const RUNNER_MARGIN_MS = 60_000;

export interface ChecksLoopDeps {
  db: Db;
  store: EventStore;
  repo: SessionRepo;
  /** The session's project, for its agent environment setting (`agentCiEnv`). */
  project: (projectId: string) => Project | undefined;
  /** The runner that hosts the session. */
  runnerOf: (sessionId: string) => RunnerPort;
  /** Send Agent Rishi's message to an idle session, starting a turn. */
  send: (sessionId: string, input: UserInput) => Promise<unknown>;
  /** A message waits for the session or is on its way to it: it takes over from the loop. */
  hasPendingMessage: (sessionId: string) => boolean;
  log?: (message: string) => void;
}

/** A check run in progress: the turn its card belongs to, and how it ended once it has. */
interface ActiveRun {
  threadId: string;
  turnId: string;
  data: CheckRunData;
  outcome?: CheckRunOutcome;
}

/**
 * "Keep going until checks pass" (§9 Project checks). After a root turn of an agent session
 * completes (not a compaction), when the session keeps going until checks pass, this runs the
 * session's frozen checks one by one on its runner, in its working directory, and shows them as
 * a card in that turn. When some fail and rounds are left, it sends them to the agent in a `agent-rishi` message,
 * which starts the next round; when all pass, or the rounds run out, the session stays idle.
 * The round count is the session's (`SessionChecks.round`, kept by `SessionService` as messages
 * go out), so turns Agent Rishi starts itself never add rounds. Stop, a new message, stopping or
 * archiving the session end a run (`cancel`). Runs live in memory: after a restart, cards left
 * running are marked interrupted, and their checks are cancelled on the runner once it's ready.
 */
export class ChecksLoop {
  private readonly runs = new Map<string, ActiveRun>();
  /** Sessions whose check a restart may have left running on their runner (`settleLeftovers`). */
  private readonly leftovers = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly deps: ChecksLoopDeps) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    this.settleLeftovers();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    for (const id of [...this.runs.keys()]) void this.cancel(id, "interrupted");
  }

  /** Whether checks are running for the session now. */
  isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  /**
   * End the session's check run, if one is running: kill the running check on the runner and
   * mark the card with `outcome`. Nothing is sent to the agent. False when none was running.
   */
  async cancel(
    sessionId: string,
    outcome: Extract<CheckRunOutcome, "stopped" | "superseded" | "interrupted">,
  ): Promise<boolean> {
    const run = this.runs.get(sessionId);
    if (!run) return false;
    this.end(sessionId, run, outcome);
    try {
      await this.deps.runnerOf(sessionId).request({ name: "check.cancel", sessionId }, 15_000);
    } catch (error) {
      this.deps.log?.(`checks for ${sessionId}: cancel: ${errorMessage(error)}`);
    }
    return true;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.sessionId) continue;
      const sessionId = e.sessionId;
      if (e.type === "agent.turn.completed") {
        const event = e.payload as AgentEventOf<"turn.completed">;
        // After the store notification and the queue's own flush (`SessionLifecycle`).
        setImmediate(() => void this.afterTurn(sessionId, event));
      } else if (e.type === "session.updated" && this.runs.has(sessionId)) {
        const { session } = e.payload as { session: Session };
        if (session.archivedAt || !["idle", "running"].includes(session.status)) {
          void this.cancel(sessionId, "interrupted");
        }
      }
    }
  }

  /**
   * Run the checks after a completed turn, when the session keeps going until they pass. The
   * round is the session's count (`SessionChecks.round`), whatever started the turn; once the
   * loop stopped at its cap, no turn runs them again until the count starts again (#412).
   */
  private async afterTurn(sessionId: string, event: AgentEventOf<"turn.completed">): Promise<void> {
    if (this.stopped || this.runs.has(sessionId)) return;
    const session = this.deps.repo.find(sessionId)?.session;
    const checks = session?.checks;
    if (!session || !checks || session.rootThreadId !== event.threadId) return;
    // A compaction changes no files and finishes no work: nothing to check, no round to start.
    if (this.deps.repo.turn(sessionId, event.turnId)?.kind === "compact") return;
    if (loopSkipReason(session) || this.deps.hasPendingMessage(sessionId)) return;
    if (checks.capReached) return;
    const run: ActiveRun = {
      threadId: event.threadId,
      turnId: event.turnId,
      data: {
        round: checks.round ?? 0,
        maxRounds: checks.maxRounds,
        checks: checks.commands.map((c) => ({
          command: c.command,
          status: "pending",
          exitCode: null,
        })),
      },
    };
    this.runs.set(sessionId, run);
    this.card(sessionId, run);
    try {
      await this.runChecks(session, run);
    } catch (error) {
      this.deps.log?.(`checks for ${sessionId}: ${errorMessage(error)}`);
      if (!run.outcome) this.end(sessionId, run, "interrupted");
    }
  }

  private async runChecks(session: Session, run: ActiveRun): Promise<void> {
    const sessionId = session.id;
    const commands = session.checks?.commands ?? [];
    const project = session.projectId ? this.deps.project(session.projectId) : undefined;
    for (const [index, check] of commands.entries()) {
      if (run.outcome) return;
      this.setCheck(sessionId, run, index, { status: "running" });
      const timeoutMs = checkTimeoutMs(check);
      let result: CheckResult;
      try {
        const r = await this.deps.runnerOf(sessionId).request(
          {
            name: "check.run",
            sessionId,
            cwd: session.cwd,
            command: check.command,
            timeoutMs,
            ...(project?.agentCiEnv === false ? { ciEnv: false } : {}),
          },
          timeoutMs + RUNNER_MARGIN_MS,
        );
        result = {
          command: check.command,
          status: r.cancelled
            ? "cancelled"
            : r.timedOut
              ? "timed_out"
              : r.exitCode === 0
                ? "passed"
                : "failed",
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          ...(r.output ? { output: r.output } : {}),
          ...(r.truncated ? { truncated: true } : {}),
        };
      } catch (error) {
        if (run.outcome) return;
        // The runner went away or the folder is gone: the run can't finish.
        this.setCheck(sessionId, run, index, { status: "cancelled", output: errorMessage(error) });
        this.end(sessionId, run, "interrupted");
        return;
      }
      if (run.outcome) return;
      run.data.checks[index] = result;
      this.card(sessionId, run);
    }
    await this.finish(sessionId, run);
  }

  /** Every check has run: pass, send the failures back for another round, or stop at the cap. */
  private async finish(sessionId: string, run: ActiveRun): Promise<void> {
    if (failingChecks(run.data).length === 0) return this.end(sessionId, run, "passed");
    const session = this.deps.repo.find(sessionId)?.session;
    // Switched off, or another message got there first while the last check ran.
    if (!session || loopSkipReason(session) || this.deps.hasPendingMessage(sessionId)) {
      return this.end(sessionId, run, "stopped");
    }
    const maxRounds = session.checks?.maxRounds ?? run.data.maxRounds;
    run.data.maxRounds = maxRounds;
    if (run.data.round >= maxRounds) {
      // For good: no turn Agent Rishi starts itself runs the checks again (#412).
      this.deps.repo.update(sessionId, (s) =>
        s.checks ? { ...s, checks: { ...s.checks, capReached: true } } : s,
      );
      return this.end(sessionId, run, "cap_reached");
    }
    const round = run.data.round + 1;
    const text = checksMessage(run.data, round);
    this.end(sessionId, run, "continuing");
    try {
      await this.deps.send(sessionId, {
        text,
        attachments: [],
        from: "agent-rishi",
        checksRound: round,
      });
    } catch (error) {
      this.deps.log?.(`checks for ${sessionId}: send: ${errorMessage(error)}`);
    }
  }

  private setCheck(
    sessionId: string,
    run: ActiveRun,
    index: number,
    change: Partial<CheckResult>,
  ): void {
    const current = run.data.checks[index];
    if (!current) return;
    run.data.checks[index] = { ...current, ...change };
    this.card(sessionId, run);
  }

  /** Close the run with `outcome`: checks still pending or running count as cancelled. */
  private end(sessionId: string, run: ActiveRun, outcome: CheckRunOutcome): void {
    if (run.outcome) return;
    run.outcome = outcome;
    if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
    run.data.checks = run.data.checks.map((c) =>
      c.status === "pending" || c.status === "running"
        ? { ...c, status: "cancelled", exitCode: null }
        : c,
    );
    this.card(sessionId, run);
  }

  /** Write the run's card into the turn it follows: running, or ended with its outcome. */
  private card(sessionId: string, run: ActiveRun): void {
    if (this.stopped && !run.outcome) return;
    const data: CheckRunData = {
      ...run.data,
      checks: run.data.checks.map((c) => ({ ...c })),
      ...(run.outcome ? { outcome: run.outcome } : {}),
    };
    const item: Item = {
      id: checkRunItemId(run.turnId),
      kind: "notice",
      status: run.outcome ? "completed" : "in_progress",
      level: run.outcome && run.outcome !== "passed" ? "warning" : "info",
      code: CHECK_RUN_NOTICE,
      message: cardMessage(data, run.outcome),
      data,
    };
    try {
      this.deps.store.append([
        agentEventToNewEvent(sessionId, {
          type: run.outcome ? "item.completed" : "item.updated",
          threadId: run.threadId,
          turnId: run.turnId,
          item,
        }),
      ]);
    } catch (error) {
      this.deps.log?.(`checks for ${sessionId}: card: ${errorMessage(error)}`);
    }
  }

  /**
   * Cards a restart left running are marked interrupted. The runner outlives the server, so a
   * check may still run there, holding the session's check slot: it is cancelled once the
   * runner is connected again.
   */
  private settleLeftovers(): void {
    const rows = this.deps.db
      .select()
      .from(items)
      .where(and(eq(items.kind, "notice"), eq(items.status, "in_progress")))
      .all()
      .filter((r) => r.data.kind === "notice" && r.data.code === CHECK_RUN_NOTICE);
    const sessions = new Set<string>();
    for (const row of rows) {
      const item = row.data;
      const parsed = item.kind === "notice" ? CheckRunData.safeParse(item.data) : undefined;
      if (!parsed?.success) continue;
      const run: ActiveRun = { threadId: row.threadId, turnId: row.turnId, data: parsed.data };
      this.end(row.sessionId, run, "interrupted");
      sessions.add(row.sessionId);
    }
    for (const sessionId of sessions) this.leftovers.add(sessionId);
    this.onRunnerReady();
  }

  /** A runner is connected and ready: cancel there the checks a restart left running. */
  onRunnerReady(): void {
    for (const sessionId of [...this.leftovers]) void this.cancelLeftover(sessionId);
  }

  private async cancelLeftover(sessionId: string): Promise<void> {
    // A run started since is this server's own: it is never cancelled here.
    if (this.stopped || this.runs.has(sessionId)) {
      this.leftovers.delete(sessionId);
      return;
    }
    try {
      await this.deps.runnerOf(sessionId).request({ name: "check.cancel", sessionId }, 15_000);
      this.leftovers.delete(sessionId);
    } catch (error) {
      // Not connected yet: tried again when a runner is ready.
      this.deps.log?.(`checks for ${sessionId}: cancel after restart: ${errorMessage(error)}`);
    }
  }
}
