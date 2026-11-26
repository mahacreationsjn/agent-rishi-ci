import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  FactoryLimits,
  type Project,
  type Session,
} from "@agent-rishi/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src/server";
import { type Exec, runTool } from "../src/services/exec";
import { sampleSession } from "./helpers";
import { waitUntil } from "./support/harness";
import { removeTree } from "./support/remove-tree";

// Issue #382: `run-failed-notices.test.ts` failed its teardown on a loaded Windows machine with
// `rmSync … EPERM`. Its project lives in the temp folder itself, and a failed turn makes the
// project re-detector run `git -C <temp folder>` in the background. `server.close()` returned
// without waiting for it, so on a busy machine git was still running inside the folder when the
// teardown removed it, which Windows refuses. Here git takes as long as it can under load.

const TOKEN = "t".repeat(32);
/** How long git sits in the project folder: far longer than `close()` takes on its own. */
const GIT_MS = 1_000;
let home: string;
let server: RunningServer | undefined;
let gitRunning = 0;

/** Real git, started the way a loaded machine starts it: it sits in its `-C` folder a while. */
const slowGit: Exec = async (command, args, opts) => {
  if (command !== "git") return runTool(command, args, opts);
  gitRunning++;
  try {
    const dir = args[0] === "-C" ? args[1] : undefined;
    await new Promise<void>((resolve) => {
      const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${GIT_MS})`], {
        cwd: dir,
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
    return await runTool(command, args, opts);
  } finally {
    gitRunning--;
  }
};

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-run-failed-teardown-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: home,
    github: { sync: false },
    exec: slowGit,
  });
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await waitUntil(() => gitRunning === 0);
  await removeTree(home);
});

const services = () => (server as RunningServer).services;

it("close() waits for the project check a failed turn started in the project folder (#382)", async () => {
  const now = new Date().toISOString();
  const project = {
    id: "p-notices",
    name: "app",
    slug: "app",
    path: home,
    kind: "local",
    github: null,
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    autonomyMode: "assisted",
    visionPath: ".agent-rishi/VISION.md",
    factoryLimits: FactoryLimits.parse({}),
    killSwitch: false,
    timezone: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  } as unknown as Project;
  services().store.append([{ type: "project.created", sessionId: null, payload: { project } }]);
  const session: Session = {
    ...sampleSession,
    id: "s-pm-work",
    projectId: project.id,
    role: "agent",
    status: "running",
    purpose: "Fix the parser",
    workKey: "issue:7",
    startedBy: { kind: "pm", id: "pm-1", reportTo: "orchestrator" },
    rootThreadId: null,
    createdAt: now,
    updatedAt: now,
  };
  services().sessionRepo.create(session, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  });
  const append = (...events: AgentEvent[]) =>
    services().store.append(events.map((e) => agentEventToNewEvent(session.id, e)));
  append(
    { type: "thread.started", thread: { id: "t1" } },
    { type: "turn.started", threadId: "t1", turnId: "u1" },
    { type: "turn.failed", threadId: "t1", turnId: "u1", error: { message: "boom" } },
  );
  await waitUntil(() => gitRunning > 0);

  // The teardown run-failed-notices.test.ts had: close, then remove the folder at once.
  await (server as RunningServer).close();
  const gitStillRunningAfterClose = gitRunning;
  let removeError: string | null = null;
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (error) {
    removeError = String(error);
  }
  expect({ gitStillRunningAfterClose, removeError }).toEqual({
    gitStillRunningAfterClose: 0,
    removeError: null,
  });
});
