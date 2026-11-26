import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInfo, RunnerCommand, Session } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, openDatabase } from "../src/db/client";
import { EventStore } from "../src/events/store";
import { compactRefusal } from "../src/services/sessions/compact";
import { SessionRepo } from "../src/services/sessions/repo";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import { sampleSession } from "./helpers";
import { removeTree } from "./support/remove-tree";

const caps: ProviderInfo["capabilities"] = {
  resume: true,
  steer: true,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: false,
};
const provider = (id: string, compact: boolean): ProviderInfo => ({
  id,
  displayName: id === "acp" ? "Cursor" : "Codex",
  models: [],
  capabilities: { ...caps, compact },
});

/** A runner error as the runner port throws it. */
const runnerError = (code: string) => Object.assign(new Error(code), { code });

let dir: string;
let database: Database;
let repo: SessionRepo;
let commands: RunnerCommand[];
let refuse: string[];
let queued: number;
let resume: ReturnType<typeof vi.fn>;
let service: SessionService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-compact-"));
  database = openDatabase(join(dir, "agent-rishi.db"));
  repo = new SessionRepo(database.db, new EventStore(database.db));
  commands = [];
  refuse = [];
  queued = 0;
  resume = vi.fn(async () => {});
  service = new SessionService({
    repo,
    runner: {
      providers: () => [provider("codex", true), provider("acp", false)],
      isConnected: () => true,
      request: async (command: RunnerCommand) => {
        commands.push(command);
        const code = refuse.shift();
        if (code) throw runnerError(code);
        return {};
      },
    },
    outbox: { count: () => queued },
    launcher: { resume },
  } as unknown as SessionServiceDeps);
});

afterEach(async () => {
  database.close();
  await removeTree(dir);
});

function session(over: Partial<Session> = {}): Session {
  const s: Session = {
    ...sampleSession,
    id: `s-${Math.random().toString(36).slice(2, 8)}`,
    provider: "codex",
    status: "idle",
    resumeToken: "thread-1",
    ...over,
  };
  repo.create(s, {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  });
  return s;
}

describe("Compact now (SessionService.compact)", () => {
  it("asks the session's runner to compact and marks the session running", async () => {
    const s = session({ status: "stopped", endedAt: new Date().toISOString() });
    expect(await service.compact(s.id)).toEqual({ status: "compacting" });
    expect(commands).toEqual([{ name: "session.compact", sessionId: s.id }]);
    expect(repo.get(s.id)).toMatchObject({ status: "running", endedAt: null });
    expect(resume).not.toHaveBeenCalled();
  });

  it("resumes a session the runner no longer hosts, then compacts it", async () => {
    const s = session();
    refuse = ["unknown_session"];
    await service.compact(s.id);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(commands.map((c) => c.name)).toEqual(["session.compact", "session.compact"]);
  });

  it("puts the status back when the compaction can't start", async () => {
    const s = session();
    refuse = ["command_failed"];
    await expect(service.compact(s.id)).rejects.toMatchObject({ code: "command_failed" });
    expect(repo.get(s.id).status).toBe("idle");
    // Refused because the provider runs a turn after all: the session stays running.
    refuse = ["turn_running"];
    await expect(service.compact(s.id)).rejects.toMatchObject({
      status: 409,
      code: "turn_running",
    });
    expect(repo.get(s.id).status).toBe("running");
  });

  it("refuses sessions it can't compact now, before asking the runner", async () => {
    const cases: Array<[Partial<Session>, string]> = [
      [{ provider: "acp" }, "unsupported"],
      [{ status: "running" }, "turn_running"],
      [{ status: "waiting" }, "turn_running"],
      [{ status: "starting" }, "not_started"],
      [{ resumeToken: null }, "not_started"],
      [{ archivedAt: new Date().toISOString() }, "archived"],
    ];
    for (const [over, code] of cases) {
      const s = session(over);
      await expect(service.compact(s.id), code).rejects.toMatchObject({ status: 409, code });
    }
    // Messages waiting in the queue run first.
    queued = 1;
    const s = session();
    await expect(service.compact(s.id)).rejects.toMatchObject({ code: "turn_running" });
    expect(commands).toEqual([]);
  });
});

describe("compactRefusal", () => {
  it("counts a provider the runner doesn't list as unable", () => {
    const s = { ...sampleSession, status: "idle", resumeToken: "t" } as Session;
    expect(compactRefusal(s, undefined, { delivering: false, queued: 0 })?.code).toBe(
      "unsupported",
    );
    expect(compactRefusal(s, provider("codex", true), { delivering: true, queued: 0 })?.code).toBe(
      "turn_running",
    );
    expect(compactRefusal(s, provider("codex", true), { delivering: false, queued: 0 })).toBeNull();
  });
});
