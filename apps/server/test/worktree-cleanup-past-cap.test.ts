import {
  defaultSettings,
  type RunnerCommandName,
  type RunnerCommandOf,
  type Session,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { WorktreeCleanup } from "../src/services/sessions/worktree-cleanup";
import { sampleSession } from "./helpers";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * The hourly sweep, a project's archive and the check for a live session in the same folder must
 * see every session, not just the newest thousand that `SessionRepo.list` returns (#479).
 */
let env: GithubEnv;
let cleanup: WorktreeCleanup;
/** Every runner command, as `name path-or-session`. */
let commands: string[];

const NOW = new Date("2026-12-01T10:00:00.000Z");
const OLD = "2026-09-01T10:00:00.000Z";

beforeEach(() => {
  env = createGithubEnv();
  commands = [];
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: RunnerCommandOf<RunnerCommandName>) => {
      if (command.name === "workspace.remove") commands.push(`workspace.remove ${command.path}`);
      else if ("sessionId" in command) commands.push(`${command.name} ${command.sessionId}`);
      return command.name === "workspace.remove" ? { removed: true } : {};
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  cleanup = new WorktreeCleanup({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    store: env.store,
    settings: () => defaultSettings(),
    stopSession: async () => undefined,
    inbox: env.inbox,
    sleep: async () => undefined,
    now: () => NOW,
  });
});

afterEach(() => env.close());

/** An agent session of the project, written straight to the log (no runner involved). */
function agentSession(id: string, patch: Partial<Session>): Session {
  return {
    ...sampleSession,
    id,
    projectId: env.githubProject.id,
    scope: { projectId: env.githubProject.id },
    workKey: `request:${id}`,
    status: "stopped",
    cwd: `/wt/widgets/${id}`,
    worktreePath: `/wt/widgets/${id}`,
    branch: `agent-rishi/${id}`,
    baseBranch: "main",
    createdAt: OLD,
    updatedAt: OLD,
    ...patch,
  };
}

function add(...list: Session[]): void {
  env.store.append(
    list.map((session) => ({
      type: "session.created" as const,
      sessionId: session.id,
      payload: { session },
    })),
  );
}

/**
 * A busy project's history since: a thousand archived sessions whose worktrees are already gone,
 * each newer than everything `add`ed before.
 */
function busyHistory(): void {
  const start = Date.parse(OLD) + 3_600_000;
  add(
    ...Array.from({ length: 1000 }, (_, n) => {
      const at = new Date(start + n * 1000).toISOString();
      return agentSession(`later-${n}`, {
        createdAt: at,
        updatedAt: at,
        archivedAt: at,
        worktreeRemovedAt: at,
      });
    }),
  );
}

const removedPaths = () =>
  commands.filter((c) => c.startsWith("workspace.remove ")).map((c) => c.slice(17));

describe("worktree cleanup past the newest thousand sessions (#479)", () => {
  it("the hourly sweep reaches an archived or inactive session however many came after it", async () => {
    // An archive whose removal failed (a file in use), and a session nobody touched for weeks.
    const archived = agentSession("old-archived", { archivedAt: OLD });
    const inactive = agentSession("old-inactive", { status: "idle" });
    add(archived, inactive);
    busyHistory();

    const removed = await cleanup.sweep();
    expect(removed.sort()).toEqual([archived.id, inactive.id].sort());
    expect(env.repo.get(archived.id).worktreeRemovedAt).not.toBeNull();
    expect(env.repo.get(inactive.id).worktreeRemovedAt).not.toBeNull();
  });

  it("archiving a project cleans up the worktree of its oldest session too", async () => {
    const oldest = agentSession("old-idle", { status: "idle", updatedAt: NOW.toISOString() });
    add(oldest);
    busyHistory();

    const { removed } = await cleanup.cleanProject(env.githubProject.id);
    expect(removed).toEqual([oldest.id]);
    expect(env.repo.get(oldest.id).worktreeRemovedAt).not.toBeNull();
  });

  it("never removes a worktree that a session older than a thousand others still works in", async () => {
    // A long-lived session working in the folder (its own worktree went to another path).
    const live = agentSession("old-live", {
      status: "idle",
      cwd: "/wt/widgets/shared",
      worktreePath: null,
      updatedAt: NOW.toISOString(),
    });
    add(live);
    busyHistory();
    const owner = agentSession("owner", {
      status: "idle",
      worktreePath: "/wt/widgets/shared",
      cwd: "/wt/widgets/shared",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    add(owner);

    const { worktree } = await cleanup.archive(owner.id);
    expect(worktree.status).toBe("failed");
    expect(worktree.message).toMatch(/Another session/);
    expect(removedPaths()).toEqual([]);
    expect(commands).not.toContain(`session.stop ${live.id}`);
  });
});
