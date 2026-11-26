import { AGENT_RISHI_VERSION, type SessionTranscriptExport } from "@agent-rishi/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord, rowToThread, rowToTurn } from "../../db/rows";
import { items, threads, turns } from "../../db/schema";
import { turnsOldestFirst } from "../../db/turn-order";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { UsageService } from "../usage/usage-service";
import type { SessionRepo } from "./repo";
import { sessionTranscriptMarkdown, transcriptFileName } from "./transcript-markdown";

/** What the export reads: the session's projections, its project, provider and ledger. */
export interface TranscriptExportDeps {
  db: Db;
  sessionRepo: Pick<SessionRepo, "get" | "find">;
  projects: Pick<ProjectService, "get">;
  runner: Pick<RunnerPort, "providers">;
  usage: Pick<UsageService, "sessionUsage">;
}

/**
 * `GET /api/sessions/:id/export` (§13): the session's transcript as Markdown, every thread
 * included, with its cost from the ledger and its secrets redacted (`knownSecrets` adds exact
 * values to hide, such as the install token). Only reads; works for archived sessions (no
 * worktree needed) and while a turn runs (what exists so far). 404 `session_not_found` for an
 * unknown id.
 */
export async function exportSessionTranscript(
  deps: TranscriptExportDeps,
  sessionId: string,
  opts: { knownSecrets?: readonly string[]; now?: Date } = {},
): Promise<SessionTranscriptExport> {
  const now = opts.now ?? new Date();
  const session = deps.sessionRepo.get(sessionId);
  const projectName = session.projectId ? projectNameOf(deps, session.projectId) : null;
  const forkedFrom = session.forkedFrom
    ? deps.sessionRepo.find(session.forkedFrom.sessionId)
    : null;
  const source = forkedFrom?.session;
  const threadRows = deps.db.select().from(threads).where(eq(threads.sessionId, sessionId)).all();
  const turnRows = deps.db
    .select()
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(...turnsOldestFirst)
    .all();
  const itemRows = deps.db
    .select()
    .from(items)
    .where(eq(items.sessionId, sessionId))
    .orderBy(asc(items.threadId), asc(items.position))
    .all();
  // The ledger adds the cost; a transcript is still worth exporting without it.
  const usage = await deps.usage.sessionUsage(sessionId).catch(() => null);
  const markdown = sessionTranscriptMarkdown({
    session,
    projectName,
    providerName:
      deps.runner.providers().find((p) => p.id === session.provider)?.displayName ??
      session.provider,
    forkedFromTitle: source ? (source.title ?? source.purpose) : null,
    threads: threadRows.map(rowToThread),
    turns: turnRows.map(rowToTurn),
    items: itemRows.map(rowToItemRecord),
    usage,
    exportedAt: now,
    version: AGENT_RISHI_VERSION,
    knownSecrets: opts.knownSecrets,
  });
  const fileName = transcriptFileName(session, now, projectName, opts.knownSecrets);
  return { fileName, markdown };
}

function projectNameOf(deps: TranscriptExportDeps, projectId: string): string | null {
  try {
    return deps.projects.get(projectId).name;
  } catch {
    return null;
  }
}
