import type { Session } from "@agent-rishi/contracts";
import { runnerErrorCode } from "../runner-port";
import { isTransientRunnerError } from "./outbox-holds";
import type { SessionRepo } from "./repo";

/**
 * Starts the runner left unanswered (§10.1, issue #492). Under load, `session.start` (or the
 * workspace prepared before it) can time out on the runner, or the runner's connection can drop
 * while the start is on its way. That says nothing about the provider, and the session may
 * still have started: a busy runner can open it after the server stopped waiting, and its events
 * then bring the failed session back. The launcher records such a failure with the session's
 * start metadata (`StoredStartMeta.startUnanswered`), so the factory can tell it from a provider
 * that refused or failed the session.
 */

/** A start the runner didn't answer: how (`timeout`, `runner_unavailable`) and when. */
export interface UnansweredStart {
  code: string;
  at: string;
}

/** How the runner left a start unanswered, or null when it answered (a refusal included). */
export function unansweredCode(error: unknown): string | null {
  return isTransientRunnerError(error) ? (runnerErrorCode(error) ?? null) : null;
}

/**
 * Record that the session's start went unanswered, or (with null) that a start or resume of it
 * was answered, after which the earlier one no longer says anything.
 */
export function setUnanswered(
  repo: Pick<SessionRepo, "find" | "setStartMeta">,
  sessionId: string,
  value: UnansweredStart | null,
): void {
  const meta = repo.find(sessionId)?.startMeta;
  // Every session gets its start metadata when it is created.
  if (!meta || (!value && !meta.startUnanswered)) return;
  repo.setStartMeta(sessionId, () => ({ ...meta, startUnanswered: value }));
}

/** Whether the session's last start went unanswered by its runner (whatever happened since). */
export function startWentUnanswered(repo: Pick<SessionRepo, "find">, sessionId: string): boolean {
  return Boolean(repo.find(sessionId)?.startMeta?.startUnanswered);
}

/**
 * When the runner left this session's start unanswered, if that is all that is known to be
 * wrong with it: the session failed, its provider never refused to open it (`startError`) and
 * no turn of it has run. Null otherwise, such as once its events brought it back.
 */
export function unansweredStartAt(
  repo: Pick<SessionRepo, "find" | "rootTurnIds">,
  s: Session,
): string | null {
  if (s.status !== "failed" || s.startError) return null;
  const at = repo.find(s.id)?.startMeta?.startUnanswered?.at;
  if (!at || repo.rootTurnIds(s).length > 0) return null;
  return at;
}
