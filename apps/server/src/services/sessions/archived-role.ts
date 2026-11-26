import type { Session } from "@agent-rishi/contracts";
import { conflict, type ServiceError } from "../errors";

/**
 * An archived orchestrator or PM session (§8.1): one the person started fresh, or one retired
 * when its role moved to another provider. A newer session holds the role, so the archived one
 * is read-only: bringing it back would make a second live PM or orchestrator.
 */
export function isArchivedRoleSession(session: Pick<Session, "role" | "archivedAt">): boolean {
  return session.role !== "agent" && Boolean(session.archivedAt);
}

/** The refusal for a message, wake or unarchive of an archived role session. */
export function archivedRoleRefusal(session: Pick<Session, "role">): ServiceError {
  const name = session.role === "pm" ? "project manager" : "orchestrator";
  return conflict(
    `This ${name} conversation is archived and read-only. Write to the ${name}'s current conversation instead.`,
    "role_session_archived",
  );
}
