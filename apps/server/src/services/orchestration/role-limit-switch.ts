import {
  type AgentEventOf,
  agentEventToNewEvent,
  type InboxItem,
  PROVIDER_SWITCH_CODE,
  type ProviderSwitchData,
  type QueuedMessage,
  type RawEventEnvelope,
  type Session,
  type UserInput,
} from "@agent-rishi/contracts";
import type { EventStore } from "../../events/store";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import { projectDefaultProvider } from "../projects/project-config";
import type { ProjectService } from "../projects/project-service";
import type { RunnerPort } from "../runner-port";
import type { SessionRepo } from "../sessions/repo";
import { afterLimit, pickFallback, roleName, switchText } from "./role-fallback";
import type { ReplaceReason, RoleSessions } from "./role-sessions";

export interface RoleLimitSwitchDeps {
  store: Pick<EventStore, "append">;
  repo: Pick<SessionRepo, "find">;
  roles: Pick<RoleSessions, "fallBack">;
  inbox: Pick<InboxService, "put">;
  projects: Pick<ProjectService, "get">;
  settings: Pick<SettingsStore, "get">;
  /** The home runner: only a provider it loaded can take a role over. */
  runner: Pick<RunnerPort, "providers">;
  /**
   * Ids of the providers that can run new work now (installed and signed in). Without it, or
   * when it fails, every loaded provider counts as ready.
   */
  ready?: () => Promise<string[]>;
  /** The user's IANA timezone, for the reset time in the notice. */
  timezone: () => string;
  now?: () => number;
  log?: (message: string) => void;
}

type Sent = Pick<QueuedMessage, "input" | "from">;
type TurnRef = { threadId: string; turnId: string };

/** The inbox item about a role's provider switch: one per role, replaced by its next switch. */
export function switchInboxId(role: Session["role"], projectId: string | null): string {
  return role === "pm"
    ? `inbox:provider-switch:pm:${projectId}`
    : "inbox:provider-switch:orchestrator";
}

/**
 * "Switch provider automatically when a limit is hit" (§8.1, `settings.providers
 * .autoSwitchOnLimit`, on by default). When the root turn of the orchestrator's or a PM's
 * session fails as `usage_limit`, the role moves to a fallback provider (`pickFallback`) through
 * the same replace step as a provider move (`RoleSessions.fallBack`), and the message of the
 * failed turn is sent again on the new session. The switch is told in the role's chat (a
 * `provider_switch` notice in the failed turn and in the new session's first turn) and in the
 * inbox, so the status digest lists it. Going back once the limit has reset is `RoleSessions`'
 * own check on the role's next use; its notice comes from here too (`moved`).
 *
 * With no provider to take over, nothing is switched: the turn stays failed as before, with a
 * notice saying why. Agent sessions are never moved.
 */
export class RoleLimitSwitch {
  /** The last message sent to each role session, to send again if its turn hits a limit. */
  private readonly lastSent = new Map<string, Sent>();
  /** Notices for a new role session, shown in its first turn. */
  private readonly pending = new Map<string, { data: ProviderSwitchData; message: string }>();
  /** The limit a switch under way acts on, by the session that hit it. */
  private readonly hits = new Map<string, { retryAt: string | null; at: TurnRef }>();
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RoleLimitSwitchDeps) {}

  /** A message is on its way to a role session (before the digest is added to it). */
  sending(session: Session, input: UserInput, from: QueuedMessage["from"]): void {
    if (session.role !== "agent") this.lastSent.set(session.id, { input, from });
  }

  onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (!e.sessionId) continue;
      if (e.type === "agent.turn.started") {
        const event = e.payload as AgentEventOf<"turn.started">;
        const waiting = this.pending.get(e.sessionId);
        if (!waiting) continue;
        this.pending.delete(e.sessionId);
        this.notice(e.sessionId, event, waiting.data, waiting.message);
      } else if (e.type === "agent.turn.failed") {
        const event = e.payload as AgentEventOf<"turn.failed">;
        const session = this.deps.repo.find(e.sessionId)?.session;
        if (!session || session.role === "agent" || session.archivedAt) continue;
        if (session.rootThreadId && session.rootThreadId !== event.threadId) continue;
        if (event.error.kind !== "usage_limit") continue;
        if (!this.deps.settings.get().providers.autoSwitchOnLimit) continue;
        this.work = this.work
          .then(() => this.switch(session, event))
          .catch((error) => this.deps.log?.(`provider switch: ${errorMessage(error)}`));
      }
    }
  }

  /** Resolves once the switches started so far are done (tests). */
  idle(): Promise<void> {
    return this.work;
  }

  private async switch(session: Session, event: AgentEventOf<"turn.failed">): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    const retryAt = event.error.retryAt ?? null;
    const earlier = this.deps.repo.find(session.id)?.startMeta?.fallback ?? null;
    const fallback = afterLimit(earlier, session.provider, retryAt, now);
    const settings = this.deps.settings.get().providers;
    const project = session.projectId ? this.deps.projects.get(session.projectId) : null;
    const to = pickFallback({
      preferred: [
        settings[session.role].provider,
        project && projectDefaultProvider(project),
        settings.agent.provider,
      ],
      providers: this.deps.runner.providers(),
      ready: await this.readyProviders(),
      limited: fallback.limited,
      now,
    });
    const at = { threadId: event.threadId, turnId: event.turnId };
    if (!to) {
      const data = { reason: "no_fallback", from: session.provider, to: null, retryAt } as const;
      this.notice(session.id, at, data, this.text(data));
      return;
    }
    this.hits.set(session.id, { retryAt, at });
    try {
      const first = this.lastSent.get(session.id);
      const created = await this.deps.roles.fallBack(session, { provider: to, fallback, first });
      if (created) this.lastSent.delete(session.id);
    } finally {
      this.hits.delete(session.id);
    }
  }

  private async readyProviders(): Promise<Set<string> | null> {
    try {
      return this.deps.ready ? new Set(await this.deps.ready()) : null;
    } catch (error) {
      this.deps.log?.(`provider switch: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * A role's session was replaced (`RoleSessions.onMoved`): tell the user when it was a switch
   * at a usage limit, or the way back after its reset. A move by setting or a fresh start is the
   * user's own doing and needs no notice.
   */
  moved(from: Session, to: Session, why: ReplaceReason): void {
    if ((why !== "limit" && why !== "reset") || from.provider === to.provider) return;
    const hit = this.hits.get(from.id);
    const data: ProviderSwitchData = {
      reason: why === "limit" ? "usage_limit" : "limit_reset",
      from: from.provider,
      to: to.provider,
      retryAt: why === "limit" ? (hit?.retryAt ?? null) : null,
    };
    const home = this.deps.repo.find(from.id)?.startMeta?.fallback?.home;
    const message = this.text(data, home);
    // In the chat that hit the limit (now archived), and in the new one once its turn starts.
    if (why === "limit" && hit) this.notice(from.id, hit.at, data, message);
    this.pending.set(to.id, { data, message });
    this.deps.inbox.put(this.inboxItem(to, message));
  }

  private name(provider: string): string {
    return this.deps.runner.providers().find((p) => p.id === provider)?.displayName ?? provider;
  }

  private text(data: ProviderSwitchData, home?: string): string {
    const names = {
      from: this.name(data.from),
      to: data.to ? this.name(data.to) : "",
      home: home ? this.name(home) : undefined,
    };
    return switchText(data, names, this.deps.timezone());
  }

  private inboxItem(to: Session, message: string): InboxItem {
    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const project = to.projectId ? this.deps.projects.get(to.projectId) : null;
    const who = project ? `${roleName("pm")} of ${project.name}` : roleName("orchestrator");
    return {
      id: switchInboxId(to.role, to.projectId),
      kind: "message",
      status: "open",
      priority: "normal",
      notify: "failure",
      title: `${who} now runs on ${this.name(to.provider)}`,
      body: message,
      projectId: to.projectId,
      sessionId: to.id,
      threadId: null,
      itemId: null,
      requestId: null,
      issue: null,
      pr: null,
      automationRunId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
  }

  private notice(sessionId: string, at: TurnRef, data: ProviderSwitchData, message: string): void {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.completed",
        threadId: at.threadId,
        turnId: at.turnId,
        item: {
          id: `provider-switch-${at.turnId}`,
          kind: "notice",
          status: "completed",
          level: data.reason === "no_fallback" ? "warning" : "info",
          code: PROVIDER_SWITCH_CODE,
          message,
          data,
        },
      }),
    ]);
  }
}
