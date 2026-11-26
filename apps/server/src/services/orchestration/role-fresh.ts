import type { InboxItem, Session } from "@agent-rishi/contracts";
import { conflict, type ServiceError } from "../errors";

const STARTING = new Set<Session["status"]>(["created", "queued", "starting"]);

/** The open inbox items that wait on the person's answer to the session. */
export const isOpenRequest = (item: InboxItem) =>
  item.status === "open" && (item.kind === "question" || item.kind === "approval");

/**
 * Why a role session can't be started fresh right now ("Start fresh", §8.1), or null when it
 * can. Archiving it would cut off a turn that is starting, running or on its way to the runner,
 * or drop a question or approval the person hasn't answered: in the session, or in the inbox
 * (a question whose `ask_user` call returned while it waits). A failed session can be started
 * fresh: that is the way out of a provider that keeps failing.
 */
export function freshRefusal(
  session: Session,
  state: { delivering: boolean; openRequests: number },
): ServiceError | null {
  const name = session.role === "pm" ? "PM" : "orchestrator";
  if (STARTING.has(session.status)) {
    return conflict(`The ${name} is still starting. Try again once it's ready.`, "turn_running");
  }
  if (session.status === "waiting" || state.openRequests > 0) {
    return conflict(
      `The ${name} is waiting for your answer to a question or approval. Answer it first, then start fresh.`,
      "request_open",
    );
  }
  if (session.status === "running" || state.delivering) {
    return conflict(
      `The ${name} is in the middle of a turn. Wait for it to finish or stop it, then start fresh.`,
      "turn_running",
    );
  }
  return null;
}
