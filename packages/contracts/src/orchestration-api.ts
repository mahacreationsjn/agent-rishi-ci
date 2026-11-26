import { z } from "zod";
import { StartSessionRequest, StartSessionResponse } from "./api";
import { CheckRounds } from "./checks";
import { AutonomyLevel, Id, ReasoningEffort } from "./common";
import { InboxItemStatus } from "./entities/inbox";
import { Session } from "./entities/session";
import { UnpushedWork } from "./execution";
import { UserInput } from "./input";
import { ConflictRecord, NoticeTarget } from "./orchestration";
import { ConflictDecision } from "./work";

/** HTTP shapes for the orchestrator and PM chats, notices and conflicts (`/api/orchestration`). */

/** `GET|POST /api/orchestration/orchestrator` and `.../projects/:id/pm`. */
export const RoleSessionResponse = z.object({ session: Session.nullable() });
export type RoleSessionResponse = z.infer<typeof RoleSessionResponse>;

/** `POST .../orchestrator/messages` and `.../projects/:id/pm/messages`. */
export const RoleMessageRequest = z.object({
  input: UserInput,
  whenBusy: z.enum(["queue", "steer", "reject"]).default("queue"),
});
export type RoleMessageRequest = z.infer<typeof RoleMessageRequest>;
export type RoleMessageRequestInit = z.input<typeof RoleMessageRequest>;

export const RoleMessageResponse = z.object({
  sessionId: Id,
  status: z.enum(["sent", "queued", "steered"]),
});
export type RoleMessageResponse = z.infer<typeof RoleMessageResponse>;

/**
 * `POST /api/orchestration/orchestrator/start-fresh` and `.../projects/:id/pm/start-fresh`
 * ("Start fresh", §8.1): archive the role's current session, read-only and kept, and start a new
 * one under the same work key on the provider and model the settings name. Refused (409) while a
 * turn runs or the session has a question or approval open, and when `sessionId` is no longer
 * the role's current session. A person's action: no MCP tool calls it.
 */
export const StartFreshRoleRequest = z.object({
  /** The role session the person is looking at: the one to archive. */
  sessionId: Id,
});
export type StartFreshRoleRequest = z.infer<typeof StartFreshRoleRequest>;

export const StartFreshRoleResponse = z.object({
  /** The role's new session: empty apart from Agent Rishi's system prompt; its first turn gets the digest. */
  session: Session,
  /** The archived session, still reachable by its link (and, for a PM, the project's archived list). */
  archivedSessionId: Id,
});
export type StartFreshRoleResponse = z.infer<typeof StartFreshRoleResponse>;

/** `GET /api/orchestration/notices` query. */
export const ListNoticesQuery = z.object({
  projectId: Id.optional(),
  target: NoticeTarget.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListNoticesQuery = z.infer<typeof ListNoticesQuery>;

/** `GET /api/conflicts` query. Defaults to open conflicts. */
export const ListConflictsQuery = z.object({
  status: InboxItemStatus.optional(),
  projectId: Id.optional(),
});
export type ListConflictsQuery = z.infer<typeof ListConflictsQuery>;

/**
 * `POST /api/conflicts/:id/resolve`: the decision (wait, skip, join or force with a reason).
 * `start` replaces the request saved with the conflict: the New session draft as it is when the
 * card is answered, so edits made after the first send are what starts. Same project only. It
 * starts under the conflict's work key (edited text never derives another one); for wait, join
 * or force, a `start` that names a different `workKey` is refused with `work_key_changed`: send
 * it again instead, so it is checked for running work.
 */
export const ResolveConflictRequest = ConflictDecision.and(
  z.object({ start: StartSessionRequest.optional() }),
);
export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequest>;
export type ResolveConflictRequestInit = z.input<typeof ResolveConflictRequest>;

export const ResolveConflictResponse = z.object({
  conflict: ConflictRecord,
  result: StartSessionResponse,
});
export type ResolveConflictResponse = z.infer<typeof ResolveConflictResponse>;

/**
 * `PATCH /api/sessions/:id`: change the model, effort, autonomy, plan mode, the checks loop or
 * title mid-session. Model and effort apply on the next turn (a running turn keeps its settings);
 * `null` returns to the role default.
 */
export const UpdateSessionRequest = z
  .object({
    model: z.string().min(1).nullable().optional(),
    effort: ReasoningEffort.nullable().optional(),
    /**
     * Autonomy level (§11.2), saved on the session and pushed to the live provider session.
     * It applies from the next tool call when the provider reports `liveAutonomy`, otherwise
     * from the next turn. Approvals already waiting stay waiting.
     */
    autonomy: AutonomyLevel.optional(),
    /**
     * Turn plan mode on or off (agent sessions on a provider with `capabilities.planMode`).
     * Saved on the session and pushed to the live provider session like `autonomy`. Off
     * returns the agent to the session's permission level.
     */
    planMode: z.boolean().optional(),
    /**
     * Keep going until checks pass (§9 Project checks), from the next turn's end. Only for a
     * session with frozen checks (`Session.checks`); the commands themselves never change.
     */
    untilChecksPass: z.boolean().optional(),
    /** Automatic rounds for `untilChecksPass`. */
    checkRounds: CheckRounds.optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (r) =>
      r.model !== undefined ||
      r.effort !== undefined ||
      r.autonomy !== undefined ||
      r.planMode !== undefined ||
      r.untilChecksPass !== undefined ||
      r.checkRounds !== undefined ||
      r.title !== undefined,
    { message: "Nothing to change" },
  );
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

/**
 * `POST /api/sessions/:id/archive`: stop the session if it is running, hide it from the
 * sidebar and remove its worktree. The branch and checkpoints stay.
 */
export const ArchiveSessionRequest = z.object({
  /** Remove the worktree even when it has uncommitted changes (those changes are lost). */
  force: z.boolean().default(false),
});
export type ArchiveSessionRequest = z.infer<typeof ArchiveSessionRequest>;

/**
 * What worktree cleanup did: `removed` (`message` notes discarded uncommitted changes, or what
 * was deleted with a container); `kept_changes` (uncommitted changes, not forced; for a session
 * in a container also unpushed commits or stashes, #337); `none` (no worktree, or already
 * removed); `failed` (runner unavailable, a file in use, a container that couldn't be checked;
 * `message` says why).
 */
export const WorktreeCleanupOutcome = z.object({
  status: z.enum(["removed", "kept_changes", "none", "failed"]),
  message: z.string().nullable(),
  /**
   * For a session in a container: what exists only in its clone, as checked before archive
   * kept or deleted the container (`kept_changes`, or `removed` when forced). Absent when it
   * wasn't checked.
   */
  unpushed: UnpushedWork.optional(),
});
export type WorktreeCleanupOutcome = z.infer<typeof WorktreeCleanupOutcome>;

/** `POST /api/sessions/:id/archive` response. */
export const ArchiveSessionResponse = z.object({
  session: Session,
  worktree: WorktreeCleanupOutcome,
});
export type ArchiveSessionResponse = z.infer<typeof ArchiveSessionResponse>;
