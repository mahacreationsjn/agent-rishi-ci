import type { Item, Session, ThreadInfo } from "@agent-rishi/contracts";
import { applyAgentEvent, emptyTranscript, type TranscriptState } from "@/lib/transcript/reducer";

const BASE = Date.now();

/** ISO timestamp `m` minutes before mock start. */
export function ago(m: number): string {
  return new Date(BASE - m * 60_000).toISOString();
}

/** ISO timestamp `m` minutes after mock start. */
export function ahead(m: number): string {
  return new Date(BASE + m * 60_000).toISOString();
}

export interface TurnSpec {
  id: string;
  threadId: string;
  /** Minutes ago the turn started. */
  start: number;
  /** Minutes ago it ended; omitted while running. */
  end?: number;
  status?: "completed" | "failed" | "interrupted" | "running";
  items: Item[];
}

/** Build a transcript by replaying normalized events, so fixtures stay consistent. */
export function buildTranscript(
  sessionId: string,
  threads: ThreadInfo[],
  turns: TurnSpec[],
): TranscriptState {
  let s = emptyTranscript(sessionId);
  for (const thread of threads) s = applyAgentEvent(s, { type: "thread.started", thread });
  for (const t of turns) {
    s = applyAgentEvent(
      s,
      { type: "turn.started", threadId: t.threadId, turnId: t.id },
      { ts: ago(t.start) },
    );
    for (const item of t.items) {
      s = applyAgentEvent(s, {
        type: "item.completed",
        threadId: t.threadId,
        turnId: t.id,
        item,
      });
    }
    const status = t.status ?? "completed";
    const ts = ago(t.end ?? t.start);
    if (status === "completed")
      s = applyAgentEvent(
        s,
        // Fixture providers can fork, so a finished turn records its fork point.
        { type: "turn.completed", threadId: t.threadId, turnId: t.id, forkPoint: t.id },
        { ts },
      );
    if (status === "failed")
      s = applyAgentEvent(
        s,
        {
          type: "turn.failed",
          threadId: t.threadId,
          turnId: t.id,
          error: { message: "The agent stopped after a failed command.", code: "command_failed" },
        },
        { ts },
      );
    if (status === "interrupted")
      s = applyAgentEvent(
        s,
        { type: "turn.interrupted", threadId: t.threadId, turnId: t.id, reason: "user" },
        { ts },
      );
  }
  return s;
}

const NOT_STARTED = new Set<Session["status"]>(["created", "queued", "starting"]);

type SessionInit = Partial<Session> &
  Pick<Session, "id" | "role" | "status" | "provider" | "purpose" | "workKey">;

/** Fill in the many session fields fixtures don't care about. */
export function makeSession(init: SessionInit): Session {
  return {
    projectId: null,
    parentSessionId: null,
    startedBy: { kind: "user" },
    scope: { projectId: init.projectId ?? null },
    progress: null,
    title: init.purpose,
    model: null,
    effort: null,
    autonomy: "auto",
    cwd: "~/.agent-rishi/orchestrator",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    issue: null,
    pr: null,
    // A session that has run has its provider's conversation, as a real one does.
    resumeToken: NOT_STARTED.has(init.status) ? null : `mock-${init.id}`,
    runnerId: "runner-local",
    automationRunId: null,
    rootThreadId: `t-${init.id.slice(2)}`,
    createdAt: ago(240),
    updatedAt: ago(2),
    endedAt: null,
    ...init,
  };
}

export const gh = (repo: string) => ({
  issue: (number: number, title: string) => ({
    number,
    title,
    url: `https://github.com/${repo}/issues/${number}`,
  }),
  pr: (number: number, title: string, state: "draft" | "open" | "closed" | "merged") => ({
    number,
    title,
    state,
    url: `https://github.com/${repo}/pull/${number}`,
  }),
});
