import {
  AutonomyLevel,
  type ProviderInfo,
  type Session,
  type SessionStatus,
} from "@agent-rishi/contracts";

/** Statuses a session doesn't leave by itself: it has finished, failed or was stopped. */
const ENDED: readonly SessionStatus[] = ["completed", "failed", "stopped"];

/**
 * The project's open agent sessions whose permission level differs from `level`, the one its new
 * sessions start with (§11.2). A session's level is its own from the moment it is created:
 * changing the project's default (or the one in Settings) never reaches a session that exists,
 * so the project's settings name the ones that keep another level. Archived and ended sessions
 * are left out, as are the PM's (read-only by role).
 */
export function sessionsKeepingLevel(
  sessions: readonly Session[],
  projectId: string,
  level: AutonomyLevel,
): Session[] {
  return sessions.filter(
    (s) =>
      s.projectId === projectId &&
      s.role === "agent" &&
      !s.archivedAt &&
      !ENDED.includes(s.status) &&
      s.autonomy !== level,
  );
}

/** Whether `to` lets an agent do more without asking than `from` (Read-only < … < Full). */
export function raisesLevel(from: AutonomyLevel, to: AutonomyLevel): boolean {
  return AutonomyLevel.options.indexOf(to) > AutonomyLevel.options.indexOf(from);
}

/**
 * When a session takes a new level: from the agent's next tool call where its provider reports
 * `liveAutonomy` (a running turn too), else from its next turn (a running turn keeps its level).
 */
export type AppliesFrom = "next_tool_call" | "next_turn";

/** One open session moved to the project's level by "Apply to open sessions" (#622). */
export interface LevelChange {
  session: Session;
  from: AutonomyLevel;
  to: AutonomyLevel;
  /** The new level asks less than the session's: needs the user's confirmation first. */
  raises: boolean;
  appliesFrom: AppliesFrom;
}

/**
 * What applying `level` to the sessions that keep another level (`sessionsKeepingLevel`) changes,
 * one entry per session. Only agent sessions are ever changed: the orchestrator and PMs are
 * read-only by role. When it applies comes from the provider's capabilities as loaded now; an
 * unknown provider (the runner isn't connected) is taken to apply from the next turn.
 */
export function planLevelChanges(
  keeping: readonly Session[],
  level: AutonomyLevel,
  providers: readonly ProviderInfo[],
): LevelChange[] {
  return keeping
    .filter((s) => s.role === "agent" && s.autonomy !== level)
    .map((session) => {
      const live = providers.find((p) => p.id === session.provider)?.capabilities.liveAutonomy;
      return {
        session,
        from: session.autonomy,
        to: level,
        raises: raisesLevel(session.autonomy, level),
        appliesFrom: live ? "next_tool_call" : "next_turn",
      };
    });
}

const sessions = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/**
 * The line that says when the applied level takes effect, read from each session's
 * `appliesFrom`, and that requests already waiting for an answer stay waiting (§11.2).
 */
export function appliedNote(applied: readonly LevelChange[]): string {
  const live = applied.filter((c) => c.appliesFrom === "next_tool_call").length;
  const later = applied.length - live;
  const one = applied.length === 1;
  const when =
    later === 0
      ? `It applies from ${one ? "the agent's" : "each agent's"} next tool call.`
      : live === 0
        ? `It applies from ${one ? "the session's" : "each session's"} next turn.`
        : `It applies from the next tool call in ${sessions(live)} and from the next turn in ${sessions(later)}.`;
  const waiting = applied.some((c) => c.session.status === "waiting")
    ? " Approvals and questions already waiting for you stay waiting."
    : "";
  return `${when}${waiting}`;
}
