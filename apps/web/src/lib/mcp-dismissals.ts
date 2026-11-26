import type { McpServerState, Session } from "@agent-rishi/contracts";
import { useSyncExternalStore } from "react";
import { AGENT_RISHI_MCP_SERVER } from "@/lib/mcp-status";

/**
 * The MCP notice's dismissals in this browser: `{ [scope]: ["<state>:<name>", ...] }`, the
 * least recently dismissed scope first. A scope is a project (`project:<id>`, `project:` for
 * sessions without one), or a session (`session:<id>`) for Agent Rishi's own server.
 */
const KEY = "agent-rishi.mcp-notice-dismissed";
/** Scopes remembered; the least recently dismissed go first. */
const MAX_SCOPES = 100;
/** Dismissed servers remembered per scope; the oldest go first. */
const MAX_PER_SCOPE = 50;

type Dismissals = Record<string, string[]>;

/** What this page dismissed, for when localStorage can't be written (private mode, quota). */
let memory: Dismissals = {};
let storageWorks = true;
let version = 0;
const listeners = new Set<() => void>();

/**
 * Which scope a dismissal of `server` belongs to: the session for Agent Rishi's own server, whose
 * trouble each session must hear about (without it the agent can't ask or report back), else
 * the project, so a server dismissed once stays quiet in all of the project's sessions.
 */
function scopeOf(session: Pick<Session, "id" | "projectId">, server: Pick<McpServerState, "name">) {
  return server.name === AGENT_RISHI_MCP_SERVER
    ? `session:${session.id}`
    : `project:${session.projectId ?? ""}`;
}

/** A server's name and state: it shows again once it is in trouble in another way. */
const entryOf = (s: Pick<McpServerState, "name" | "state">) => `${s.state}:${s.name}`;

function parse(raw: string | null): Dismissals {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Dismissals = {};
    for (const [scope, entries] of Object.entries(value)) {
      if (Array.isArray(entries)) out[scope] = entries.filter((e) => typeof e === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function load(): Dismissals {
  if (!storageWorks) return memory;
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return memory;
  }
}

function save(next: Dismissals): void {
  memory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    storageWorks = true;
  } catch {
    // private mode or full: remembered for this page only
    storageWorks = false;
  }
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab dismissed: show the same.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    version++;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

const getVersion = () => version;

/** The session's MCP problems not dismissed in this browser, in their order. */
export function undismissedMcpProblems(
  session: Pick<Session, "id" | "projectId">,
  problems: readonly McpServerState[],
): McpServerState[] {
  if (problems.length === 0) return [];
  const saved = load();
  return problems.filter((s) => !saved[scopeOf(session, s)]?.includes(entryOf(s)));
}

/**
 * `undismissedMcpProblems`, re-rendering when a notice anywhere on the page (or in another
 * tab) is dismissed.
 */
export function useUndismissedMcpProblems(
  session: Pick<Session, "id" | "projectId">,
  problems: readonly McpServerState[],
): McpServerState[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return undismissedMcpProblems(session, problems);
}

/** Remember that the user dismissed the notice naming `servers` in `session`. */
export function dismissMcpProblems(
  session: Pick<Session, "id" | "projectId">,
  servers: readonly McpServerState[],
): void {
  const saved = { ...load() };
  for (const server of servers) {
    const scope = scopeOf(session, server);
    const entry = entryOf(server);
    const entries = (saved[scope] ?? []).filter((e) => e !== entry);
    entries.push(entry);
    // Re-inserted, so the scope moves to the end: the most recently dismissed.
    delete saved[scope];
    saved[scope] = entries.slice(-MAX_PER_SCOPE);
  }
  const scopes = Object.keys(saved);
  for (const old of scopes.slice(0, Math.max(0, scopes.length - MAX_SCOPES))) delete saved[old];
  save(saved);
}
