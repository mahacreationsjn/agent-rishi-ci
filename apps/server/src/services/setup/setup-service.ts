import type {
  LoginCommandResponse,
  ProviderStatus,
  SetupCheck,
  SetupStatus,
  SetupToolId,
} from "@agent-rishi/contracts";
import { defaultShell, findExecutable, refreshProcessPath } from "@agent-rishi/providers";
import type { SettingsStore } from "../../settings-store";
import { errorMessage } from "../errors";
import type { Exec } from "../exec";
import type { BrowserProbe } from "./browsers";
import { base } from "./check-base";
import { CHECKS, type CheckEnv, type ToolCheckId } from "./checks";
import {
  isProviderCheck,
  PROVIDER_CHECKS,
  type ProviderCheckId,
  providerCheck,
  terminalProgram,
} from "./provider-checks";
import {
  type DetectProviders,
  localProviderDetection,
  PROVIDER_DETECT_TIMEOUT_MS,
} from "./provider-detection";
import { LOGIN_COMMANDS, type Locate, type LoginTool, loginCommandLine } from "./tool-lookup";

export interface SetupServiceDeps {
  exec: Exec;
  settings: Pick<SettingsStore, "get" | "update">;
  /** Per-check timeout for the other tools (default 20s); a slow CLI never blocks the checklist. */
  checkTimeoutMs?: number;
  /**
   * The agent providers' detection, each status with its level (Foundation §4.3): the runner's,
   * which setup only displays (default: the same detection in this process, for `doctor`).
   */
  detectProviders?: DetectProviders;
  /** How long the providers' detection may take, model lists included (default 90s). */
  detectTimeoutMs?: number;
  /** Cached results are reused for this long unless a refresh is requested (default 5 min). */
  cacheMs?: number;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  browserProbe?: Partial<BrowserProbe>;
  now?: () => number;
  /** Finds gh (default: PATH, then its known install locations). */
  locate?: Locate;
  /** The user's home folder, for known install locations (default: `os.homedir()`). */
  userHome?: string;
  /**
   * Picks up PATH changes made since Agent Rishi started, before an explicit re-check (default:
   * the Windows registry's user and machine `Path`; nothing elsewhere).
   */
  refreshPath?: () => Promise<unknown>;
  /** The setup terminal's shell, for sign-in commands (default: `defaultShell()`). */
  shell?: string;
  /** Called after every completed check (not for cached results). */
  onChecked?: (status: SetupStatus) => void;
}

const ORDER: SetupToolId[] = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "antigravity",
  "gh",
  "git",
  "browser",
  "node",
];
/** The other tools, checked here. */
const TOOL_CHECKS = ORDER.filter((id): id is ToolCheckId => !isProviderCheck(id));

/** Agent providers: setup is ready when at least one is `verified`. */
export { PROVIDER_CHECKS };

/**
 * First-run setup and re-checks on launch (§14). Runs every detection in parallel with a
 * timeout each, caches the result, and records which tools changed state since the last run.
 */
export class SetupService {
  private cached: SetupStatus | undefined;
  private running: Promise<SetupStatus> | undefined;

  constructor(private readonly deps: SetupServiceDeps) {}

  /** The last detection result, without re-checking (undefined before the first check). */
  get lastStatus(): SetupStatus | undefined {
    return this.cached;
  }

  /** Cached status, re-checked when stale or when `refresh` is set. */
  async status(opts: { refresh?: boolean } = {}): Promise<SetupStatus> {
    const now = this.now();
    const fresh =
      this.cached && now - Date.parse(this.cached.checkedAt) < (this.deps.cacheMs ?? 300_000);
    if (this.cached && fresh && !opts.refresh) {
      return { ...this.cached, setupCompleted: this.deps.settings.get().setup.completed };
    }
    this.running ??= this.refreshThenCheck(opts.refresh === true).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Persist that the user finished the checklist. */
  complete(): SetupStatus["setupCompleted"] {
    this.deps.settings.update({
      setup: { completed: true, completedAt: new Date().toISOString() },
    });
    return true;
  }

  /**
   * The command to run in a terminal to sign `tool` in: the copy the last check found, by
   * its full path, so the terminal's own PATH lookup is not involved.
   */
  loginCommand(tool: LoginTool): LoginCommandResponse {
    const check = this.cached?.checks.find((c) => c.id === tool);
    const program = check?.installed ? terminalProgram(check.executablePath) : null;
    const args = LOGIN_COMMANDS[tool].slice(1);
    return { tool, command: loginCommandLine(tool, this.shell(), program), args };
  }

  private async refreshThenCheck(refresh: boolean): Promise<SetupStatus> {
    if (refresh) {
      try {
        await (this.deps.refreshPath ?? refreshProcessPath)();
      } catch {
        // Checks run with the PATH this process has.
      }
    }
    return this.runChecks();
  }

  private shell(): string {
    return this.deps.shell ?? defaultShell();
  }

  private async runChecks(): Promise<SetupStatus> {
    const userHome = this.deps.userHome;
    const env: CheckEnv = {
      exec: this.deps.exec,
      locate:
        this.deps.locate ?? ((name, opts) => findExecutable(name, { home: userHome, ...opts })),
      shell: this.shell(),
      platform: this.deps.platform ?? process.platform,
      nodeVersion: this.deps.nodeVersion ?? process.version,
      now: this.now(),
      browserProbe: this.deps.browserProbe,
      ...(userHome ? { userHome } : {}),
    };
    const [providers, tools] = await Promise.all([
      this.providerRows(env),
      Promise.all(TOOL_CHECKS.map((id) => this.timed(id, env))),
    ]);
    const found = new Map<SetupToolId, SetupCheck>([...providers, ...tools].map((c) => [c.id, c]));
    const checks = ORDER.flatMap((id) => found.get(id) ?? []);
    const previous = this.cached;
    const warnings = checks
      .filter((c) => c.state === "warning" || this.regressed(previous, c))
      .map((c) => ({ id: c.id, message: c.message }));
    const status: SetupStatus = {
      checkedAt: new Date(this.now()).toISOString(),
      setupCompleted: this.deps.settings.get().setup.completed,
      // Only a verified provider is ready: a real check passed with its login (§4.3).
      ready: checks.some((c) => isProviderCheck(c.id) && c.level === "verified"),
      checks,
      warnings,
    };
    this.cached = status;
    try {
      this.deps.onChecked?.(status);
    } catch {
      // A failing listener must not fail the check.
    }
    return status;
  }

  private regressed(previous: SetupStatus | undefined, check: SetupCheck): boolean {
    const before = previous?.checks.find((c) => c.id === check.id);
    return before?.state === "ok" && check.state === "missing";
  }

  /**
   * The providers' rows from the one detection: a row for each provider it reports. When the
   * detection fails or times out, every provider row says so.
   */
  private async providerRows(env: CheckEnv): Promise<SetupCheck[]> {
    const started = this.now();
    let statuses: ProviderStatus[];
    try {
      statuses = await withTimeout(
        (this.deps.detectProviders ?? localProviderDetection)(),
        this.deps.detectTimeoutMs ?? PROVIDER_DETECT_TIMEOUT_MS,
      );
    } catch (error) {
      const durationMs = Math.max(0, this.now() - started);
      return PROVIDER_CHECKS.map((id) => failedCheck(id, error, durationMs));
    }
    const durationMs = Math.max(0, this.now() - started);
    return statuses.flatMap((status) => {
      const id = status.providerId;
      if (!isProviderCheck(id)) return [];
      return [{ ...providerCheck(id as ProviderCheckId, status, env), durationMs }];
    });
  }

  private async timed(id: ToolCheckId, env: CheckEnv): Promise<SetupCheck> {
    const started = this.now();
    try {
      const result = await withTimeout(CHECKS[id](env), this.deps.checkTimeoutMs ?? 20_000);
      return { ...result, durationMs: Math.max(0, this.now() - started) };
    } catch (error) {
      return failedCheck(id, error, Math.max(0, this.now() - started));
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** A check that failed or timed out, with the reason. */
function failedCheck(id: SetupToolId, error: unknown, durationMs: number): SetupCheck {
  return {
    ...base(id),
    state: "error",
    message: `Check failed: ${errorMessage(error)}`,
    durationMs,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
