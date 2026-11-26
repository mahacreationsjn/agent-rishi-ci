import type { TranscriptMessage } from "@agent-rishi/contracts";
import { byStart, type ThreadState, type TranscriptState } from "./reducer";

/**
 * Apply a `transcript` message from `watch_session`: the latest state of every thread, turn
 * and item that changed, replaced by id. New items are placed by their thread position.
 * Returns a new state object; never mutates `prev`.
 */
export function applyTranscriptMessage(
  prev: TranscriptState,
  msg: TranscriptMessage,
): TranscriptState {
  const state: TranscriptState = {
    ...prev,
    seq: Math.max(prev.seq, msg.seq),
    threads: { ...prev.threads },
    turns: { ...prev.turns },
    items: { ...prev.items },
  };
  // A transcript holding only the latest turns ignores changes to root turns before them (a late
  // update to an old item): those arrive, current, with their page.
  const root = prev.rootThreadId ? prev.threads[prev.rootThreadId] : undefined;
  const partial = prev.earlierTurns > 0 && root !== undefined;
  const firstStart = root ? prev.turns[root.turnIds[0] ?? ""]?.startedAt : undefined;
  const firstPosition = root ? prev.items[root.itemIds[0] ?? ""]?.position : undefined;
  const touched = new Set<string>();
  const thread = (id: string): ThreadState => {
    const existing = state.threads[id];
    if (existing && touched.has(id)) return existing;
    const copy: ThreadState = existing
      ? { ...existing, itemIds: [...existing.itemIds], turnIds: [...existing.turnIds] }
      : {
          id,
          parentThreadId: null,
          parentItemId: null,
          title: null,
          agentType: null,
          itemIds: [],
          turnIds: [],
        };
    state.threads[id] = copy;
    touched.add(id);
    return copy;
  };

  for (const t of msg.threads) {
    const copy = thread(t.id);
    copy.parentThreadId = t.parentThreadId;
    copy.parentItemId = t.parentItemId;
    copy.title = t.title;
    copy.agentType = t.agentType;
    if (!t.parentThreadId && !state.rootThreadId) state.rootThreadId = t.id;
  }
  for (const turn of msg.turns) {
    const unloaded =
      partial &&
      turn.threadId === root?.id &&
      !prev.turns[turn.id] &&
      firstStart !== undefined &&
      turn.startedAt < firstStart;
    if (unloaded) continue;
    state.turns[turn.id] = {
      id: turn.id,
      threadId: turn.threadId,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      error: turn.error,
      // Where the conversation can be forked through this turn ("Fork from here", §9).
      forkPoint: turn.forkPoint ?? null,
      kind: turn.kind ?? null,
    };
    const t = thread(turn.threadId);
    if (!t.turnIds.includes(turn.id)) {
      // Placed by start time, so the thread's last turn stays its latest one.
      const at = t.turnIds.findIndex((id) => {
        const other = state.turns[id];
        return other !== undefined && byStart(other, turn) > 0;
      });
      if (at === -1) t.turnIds.push(turn.id);
      else t.turnIds.splice(at, 0, turn.id);
    }
    if (!state.rootThreadId) state.rootThreadId = turn.threadId;
  }
  for (const r of msg.items) {
    const existing = state.items[r.item.id];
    const unloaded =
      partial &&
      !existing &&
      r.threadId === root?.id &&
      firstPosition !== undefined &&
      r.position < firstPosition;
    if (unloaded) continue;
    state.items[r.item.id] = {
      item: r.item,
      threadId: r.threadId,
      turnId: r.turnId,
      position: r.position,
    };
    if (existing) continue;
    const t = thread(r.threadId);
    const at = t.itemIds.findIndex((id) => (state.items[id]?.position ?? -1) > r.position);
    if (at === -1) t.itemIds.push(r.item.id);
    else t.itemIds.splice(at, 0, r.item.id);
  }
  if (msg.usage) state.usage = msg.usage;
  return state;
}
