import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  agentEventToNewEvent,
  type ErrorInfo,
  type ProviderInfo,
  type QueuedMessage,
  type Session,
  Settings,
  type SettingsInput,
} from "@agent-rishi/contracts";
import { vi } from "vitest";
import { type Db, openDatabase } from "../../src/db/client";
import { EventStore } from "../../src/events/store";
import { InboxService } from "../../src/services/inbox-service";
import { PmAsks } from "../../src/services/orchestration/asks";
import { RoleLimitSwitch } from "../../src/services/orchestration/role-limit-switch";
import { RoleSessions } from "../../src/services/orchestration/role-sessions";
import type { ProjectService } from "../../src/services/projects/project-service";
import { Outbox } from "../../src/services/sessions/outbox";
import { SessionRepo } from "../../src/services/sessions/repo";
import {
  SessionService,
  type SessionServiceDeps,
} from "../../src/services/sessions/session-service";
import { removeTree } from "./remove-tree";

const info = (id: string, readOnly?: boolean): ProviderInfo =>
  ({ id, displayName: id, models: [], capabilities: { readOnly } }) as unknown as ProviderInfo;

export interface RoleEnv {
  db: Db;
  store: EventStore;
  roles: RoleSessions;
  repo: SessionRepo;
  sessions: SessionService;
  inbox: InboxService;
  asks: PmAsks;
  /** The switch at a usage limit, fed the store's events and every message sent to a role. */
  limits: RoleLimitSwitch;
  /** The providers the runner loaded, in its order, and whether each can run read-only. */
  providers(list: { id: string; readOnly: boolean }[]): void;
  /** The providers ready for new work (default: not known, so every loaded one). */
  ready(ids: string[] | null): void;
  /** Start a turn of the session and fail it with `error`, as the runner's events would. */
  failTurn(id: string, turnId: string, error: ErrorInfo): void;
  /**
   * Change the settings and apply them to the roles, as `PATCH /api/settings` does. The
   * returned promise is the retirements, which the request itself doesn't wait for.
   */
  set(settings: SettingsInput): Promise<void>;
  /** Change the settings file only, as a version without this feature did. */
  setQuietly(settings: SettingsInput): void;
  /** End the session's turn with `status`. */
  settle(id: string, status?: Session["status"]): void;
  /** The session's queue: sender and text, next first. */
  queue(id: string): { from: QueuedMessage["from"]; text: string }[];
  /** The live (not retired) sessions of the project's PM role. */
  livePms(): Session[];
  /** Store a turn of the session, as the runner's events would. */
  turn(id: string, turnId: string, input: string, reply: string): void;
  /** Ids the runner was asked to stop, in order. */
  stopped: string[];
  /** Every command the runner got, as `<name> <sessionId>`, in order. */
  commands: string[];
  /** Hold the runner's answer to the nth `session.stop` (from 1) until the promise settles. */
  holdStop(nth: number, until: Promise<void>): void;
  /** The runner's link: while false its providers can't be checked. */
  connected(value: boolean): void;
  /** The project's own default provider (its "Default agent"). */
  projectDefault(provider: string | null): void;
  logged: string[];
}

/** A promise settled from outside. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Role sessions over a real database, queue and SessionService, with a scripted runner that
 * has `claude` and `codex` (`gemini` stands for a provider the runner doesn't have). Starts
 * are accepted and never finish by themselves: a new session stays `starting` until `settle`.
 */
export function withRoles(run: (env: RoleEnv) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-rishi-role-provider-"));
    const database = openDatabase(join(dir, "agent-rishi.db"));
    try {
      const store = new EventStore(database.db);
      const repo = new SessionRepo(database.db, store);
      const inbox = new InboxService(database.db, store, () => async () => {});
      const outbox = new Outbox(database.db, store);
      let settings = Settings.parse({});
      let connected = true;
      let loaded = [info("claude"), info("codex")];
      let ready: string[] | null = null;
      const stopped: string[] = [];
      const commands: string[] = [];
      const holds = new Map<number, Promise<void>>();
      const logged: string[] = [];
      const project = {
        id: "p1",
        name: "app",
        slug: "app",
        path: dir,
        defaultProvider: null as string | null,
        archivedAt: null,
        autonomy: null,
      };
      const projects = { get: () => project } as unknown as ProjectService;
      const runner = {
        providers: () => loaded,
        isConnected: () => connected,
        request: vi.fn(async (command: { name: string; sessionId: string }) => {
          commands.push(`${command.name} ${command.sessionId}`);
          if (command.name !== "session.stop") return;
          stopped.push(command.sessionId);
          await holds.get(stopped.length);
        }),
      };
      const settingsStore = { get: () => settings };
      const sessions = new SessionService({
        repo,
        projects,
        runner,
        settings: settingsStore,
        launcher: { launch: vi.fn(async () => {}) },
        outbox,
        artifacts: {
          externalizeAttachments: (input: unknown) => input,
          resolveAttachments: (input: unknown) => input,
        },
        tokens: { revokeSession: () => {} },
        inbox: { dismissRequestsForSession: () => {} },
      } as unknown as SessionServiceDeps);
      const asks = new PmAsks({
        db: database.db,
        session: (id) => repo.find(id)?.session,
        onLateReply: () => {},
      });
      const moved: Pick<RoleLimitSwitch, "moved"> = { moved: (...args) => limits.moved(...args) };
      const roles = new RoleSessions({
        db: database.db,
        repo,
        sessions,
        projects,
        inbox,
        settings: settingsStore,
        runner,
        onMoved: (from, to, why) => {
          asks.retarget(from.id, to.id);
          moved.moved(from, to, why);
        },
        log: (message) => logged.push(message),
      });
      const limits = new RoleLimitSwitch({
        store,
        repo,
        roles,
        inbox,
        projects,
        settings: settingsStore,
        runner,
        ready: async () => ready ?? loaded.map((p) => p.id),
        timezone: () => "UTC",
        log: (message) => logged.push(message),
      });
      sessions.setInputDecorator((session, input, from) => {
        limits.sending(session, input, from);
        return { input };
      });
      const off = store.subscribe((events) => {
        asks.onEvents(events);
        limits.onEvents(events);
      });
      const append = (id: string, event: AgentEvent) =>
        store.append([agentEventToNewEvent(id, event)]);
      await run({
        db: database.db,
        store,
        roles,
        repo,
        sessions,
        inbox,
        asks,
        limits,
        providers: (list) => {
          loaded = list.map((p) => info(p.id, p.readOnly));
        },
        ready: (ids) => {
          ready = ids;
        },
        failTurn: (id, turnId, error) => {
          const at = { threadId: `thread-${id}`, turnId };
          append(id, { type: "thread.started", thread: { id: at.threadId } });
          append(id, { type: "turn.started", ...at });
          append(id, { type: "turn.failed", ...at, error });
        },
        set: (next) => {
          const before = settings.providers;
          settings = Settings.parse(next);
          return roles.applyProviderSettings(before);
        },
        setQuietly: (next) => {
          settings = Settings.parse(next);
        },
        settle: (id, status = "idle") => {
          repo.update(id, (s) => ({ ...s, status }));
        },
        queue: (id) => outbox.list(id).map((m) => ({ from: m.from, text: m.input.text })),
        livePms: () => repo.list({}).filter((s) => s.role === "pm" && !s.archivedAt),
        turn: (id, turnId, input, reply) => {
          const at = { threadId: `thread-${id}`, turnId };
          append(id, { type: "thread.started", thread: { id: at.threadId } });
          append(id, { type: "turn.started", ...at });
          append(id, {
            type: "item.completed",
            ...at,
            item: {
              id: `${turnId}-in`,
              kind: "user_message",
              status: "completed",
              input: { text: input, attachments: [] },
            },
          } as AgentEvent);
          append(id, {
            type: "item.completed",
            ...at,
            item: {
              id: `${turnId}-out`,
              kind: "assistant_message",
              status: "completed",
              text: reply,
            },
          } as AgentEvent);
          append(id, { type: "turn.completed", ...at });
        },
        stopped,
        commands,
        holdStop: (nth, until) => holds.set(nth, until),
        connected: (value) => {
          connected = value;
        },
        projectDefault: (provider) => {
          project.defaultProvider = provider;
        },
        logged,
      });
      off();
    } finally {
      database.close();
      await removeTree(dir);
    }
  };
}
