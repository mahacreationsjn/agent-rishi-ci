import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type RunnerCommandName,
  type RunnerCommandOf,
  type WorkspaceRequest,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpTokenStore } from "../src/mcp/tokens";
import { RunnerCommandError } from "../src/runner/client";
import type { ProjectService } from "../src/services/projects/project-service";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLauncher } from "../src/services/sessions/launcher";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

// Issue #492: a `session.start` the runner didn't answer in time may still have opened the
// session. The launcher records it as unanswered (no failure of the provider), and a start whose
// first turn already began before the late answer counts as opened.

type Command = RunnerCommandOf<RunnerCommandName>;

let env: GithubEnv;
let launcher: SessionLauncher;
/** What `session.start` does on the runner; returns normally when it opened the session. */
let onStart: (sessionId: string) => void;

const timedOut = () => {
  throw new RunnerCommandError("timeout", "Runner command session.start timed out");
};

beforeEach(() => {
  env = createGithubEnv();
  onStart = () => {};
  const runner = {
    isConnected: () => true,
    runnerId: () => "r1",
    providers: () => [],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: Command) => {
      if (command.name === "workspace.prepare") return { cwd: env.dir, branch: null };
      if (command.name !== "session.start") return {};
      onStart(command.sessionId);
      return { resumeToken: "resume-1" };
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;
  launcher = new SessionLauncher({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    inbox: env.inbox,
    home: env.dir,
    worktreesDir: join(env.dir, "wt"),
    orchestratorDir: join(env.dir, "orchestrator"),
    tokens: new McpTokenStore(env.db.db),
  });
});

afterEach(() => env.close());

/** The session's events of a turn that started (and, with `completed`, ended). */
function turn(sessionId: string, turnId: string, completed = false) {
  const thread = `t-${sessionId}`;
  const events = [
    { type: "thread.started", thread: { id: thread } },
    { type: "turn.started", threadId: thread, turnId },
    ...(completed ? [{ type: "turn.completed", threadId: thread, turnId }] : []),
  ] as AgentEvent[];
  env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));
}

const workspace: WorkspaceRequest = { mode: "existing", path: "" };
const input = { text: "Build it", attachments: [] };
const unanswered = (sessionId: string) => env.repo.find(sessionId)?.startMeta?.startUnanswered;

describe("a session start the runner didn't answer (#492)", () => {
  it("fails the session, recording that the runner didn't answer", async () => {
    const session = env.addSession({ status: "starting" });
    onStart = timedOut;
    await launcher.launch(session.id, { workspace: { ...workspace, path: env.dir }, input });
    expect(env.repo.get(session.id).status).toBe("failed");
    expect(unanswered(session.id)).toMatchObject({ code: "timeout" });
    expect(env.inbox.find(`inbox:${session.id}:start`)).toBeDefined();
  });

  it("keeps a session whose first turn started before the answer came too late", async () => {
    const session = env.addSession({ status: "starting" });
    onStart = (id) => {
      turn(id, "u1");
      timedOut();
    };
    await launcher.launch(session.id, { workspace: { ...workspace, path: env.dir }, input });
    expect(env.repo.get(session.id).status).toBe("running");
    expect(unanswered(session.id)).toBeFalsy();
    expect(env.inbox.find(`inbox:${session.id}:start`)).toBeUndefined();
  });

  it("still fails a resume the runner didn't answer when no new turn started", async () => {
    const session = env.addSession({ status: "idle" });
    turn(session.id, "u1", true);
    onStart = timedOut;
    await expect(launcher.resume(env.repo.get(session.id), input)).rejects.toThrow(/timed out/);
  });

  it("forgets an unanswered start once a later start is answered", async () => {
    const session = env.addSession({ status: "starting" });
    onStart = timedOut;
    await launcher.launch(session.id, { workspace: { ...workspace, path: env.dir }, input });
    expect(unanswered(session.id)).toBeTruthy();
    onStart = () => {};
    await launcher.resume(env.repo.get(session.id), input);
    expect(unanswered(session.id)).toBeNull();
  });
});
