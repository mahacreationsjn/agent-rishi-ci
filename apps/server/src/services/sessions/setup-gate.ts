import { createHash } from "node:crypto";
import type {
  GitHubPrRef,
  InboxItem,
  Project,
  RunnerCommandResult,
  Session,
} from "@agent-rishi/contracts";
import type { InboxService } from "../inbox-service";
import { readProjectConfig } from "../projects/project-config";
import type { RunnerPort } from "../runner-port";
import { setupFailureNote } from "./setup-failure";

/**
 * Setup commands a person has seen (§9 setup scripts, #390). New worktrees branch from the
 * freshly fetched default branch and run that copy's `.agent-rishi/project.json` setup, so a merged
 * change to it would run on this computer without anyone reading it first. The setup in the
 * project folder (the user's own checkout) counts as seen, and so does a list the user allowed.
 * The runner holds anything else (`workspace.prepare` `seenSetups` / `heldSetup`), and the first
 * worktree that finds a new list asks the user once, in the inbox.
 */

type Prepared = RunnerCommandResult<"workspace.prepare">;
type HeldSetup = NonNullable<Prepared["heldSetup"]>;

/** What `workspace.prepare` sends as `seenSetups`: the project folder's own setup. */
export function seenSetups(project: Pick<Project, "path">): string[][] {
  return [readProjectConfig(project.path)?.setup ?? []];
}

/** The inbox item asking about one command list: one per project and list, so it asks once. */
export function setupChangeId(projectId: string, commands: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(commands)).digest("hex");
  return `inbox:setup-change:${projectId}:${digest.slice(0, 16)}`;
}

/** The PR a commit came from: "Title (#42)" (squash merge) or "Merge pull request #42 …". */
export function changedIn(subject: string | null): number | null {
  const match = subject?.match(/\(#(\d+)\)\s*$/) ?? subject?.match(/^Merge pull request #(\d+)\b/);
  return match ? Number(match[1]) : null;
}

export interface SetupGateDeps {
  inbox: Pick<InboxService, "find" | "put">;
  runner: RunnerPort;
  timeoutMs: number;
}

/**
 * The note for the agent's first input once a workspace is prepared: a failed setup command
 * (`setupFailureNote`), or project setup the runner held. Held setup the user already allowed
 * runs now, in the prepared workspace. Otherwise the inbox asks the user about it, unless it
 * already did for this list, and the agent is told that setup didn't run.
 */
export async function settleSetup(
  deps: SetupGateDeps,
  session: Session,
  project: Project,
  prepared: Prepared,
): Promise<string | null> {
  const failed = setupFailureNote(prepared.setup);
  const held = prepared.heldSetup;
  if (!held) return failed;
  const id = setupChangeId(project.id, held.commands);
  const asked = deps.inbox.find(id);
  if (asked?.status === "resolved") {
    // Setup stops at the first failing command, as when it all runs at once.
    if (failed) return failed;
    const ran = await deps.runner.request(
      {
        name: "workspace.prepare",
        sessionId: session.id,
        repoPath: project.path,
        strategy: "existing",
        path: prepared.cwd,
        setupCommands: held.commands,
      },
      deps.timeoutMs,
    );
    return setupFailureNote(ran.setup);
  }
  const pr = changedIn(held.subject);
  if (!asked) deps.inbox.put(setupChangeItem(id, session, project, held, pr));
  const why =
    asked?.status === "dismissed"
      ? "the user chose not to run them"
      : "they wait for the user's approval";
  const note = `Setup did not run in this worktree: the setup commands in \`.agent-rishi/project.json\` changed${pr ? ` in #${pr}` : ""} since a person last saw them, and ${why}. Don't run them yourself.`;
  return failed ? `${failed}\n\n${note}` : note;
}

/** The inbox item: "Setup commands changed in #N: run them?", with the commands. */
function setupChangeItem(
  id: string,
  session: Session,
  project: Project,
  held: HeldSetup,
  pr: number | null,
): InboxItem {
  const now = new Date().toISOString();
  // A fence longer than any backtick run in the commands, so none can end the code block.
  const ticks = held.commands.flatMap((c) => c.match(/`+/g) ?? []);
  const fence = "`".repeat(Math.max(3, ...ticks.map((t) => t.length + 1)));
  const commit = held.commit
    ? ` (commit \`${held.commit}\`${held.subject ? `: ${held.subject}` : ""})`
    : "";
  const body = [
    `The setup commands in \`.agent-rishi/project.json\` changed${pr ? ` in #${pr}` : ""}${commit} since a person last saw them. New worktrees run them on this computer, so they did not run in the worktree that found them:`,
    `${fence}sh\n${held.commands.join("\n")}\n${fence}`,
    "**Run them** allows this list: new worktrees run it from now on. **Don't run** keeps skipping it without asking again. The setup in your own checkout of the project always runs.",
  ].join("\n\n");
  const github = project.kind === "github" ? project.github : null;
  const prRef: GitHubPrRef | null =
    pr && github
      ? {
          number: pr,
          url: `https://github.com/${github.owner}/${github.repo}/pull/${pr}`,
          state: "merged",
        }
      : null;
  return {
    id,
    kind: "setup_change",
    status: "open",
    priority: "high",
    notify: "needs_you",
    title: `Setup commands changed${pr ? ` in #${pr}` : ""}: run them?`,
    body,
    projectId: project.id,
    sessionId: session.id,
    threadId: session.rootThreadId ?? null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: prRef,
    automationRunId: null,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  };
}
