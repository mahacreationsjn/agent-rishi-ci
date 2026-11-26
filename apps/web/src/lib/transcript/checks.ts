import {
  CHECK_RUN_NOTICE,
  CheckRunData,
  checkRunItemId,
  type ItemOf,
} from "@agent-rishi/contracts";
import type { TranscriptState } from "./reducer";

/** The check run a card shows (§9 Project checks), or null for any other notice. */
export function checkRunOf(item: ItemOf<"notice">): CheckRunData | null {
  if (item.code !== CHECK_RUN_NOTICE) return null;
  const parsed = CheckRunData.safeParse(item.data);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether the session's checks are running after the thread's latest turn: its card is still
 * in progress. The session is idle meanwhile, and Stop ends the run.
 */
export function checksRunning(state: TranscriptState, threadId: string): boolean {
  const last = state.threads[threadId]?.turnIds.at(-1);
  if (!last) return false;
  const item = state.items[checkRunItemId(last)]?.item;
  return item?.kind === "notice" && item.status === "in_progress" && checkRunOf(item) !== null;
}
