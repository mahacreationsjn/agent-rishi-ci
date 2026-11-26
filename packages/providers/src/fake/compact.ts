import type { ErrorInfo } from "@agent-rishi/contracts";
import type { FakeTurn } from "./plan";

/** The context the Fake provider reports after a compaction: about a summary's worth. */
export const FAKE_COMPACTED_CONTEXT_TOKENS = 2_000;

/**
 * How a scripted compaction fails: `[compact:fail:usage]` (a usage limit that resets a second
 * later) or `[compact:fail:exit]` (the provider process exits) in a message makes the session's
 * next compaction fail so.
 */
export type FakeCompactFailure = "usage" | "exit";

/** The `[compact:fail:…]` marker in a prompt, if any. */
export function compactFailureIn(prompt: string): FakeCompactFailure | undefined {
  if (prompt.includes("[compact:fail:usage]")) return "usage";
  if (prompt.includes("[compact:fail:exit]")) return "exit";
  return undefined;
}

function compactError(failure: FakeCompactFailure): ErrorInfo {
  return failure === "usage"
    ? {
        code: "usage_limit",
        message: "Scripted usage limit",
        retryable: true,
        kind: "usage_limit",
        retryAt: new Date(Date.now() + 1000).toISOString(),
      }
    : { code: "provider_exited", message: "Fake provider exited", kind: "transient" };
}

/**
 * "Compact now" in the Fake provider (`ProviderSession.compact`): a turn of its own with the
 * compaction notice ("Compacting…", replaced by "Context compacted") and the smaller context
 * that follows. No user message. Interrupted (`signal`), it ends as interrupted; with `failure`,
 * it fails after the notice.
 */
export async function runCompaction(
  turn: FakeTurn,
  signal: AbortSignal,
  failure?: FakeCompactFailure,
): Promise<void> {
  const { threadId, turnId } = turn;
  const forkPoint = turnId;
  const noticeId = turn.nextId("item");
  try {
    turn.emit({ type: "turn.started", threadId, turnId });
    turn.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        id: noticeId,
        kind: "notice",
        status: "completed",
        level: "info",
        code: "compacting",
        message: "Compacting the conversation to free up context…",
      },
    });
    await turn.step();
    if (failure) {
      turn.emit({ type: "turn.failed", threadId, turnId, forkPoint, error: compactError(failure) });
      return;
    }
    turn.emit({
      type: "item.completed",
      threadId,
      turnId,
      item: {
        id: noticeId,
        kind: "notice",
        status: "completed",
        level: "info",
        code: "context_compacted",
        message: "Context compacted",
      },
    });
    turn.emit({
      type: "usage.updated",
      threadId,
      turnId,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0,
        contextTokens: FAKE_COMPACTED_CONTEXT_TOKENS,
      },
    });
    turn.emit({ type: "turn.completed", threadId, turnId, forkPoint, stopReason: "end_turn" });
  } catch (error) {
    if (signal.aborted) {
      turn.emit({ type: "turn.interrupted", threadId, turnId, forkPoint, reason: "user" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    turn.emit({ type: "turn.failed", threadId, turnId, forkPoint, error: { message } });
  }
}
