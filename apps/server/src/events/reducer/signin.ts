import {
  type ErrorInfo,
  type InboxItem,
  inboxAttempts,
  type Session,
} from "@agent-rishi/contracts";
import { isFactorySession } from "../../services/factory/starter";
import { providerLoginCommand } from "../../services/setup/tool-lookup";
import type { Draft } from "./draft";
import { closeInbox } from "./items";

/**
 * A provider's sign-in item (§10.1, Provider availability). A factory session that fails because
 * its provider's login needs the user (error kind `auth`: a turn refused with a 401, an open
 * refused as signed out) raises no `run_failed` item: the factory starts the work again on
 * another provider and keeps new work off this one until its login changes, so the user gets
 * one item per provider ("OpenCode isn't signed in (openai/gpt-5.5): run `opencode auth
 * login`"). A later failure updates it (one more attempt, the latest error); one after it closed
 * opens it again. It closes by itself when a factory session on the provider completes a turn.
 */

/** Names for the item's text (the runner's provider list isn't known to the reducer). */
const NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  antigravity: "Antigravity CLI",
};

/** The id of a provider's sign-in item: one per provider. */
export function signinInboxId(provider: string): string {
  return `inbox:provider-signin:${provider}`;
}

/** Whether `error` is a factory session's sign-in failure, which raises the provider's item. */
export function isFactorySigninFailure(session: Session, error: ErrorInfo | undefined): boolean {
  return error?.kind === "auth" && isFactorySession(session);
}

/** The item's title and body for a sign-in failure of `session`. */
function signinText(session: Session, message: string): Pick<InboxItem, "title" | "body"> {
  const name = NAMES[session.provider] ?? session.provider;
  const command = providerLoginCommand(session.provider);
  const model = session.model ? ` (${session.model})` : "";
  return {
    title: `${name} isn't signed in${model}${command ? `: run \`${command}\`` : ""}`,
    body: [
      `A factory session on ${name} failed to sign in: ${message}.`,
      `New factory work skips ${name} until its login changes; after signing in, press Check now on the factory panel to use it again at once.`,
    ].join(" "),
  };
}

/** A factory session failed to sign in: raise or update its provider's sign-in item. */
export function signinFailed(d: Draft, session: Session, message: string, ts: string): void {
  const existing = d.getInbox(signinInboxId(session.provider));
  const text = signinText(session, message.replace(/\.$/, ""));
  if (existing?.status === "open") {
    d.putInbox({ ...existing, ...text, attempts: inboxAttempts(existing) + 1, updatedAt: ts });
    return;
  }
  d.putInbox({
    id: signinInboxId(session.provider),
    kind: "message",
    status: "open",
    priority: "normal",
    // Only the user can sign in again.
    notify: "needs_you",
    ...text,
    projectId: session.projectId,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    // One that closed opens again and counts on.
    attempts: existing ? inboxAttempts(existing) + 1 : 1,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
    resolvedAt: null,
    resolution: null,
  });
}

/** A factory session on the provider completed a turn: its sign-in item, if open, closes. */
export function signinWorks(d: Draft, session: Session, ts: string): void {
  if (!isFactorySession(session)) return;
  const open = d.getInbox(signinInboxId(session.provider));
  if (open?.status !== "open") return;
  const name = NAMES[session.provider] ?? session.provider;
  d.putInbox(closeInbox(open, "resolved", { by: "agent-rishi", note: `${name} works again` }, ts));
}
