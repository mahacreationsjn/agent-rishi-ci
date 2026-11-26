import {
  type AgentEvent,
  agentEventToNewEvent,
  CheckRunData,
  defaultSettings,
  type ErrorInfo,
  type ItemOf,
  type ProviderInfo,
  type RunnerCommandName,
  type RunnerCommandOf,
  type RunnerCommandResult,
  type SessionChecks,
  type TurnKind,
  type UserInput,
} from "@agent-rishi/contracts";
import type { ProjectService } from "../../src/services/projects/project-service";
import type { RunnerPort } from "../../src/services/runner-port";
import { AutoRetry } from "../../src/services/sessions/auto-retry";
import { ChecksLoop } from "../../src/services/sessions/checks-loop";
import { Outbox } from "../../src/services/sessions/outbox";
import {
  SessionService,
  type SessionServiceDeps,
} from "../../src/services/sessions/session-service";
import type { SettingsStore } from "../../src/settings-store";
import { createGithubEnv, type GithubEnv } from "./github-env";

/**
 * The checks loop (§9 Project checks) over a real database and `SessionService`, with a
 * scripted runner: `check.run` answers from `script`, and the provider runs a turn for every
 * message (`session.send`) and compaction (`session.compact`) it is handed, ending it as
 * `turnEnds` says. Automatic retries run for real, with no wait after a usage limit resets.
 */

export type Command = RunnerCommandOf<RunnerCommandName>;
export type CheckRunResult = RunnerCommandResult<"check.run">;
/** How the provider ends a turn: it completes, or fails with this error. */
export type TurnEnd = "complete" | ErrorInfo;

export const T = "t-root";

export const pass = (output = "ok"): CheckRunResult => ({
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  durationMs: 1200,
  output,
  truncated: false,
});
export const fail = (output: string, exitCode = 1): CheckRunResult => ({
  ...pass(output),
  exitCode,
});
export const user = (text: string): UserInput => ({ text, attachments: [] });
/** A usage limit that has already reset: auto-retry continues the session at once. */
export const usageLimit = (): ErrorInfo => ({
  message: "Usage limit reached",
  kind: "usage_limit",
  retryAt: new Date(Date.now() - 1_000).toISOString(),
});

export const CHECKS: SessionChecks = {
  commands: [{ command: "pnpm typecheck" }, { command: "pnpm test", timeoutSec: 120 }],
  untilPass: true,
  maxRounds: 3,
};

const fakeProvider: ProviderInfo = {
  id: "fake",
  displayName: "Fake",
  models: [],
  capabilities: {
    resume: true,
    steer: false,
    interrupt: true,
    approvals: false,
    userQuestions: false,
    subagents: false,
    rollback: false,
    fork: false,
    images: false,
    planMode: false,
    reasoningEffort: false,
    mcp: false,
    skills: false,
    compact: true,
  },
};

export interface ChecksEnv {
  env: GithubEnv;
  sessions: SessionService;
  loop: ChecksLoop;
  autoRetry: AutoRetry;
  /** Every command the runner was sent, in order. */
  calls: Command[];
  /** What each `check.run` answers, by command: the next result in its list (the last repeats). */
  script: Map<string, Array<CheckRunResult | "hang">>;
  /** How the provider ends the turns it runs next, in order; then they complete. */
  turnEnds: TurnEnd[];
  /** A check hangs, waiting for `check.cancel`. */
  hanging: () => boolean;
  /** Turns the provider has run so far: their ids are `u1`, `u2`, ... */
  turnCount: () => number;
  /** A turn of the provider: the message it was sent (none for a compaction), then its end. */
  turn: (sessionId: string, input: UserInput | null, end?: TurnEnd, kind?: TurnKind) => string;
  newSession: (checks?: SessionChecks) => string;
  /** The checks card of a turn. */
  card: (
    sessionId: string,
    turnId: string,
  ) => { item: ItemOf<"notice">; data: CheckRunData } | undefined;
  ended: (sessionId: string, turnId: string) => () => boolean;
  checkRuns: () => string[];
  sends: () => UserInput[];
  close: () => Promise<void>;
}

export function createChecksEnv(): ChecksEnv {
  const env = createGithubEnv();
  const calls: Command[] = [];
  const script = new Map<string, Array<CheckRunResult | "hang">>();
  const ran = new Map<string, number>();
  const turnEnds: TurnEnd[] = [];
  let release: (() => void) | undefined;
  let turnNo = 0;

  const agent = (sessionId: string, ...events: AgentEvent[]) =>
    env.store.append(events.map((e) => agentEventToNewEvent(sessionId, e)));

  const turn = (
    sessionId: string,
    input: UserInput | null,
    end: TurnEnd = "complete",
    kind?: TurnKind,
  ) => {
    const turnId = `u${++turnNo}`;
    agent(
      sessionId,
      { type: "turn.started", threadId: T, turnId, ...(kind ? { kind } : {}) },
      ...(input
        ? [
            {
              type: "item.completed",
              threadId: T,
              turnId,
              item: { id: `msg-${turnId}`, kind: "user_message", status: "completed", input },
            } as AgentEvent,
          ]
        : []),
      end === "complete"
        ? { type: "turn.completed", threadId: T, turnId }
        : { type: "turn.failed", threadId: T, turnId, error: end },
    );
    return turnId;
  };

  const runner = {
    isConnected: () => false,
    runnerId: () => "r1",
    providers: () => [fakeProvider],
    mcpProxyUrl: () => null,
    waitForConnection: async () => true,
    request: (async (command: Command) => {
      calls.push(command);
      if (command.name === "check.run") {
        const list = script.get(command.command) ?? [pass()];
        const n = ran.get(command.command) ?? 0;
        ran.set(command.command, n + 1);
        const next = list[Math.min(n, list.length - 1)] ?? pass();
        if (next === "hang") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { ...pass(""), exitCode: null, cancelled: true };
        }
        return next;
      }
      if (command.name === "check.cancel") {
        const had = release !== undefined;
        release?.();
        release = undefined;
        return { cancelled: had };
      }
      if (command.name === "session.send" || command.name === "session.compact") {
        // The provider runs the turn once the runner has taken the message. The runner marks
        // the turn a compaction starts (`SessionHost.compact`).
        const compact = command.name === "session.compact";
        const input = compact ? null : command.input;
        const end = turnEnds.shift() ?? "complete";
        setImmediate(() => turn(command.sessionId, input, end, compact ? "compact" : undefined));
      }
      return {};
    }) as RunnerPort["request"],
  } as unknown as RunnerPort;

  const sessions = new SessionService({
    repo: env.repo,
    projects: { get: () => env.githubProject } as unknown as ProjectService,
    runner,
    inbox: env.inbox,
    launcher: { launch: async () => undefined },
    outbox: new Outbox(env.db.db, env.store),
    artifacts: {
      externalizeAttachments: (i: UserInput) => i,
      resolveAttachments: (i: UserInput) => i,
    },
    settings: { get: () => defaultSettings() } as unknown as SettingsStore,
    tokens: { revokeSession: () => undefined },
  } as unknown as SessionServiceDeps);
  const send = (id: string, input: UserInput) =>
    sessions.send(id, { input, whenBusy: "queue" }, "agent-rishi");
  const loop = new ChecksLoop({
    db: env.db.db,
    store: env.store,
    repo: env.repo,
    project: () => env.githubProject,
    runnerOf: () => runner,
    send,
    hasPendingMessage: (id) => sessions.hasOutbox(id) || sessions.isDelivering(id),
  });
  sessions.setCheckRuns(loop);
  const autoRetry = new AutoRetry({
    db: env.db.db,
    store: env.store,
    repo: env.repo,
    inbox: env.inbox,
    settings: () => defaultSettings(),
    send,
    usageMarginMs: 0,
  });
  loop.start();
  autoRetry.start();

  const card = (id: string, turnId: string) => {
    const item = env.repo.item(id, `checks-${turnId}`)?.item as ItemOf<"notice"> | undefined;
    return item ? { item, data: CheckRunData.parse(item.data) } : undefined;
  };

  return {
    env,
    sessions,
    loop,
    autoRetry,
    calls,
    script,
    turnEnds,
    hanging: () => release !== undefined,
    turnCount: () => turnNo,
    turn,
    newSession: (checks = CHECKS) => {
      const s = env.addSession({ status: "running", checks, resumeToken: "thread-1" });
      agent(s.id, { type: "thread.started", thread: { id: T } });
      return s.id;
    },
    card,
    ended: (id, turnId) => () => card(id, turnId)?.item.status === "completed",
    checkRuns: () => calls.flatMap((c) => (c.name === "check.run" ? [c.command] : [])),
    sends: () => calls.flatMap((c) => (c.name === "session.send" ? [c.input] : [])),
    close: async () => {
      release?.();
      autoRetry.stop();
      loop.stop();
      await new Promise((resolve) => setImmediate(resolve));
      await env.close();
    },
  };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for `check` to hold, up to a generous deadline. */
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await wait(5);
  }
}
