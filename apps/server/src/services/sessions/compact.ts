import type { ProviderInfo, Session, Turn } from "@agent-rishi/contracts";
import { conflict, type ServiceError } from "../errors";
import { type RunnerPort, runnerErrorCode, toServiceError } from "../runner-port";
import type { SessionLauncher } from "./launcher";
import { isTurnRunningError } from "./outbox-holds";
import type { SessionRepo } from "./repo";

/**
 * "Compact now" (`POST /api/sessions/:id/compact`): the provider summarizes the conversation to
 * free up context, as a turn of its own (`ProviderCapabilities.compact`), marked `kind: "compact"`.
 * Its progress arrives as ordinary turn and notice events, and messages sent meanwhile queue
 * behind it, also those meant to steer it (a compaction can't be steered).
 */

const BUSY = new Set(["running", "waiting"]);
const NOT_STARTED = new Set(["created", "queued", "starting"]);

/** What else is under way for the session: a turn on its way, messages waiting, checks. */
export interface CompactBusy {
  /** A turn (or another compaction) is on its way to the runner. */
  delivering: boolean;
  /** Messages waiting in the session's queue. */
  queued: number;
  /**
   * The project's checks are running after the last turn (§9). A compaction would end their run
   * and lose what they report, and its own turn must not start another round (#412).
   */
  checking?: boolean;
}

/**
 * Why the session can't compact now, as the error to answer with, or null when it can. The
 * provider is the one the session's runner loaded; unknown (runner away) counts as unable.
 */
export function compactRefusal(
  session: Session,
  provider: ProviderInfo | undefined,
  busy: CompactBusy,
): ServiceError | null {
  if (session.archivedAt) {
    return conflict("Archived sessions can't be compacted. Unarchive it first.", "archived");
  }
  if (NOT_STARTED.has(session.status) || !session.resumeToken) {
    return conflict("The session has no conversation to compact yet.", "not_started");
  }
  if (!provider?.capabilities.compact) {
    const name = provider?.displayName ?? session.provider;
    return conflict(`${name} can't compact a conversation on demand.`, "unsupported");
  }
  if (BUSY.has(session.status) || busy.delivering) {
    return conflict("A turn is running: compact once it ends.", "turn_running");
  }
  if (busy.checking) {
    return conflict(
      "The project's checks are running: compact once they finish.",
      "checks_running",
    );
  }
  if (busy.queued > 0) {
    return conflict("Messages are waiting to be sent: compact once they have run.", "turn_running");
  }
  return null;
}

/** The session's latest root turn, when it is a compaction (whatever came of it). */
export function lastCompaction(
  repo: Pick<SessionRepo, "rootTurnIds" | "turn">,
  session: Session,
): Turn | null {
  const last = repo.rootTurnIds(session).at(-1);
  const turn = last ? repo.turn(session.id, last) : null;
  return turn?.kind === "compact" ? turn : null;
}

/** Whether the session's latest root turn is a compaction that is still running. */
export function compactionRunning(
  repo: Pick<SessionRepo, "rootTurnIds" | "turn">,
  session: Session,
): boolean {
  return lastCompaction(repo, session)?.status === "running";
}

/** The answer to a steer that arrives during a compaction (the runner says the same). */
export function compactingRefusal(): ServiceError {
  return conflict(
    "The conversation is being compacted, so there is no turn to steer. Send the message instead: it waits in the queue and goes once the compaction ends.",
    "compacting",
  );
}

export interface CompactContext {
  repo: SessionRepo;
  launcher: Pick<SessionLauncher, "resume">;
  /** The runner hosting the session now (a resume may move it). */
  runnerOf: (sessionId: string) => RunnerPort;
}

/**
 * Ask the session's runner to compact it, resuming the session through its provider first when
 * the runner no longer hosts it (a runner restart, a stopped session). The session counts as
 * running from now on; if the compaction can't start, it goes back to how it was.
 */
export async function startCompaction(ctx: CompactContext, session: Session): Promise<void> {
  const previous = session.status;
  const request = () =>
    ctx.runnerOf(session.id).request({ name: "session.compact", sessionId: session.id });
  ctx.repo.update(session.id, (s) => ({ ...s, status: "running", endedAt: null }));
  try {
    try {
      await request();
    } catch (error) {
      if (runnerErrorCode(error) !== "unknown_session") throw error;
      await ctx.launcher.resume(ctx.repo.get(session.id));
      await request();
    }
  } catch (error) {
    // Refused because the provider runs a turn: the session is running, so it stays so.
    if (!isTurnRunningError(error)) {
      ctx.repo.update(session.id, (s) => (s.status === "running" ? { ...s, status: previous } : s));
    }
    throw toServiceError(error);
  }
}
