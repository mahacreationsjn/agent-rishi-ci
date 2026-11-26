import type { Project, ProviderInfo, Session } from "@agent-rishi/contracts";
import { isReview } from "@/lib/fork-origin";
import { useTranscriptsStore } from "@/stores/transcripts";
import { useProject } from "./queries";

/**
 * Which session actions apply, and why one can't run right now (§9). The menus, the command
 * palette and the panels read these through `useSessionActions`; the server checks the same.
 */

/** Sessions that can be stopped from a menu: ones with a turn running or a question open. */
export const canStop = (session: Pick<Session, "status">) =>
  session.status === "running" || session.status === "waiting";

const NOT_STARTED = new Set<Session["status"]>(["created", "queued", "starting"]);

/** What fork, handoff and review need to know about the session's project. */
type ProjectFacts = Pick<Project, "isGitRepo">;

/**
 * Why a session can't be forked, handed off or reviewed in a project whose folder isn't a git
 * repository (`Project.isGitRepo`, §9): each makes a new worktree, and the server refuses it
 * (`not_a_repo`).
 */
export const NOT_A_REPO_ACTION_REASON = "The project folder isn't a git repository";

/**
 * The reason that comes before all others: a project folder that isn't a git repository won't
 * change when a turn ends, so "wait for the turn" would mislead. An unknown project (not
 * loaded yet) leaves it to the server.
 */
export const notARepoReason = (project: ProjectFacts | undefined) =>
  project?.isGitRepo === false ? NOT_A_REPO_ACTION_REASON : null;

/**
 * Whether the Fork action applies to a session at all: an agent session on a provider that
 * reports `capabilities.fork` (Principle 5: never the provider's name).
 */
export const forkSupported = (session: Session, provider: ProviderInfo | undefined) =>
  session.role === "agent" && provider?.capabilities.fork === true;

/**
 * Why a session that supports forking can't be forked right now, or null when it can (the
 * server checks the same, §9). `project` is the session's project, when known.
 */
export function forkBlocked(session: Session, project?: ProjectFacts): string | null {
  const reason = notARepoReason(project);
  if (reason) return reason;
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.resumeToken) return "No conversation to fork yet";
  if (!session.branch) return "Only sessions on a git branch can be forked";
  return null;
}

/**
 * Why an agent session can't be handed off right now, or null when it can (the server checks
 * the same, §9). Unlike a fork it needs no provider capability and no resume token, but it
 * needs work: `turns` is how many turns the session has had, as the server counts them
 * (subagents' included); undefined when not known here, and then the server decides. `project`
 * is the session's project, when known.
 */
export function handoffBlocked(
  session: Session,
  turns: number | undefined,
  project?: ProjectFacts,
): string | null {
  const reason = notARepoReason(project);
  if (reason) return reason;
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.branch) return "Only sessions on a git branch can be handed off";
  if (turns === 0) return "Nothing to hand off yet";
  return null;
}

/**
 * How many turns a session has had, from its loaded transcript (the session on screen): the
 * turns loaded plus the earlier root turns still on the server; undefined when it isn't loaded.
 */
export function useTurnCount(sessionId: string): number | undefined {
  return useTranscriptsStore((s) => {
    const transcript = s.byId[sessionId];
    return transcript ? Object.keys(transcript.turns).length + transcript.earlierTurns : undefined;
  });
}

/** `handoffBlocked` for a session, with its turn count from the loaded transcript. */
export function useHandoffBlocked(session: Session): string | null {
  return handoffBlocked(session, useTurnCount(session.id), useProject(session.projectId));
}

/**
 * Whether "Review with another agent" applies to a session at all (§9): agent sessions, except
 * reviews themselves (a read-only review has no changes of its own).
 */
export const canReview = (session: Pick<Session, "role" | "forkedFrom">) =>
  session.role === "agent" && !isReview(session.forkedFrom);

/**
 * Why a session's changes can't be reviewed right now, or null when they can (the server checks
 * the same, §9): as for a handoff, it needs a branch and some work, and no turn running or
 * waiting. `turns` is undefined when not known here, and then the server decides. `project` is
 * the session's project, when known.
 */
export function reviewBlocked(
  session: Session,
  turns: number | undefined,
  project?: ProjectFacts,
): string | null {
  const reason = notARepoReason(project);
  if (reason) return reason;
  if (session.status === "waiting") return "Answer what it's waiting on first";
  if (canStop(session)) return "Wait for the running turn to finish";
  if (NOT_STARTED.has(session.status)) return "The session hasn't started yet";
  if (!session.branch) return "Only sessions on a git branch can be reviewed";
  if (turns === 0) return "No changes to review yet";
  return null;
}

/** `reviewBlocked` for a session, with its turn count from the loaded transcript. */
export function useReviewBlocked(session: Session): string | null {
  return reviewBlocked(session, useTurnCount(session.id), useProject(session.projectId));
}
