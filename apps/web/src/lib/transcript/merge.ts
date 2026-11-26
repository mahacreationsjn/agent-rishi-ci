import { byStart, type ItemEntry, type ThreadState, type TranscriptState } from "./reducer";

// A loaded transcript is always the latest turns of the root thread (§6): a snapshot asks for
// them (`?turns=`), and the session watch keeps them current. `earlierTurns` counts the root
// turns before the earliest loaded one, a number that never changes for a given turn (turns
// only ever start at the end), so the lower count is the transcript reaching further back.

/** Whether `have` already holds all of `next`: it is as new, and reaches back as far. */
export function coversTranscript(have: TranscriptState, next: TranscriptState): boolean {
  return have.seq >= next.seq && have.earlierTurns <= next.earlierTurns;
}

/**
 * Merge a newly loaded snapshot of a session (an earlier page, or one reaching further back to
 * a search hit) into the transcript already loaded. Both are runs of the latest root turns, so
 * the union is too. Where both hold a thread, turn or item, the newer one (by seq) wins; turns
 * and items keep their thread order (start time, position). Never mutates either side.
 */
export function mergeTranscripts(have: TranscriptState, next: TranscriptState): TranscriptState {
  const [older, newer] = next.seq >= have.seq ? [have, next] : [next, have];
  // The side reaching further back lists its turns and items first, so ties keep that order.
  const [back, front] = next.earlierTurns < have.earlierTurns ? [next, have] : [have, next];
  const items: Record<string, ItemEntry> = { ...older.items };
  for (const [id, entry] of Object.entries(newer.items)) {
    const position = entry.position ?? older.items[id]?.position;
    items[id] = position === undefined ? entry : { ...entry, position };
  }
  const turns = { ...older.turns, ...newer.turns };
  const threads: Record<string, ThreadState> = {};
  for (const id of new Set([...Object.keys(back.threads), ...Object.keys(front.threads)])) {
    const meta = newer.threads[id] ?? older.threads[id];
    if (!meta) continue;
    const union = (pick: (t: ThreadState) => string[]) => [
      ...new Set([...pick(back.threads[id] ?? meta), ...pick(front.threads[id] ?? meta)]),
    ];
    threads[id] = {
      ...meta,
      turnIds: union((t) => t.turnIds).sort((a, b) =>
        byStart(turns[a] ?? { startedAt: "" }, turns[b] ?? { startedAt: "" }),
      ),
      itemIds: byPosition(
        union((t) => t.itemIds),
        items,
      ),
    };
  }
  return {
    ...newer,
    rootThreadId: newer.rootThreadId ?? older.rootThreadId,
    threads,
    turns,
    items,
    usage: newer.usage ?? older.usage,
    title: newer.title ?? older.title,
    model: newer.model ?? older.model,
    earlierTurns: back.earlierTurns,
  };
}

/** Item ids by thread position; items without one (streamed live in the mock) stay last. */
function byPosition(ids: string[], items: Record<string, ItemEntry>): string[] {
  const placed = ids.filter((id) => items[id]?.position !== undefined);
  const rest = ids.filter((id) => items[id]?.position === undefined);
  placed.sort((a, b) => (items[a]?.position ?? 0) - (items[b]?.position ?? 0));
  return [...placed, ...rest];
}
