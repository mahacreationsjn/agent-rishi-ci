import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HealthResponse, ServerLock } from "@agent-rishi/contracts";

/** Files the desktop app reads in the Agent Rishi home (same layout as the server's `homePaths`). */
export function homeFiles(home: string) {
  return {
    token: join(home, "install-token"),
    serverLock: join(home, "server.json"),
    runnerLock: join(home, "runner", "runner.json"),
    logs: join(home, "logs"),
    /** The app's Chromium profile, window state and logs live here, next to the data. */
    desktop: join(home, "desktop"),
  };
}

/** Either attach to a live server for this home (started by `agent-rishi`), or start our own. */
export type ServerPlan = { kind: "attach"; lock: ServerLock } | { kind: "start" };

export interface PlanDeps {
  readLock(file: string): unknown;
  isAlive(pid: number): boolean;
  /** `/api/health` on that port answers as Agent Rishi. */
  healthy(port: number): Promise<boolean>;
}

/**
 * Decide how to get a server (§17): the same home as `agent-rishi` means the same data, so a
 * server already running for it (lock file, live pid, answering `/api/health`) is reused;
 * otherwise the app starts one. A stale or unreadable lock means start.
 */
export async function planServer(home: string, deps: PlanDeps = defaultDeps): Promise<ServerPlan> {
  const lock = liveLock(home, deps);
  if (!lock) return { kind: "start" };
  return (await deps.healthy(lock.port)) ? { kind: "attach", lock } : { kind: "start" };
}

/**
 * Whether Help > Retry may connect again for an attached server that stopped answering: when
 * that server is gone, or the home's server answers (perhaps on another port). A server that
 * still runs but doesn't answer (busy or stuck) is kept, so a retry never starts a second
 * server on the same data beside it.
 */
export async function mayReconnect(home: string, deps: PlanDeps = defaultDeps): Promise<boolean> {
  const lock = liveLock(home, deps);
  return lock === null || (await deps.healthy(lock.port));
}

/** The home's server lock, when it parses and names a live process. */
function liveLock(home: string, deps: PlanDeps): ServerLock | null {
  const parsed = ServerLock.safeParse(deps.readLock(homeFiles(home).serverLock));
  return parsed.success && deps.isAlive(parsed.data.pid) ? parsed.data : null;
}

/** The install token, or null when the home has none yet (the server creates it). */
export function readToken(home: string): string | null {
  try {
    const token = readFileSync(homeFiles(home).token, "utf8").trim();
    return token.length >= 32 ? token : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultDeps: PlanDeps = {
  readLock(file) {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  },
  isAlive: isProcessAlive,
  healthy: (port) => serverHealthy(`http://127.0.0.1:${port}`),
};

export async function serverHealthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/health", url), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok && HealthResponse.safeParse(await res.json()).success;
  } catch {
    return false;
  }
}
