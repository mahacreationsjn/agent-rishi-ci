import { Script, uid } from "./live";
import type { MockWorld } from "./world";

/** The context the mock reports after a compaction. */
const COMPACTED_CONTEXT_TOKENS = 18_400;
/** The mock's context window, for the Context window meter. */
const CONTEXT_WINDOW = 200_000;

/**
 * "Compact now" in the mock: a turn of its own with the compaction notice ("Compacting…",
 * replaced by "Context compacted") and the smaller context that follows. No user message.
 */
export function scriptedCompaction(world: MockWorld, sessionId: string, onDone: () => void) {
  const threadId = world.transcript(sessionId).rootThreadId ?? `t-${sessionId}`;
  const ids = { threadId, turnId: uid("turn") };
  const noticeId = uid("n");
  const notice = (code: string, message: string) =>
    world.emitAgent(sessionId, {
      type: "item.completed",
      ...ids,
      item: { id: noticeId, kind: "notice", status: "completed", level: "info", code, message },
    });
  return new Script(
    [
      {
        wait: 0,
        run: () => {
          world.updateSession(sessionId, { status: "running" });
          world.emitAgent(sessionId, { type: "turn.started", ...ids, kind: "compact" });
          notice("compacting", "Compacting the conversation to free up context…");
        },
      },
      {
        wait: 1800,
        run: () => {
          notice("context_compacted", "Context compacted");
          world.emitAgent(sessionId, {
            type: "usage.updated",
            ...ids,
            usage: { contextTokens: COMPACTED_CONTEXT_TOKENS, contextWindow: CONTEXT_WINDOW },
          });
          world.emitAgent(sessionId, {
            type: "turn.completed",
            ...ids,
            forkPoint: ids.turnId,
            stopReason: "end_turn",
          });
          world.updateSession(sessionId, { status: "idle" });
        },
      },
    ],
    onDone,
  );
}
