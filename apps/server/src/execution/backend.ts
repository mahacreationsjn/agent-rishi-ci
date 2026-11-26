import type {
  BackendStatus,
  SandboxRef,
  SandboxSpec,
  SandboxSummary,
} from "@agent-rishi/contracts";
import type { ExecLinkConfig } from "../runner/transport-exec";

/**
 * An execution backend (`docs/remote-runners.md` §5): it makes, starts, stops and removes
 * sandboxes, each running a whole runner, and opens a link to the runner inside one. The server
 * reaches that runner only through the link (`agent-rishi runner-link`), never a port.
 */
export interface ExecutionBackend {
  readonly id: SandboxRef["backend"];
  /** Whether the backend can be used on this machine, with the reason and the fix when not. */
  detect(opts?: { refresh?: boolean }): Promise<BackendStatus>;
  /**
   * Make what sandboxes are run from (the runner image), once per version and bundle. Slow the
   * first time; `onProgress` gets a line to show while it runs.
   */
  prepare(onProgress?: (line: string) => void): Promise<{ image: string }>;
  /** Make a sandbox for `spec` and start the runner in it. Nothing is left behind on failure. */
  provision(spec: SandboxSpec): Promise<SandboxRef>;
  /** A link to the sandbox's runner; each (re)connect starts a new link process. */
  openLink(ref: SandboxRef): ExecLinkConfig;
  /** The sandbox's state: `null` when it no longer exists. */
  state(ref: SandboxRef): Promise<SandboxSummary["state"] | null>;
  /** Start a stopped sandbox (its runner starts with it). */
  start(ref: SandboxRef): Promise<void>;
  /** Stop a sandbox, keeping its disk. */
  stop(ref: SandboxRef): Promise<void>;
  /** Remove a sandbox and its disk. A sandbox that is already gone is no error. */
  remove(ref: SandboxRef): Promise<void>;
  /** This install's sandboxes, by their labels. */
  list(): Promise<SandboxSummary[]>;
}

/** A backend operation failed; `message` is safe to show (it never holds a credential). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: BackendStatus["code"] | "command_failed" = "command_failed",
  ) {
    super(message);
    this.name = "BackendError";
  }
}
