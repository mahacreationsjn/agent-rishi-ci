import type { Session, Usage } from "@agent-rishi/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import { isBusy } from "./sessions";

/**
 * Compaction between scout rounds (§10.1). The scout and its area reviewers are long-lived
 * sessions, reused round after round so they keep what they learned. Without compaction each
 * round's brief sits on top of every earlier round's file reads and findings until the provider
 * compacts at its own limit, so every turn costs more and attends worse to the round at hand.
 * Before a reused session gets its round's brief, Agent Rishi compacts it when its context has grown
 * (`compactBeforeRound`) and the brief queues behind the compaction, in the same agent slot.
 */

/** Context, in tokens, from which a reused scout or area reviewer is compacted before a round. */
export const ROUND_COMPACT_TOKENS = 60_000;

/**
 * Whether a session whose provider last reported `usage` should be compacted before its next
 * round: its context is at least `ROUND_COMPACT_TOKENS`, or half its window when that is smaller.
 * Never when the provider reported no context size.
 */
export function compactBeforeRound(usage: Usage | null | undefined): boolean {
  const used = usage?.contextTokens;
  if (used === undefined) return false;
  const window = usage?.contextWindow;
  const threshold = window
    ? Math.min(ROUND_COMPACT_TOKENS, Math.floor(window / 2))
    : ROUND_COMPACT_TOKENS;
  return used >= threshold;
}

/**
 * Wake a reused scout or area reviewer with its round's brief, compacting its conversation first
 * when `compactBeforeRound` says so. A compaction that can't start (the provider can't compact on
 * demand, a turn running) or fails never holds the brief up: it is sent either way, after the
 * compaction when one runs. `who` names the session in the log.
 */
export async function wakeForRound(
  ctx: FactoryContext,
  session: Session,
  text: string,
  who: string,
): Promise<void> {
  const usage = ctx.repo.find(session.id)?.usage;
  if (!isBusy(session) && compactBeforeRound(usage)) {
    if (await ctx.sessions.compact(session.id)) {
      ctx.log?.(`factory: ${who}: compacting its context (${usage?.contextTokens} tokens) first`);
    }
  }
  await ctx.sessions.message(session.id, text);
}

/**
 * `wakeForRound` without waiting for it: waking may resume the session on the runner (recreating
 * its worktree first), which can take minutes under load. Failures are only logged.
 */
export function wakeForRoundInBackground(
  ctx: FactoryContext,
  session: Session,
  text: string,
  who: string,
): void {
  void wakeForRound(ctx, session, text, who).catch((error: unknown) =>
    ctx.log?.(`factory: waking ${who}: ${errorMessage(error)}`),
  );
}
