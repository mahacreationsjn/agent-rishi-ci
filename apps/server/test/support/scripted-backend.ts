import { PassThrough } from "node:stream";
import {
  type BackendStatus,
  type SandboxRef,
  type SandboxSpec,
  type SandboxSummary,
  sandboxRefFor,
} from "@agent-rishi/contracts";
import type { ExecutionBackend } from "../../src/execution/backend";
import type { ExecLinkConfig, LinkProcess } from "../../src/runner/transport-exec";
import { startInProcessLink } from "./in-process-link";

/** The link to a stopped container: `docker exec` fails at once. */
function deadLink(): LinkProcess {
  const stdout = new PassThrough();
  stdout.end();
  return {
    stdin: new PassThrough(),
    stdout,
    stderr: null,
    kill: () => undefined,
    onExit: (listener) => setImmediate(() => listener(1)),
  };
}

export const DOCKER_OK: BackendStatus = {
  backend: "docker",
  available: true,
  code: "ok",
  version: "29.6.1",
  reason: null,
  fix: null,
};

/**
 * A Docker backend without Docker: every sandbox it "provisions" is the in-process runner in
 * `runnerHome`, reached over an in-process exec link (`agent-rishi runner-link`'s code). Records
 * what was asked of it.
 */
export class ScriptedBackend implements ExecutionBackend {
  readonly id = "docker" as const;
  calls: string[] = [];
  specs: SandboxSpec[] = [];
  removed: SandboxRef[] = [];
  status: BackendStatus = DOCKER_OK;
  /** Thrown by `provision` when set. */
  failProvision: Error | null = null;
  /** Thrown by `start` when set. */
  failStart: Error | null = null;
  /** What `state` reports for every sandbox; `start` makes it `running`. */
  sandboxState: SandboxSummary["state"] | null = "running";
  /** Links opened (one per connection). */
  links = 0;
  /** The runner home each sandbox links to, fixed when it is provisioned. */
  private readonly homes = new Map<string, string>();
  /** Links that are open now. */
  private readonly open = new Set<LinkProcess>();

  /**
   * The container stops, as if it crashed: its links end, and new ones end at once until `start`
   * (the runner itself keeps running in this process).
   */
  stopSandbox(): void {
    this.sandboxState = "exited";
    for (const link of this.open) link.kill();
    this.open.clear();
  }

  /** `runnerHome`: the in-process runner the next sandbox provisioned is. */
  constructor(public runnerHome: string) {}

  async detect(): Promise<BackendStatus> {
    this.calls.push("detect");
    return this.status;
  }

  async prepare(): Promise<{ image: string }> {
    this.calls.push("prepare");
    return { image: "agent-rishi-runner:test" };
  }

  async provision(spec: SandboxSpec): Promise<SandboxRef> {
    this.calls.push("provision");
    this.specs.push(spec);
    if (this.failProvision) throw this.failProvision;
    const ref = sandboxRefFor(`agent-rishi-${spec.recordId}`);
    this.homes.set(ref.container, this.runnerHome);
    this.sandboxState = "running";
    return ref;
  }

  openLink(ref: SandboxRef): ExecLinkConfig {
    const home = this.homes.get(ref.container) ?? this.runnerHome;
    return {
      kind: "exec",
      start: () => {
        this.links++;
        if (this.sandboxState !== "running") return deadLink();
        const link = startInProcessLink(home);
        this.open.add(link);
        link.onExit(() => this.open.delete(link));
        return link;
      },
    };
  }

  async state(): Promise<SandboxSummary["state"] | null> {
    this.calls.push("state");
    return this.sandboxState;
  }

  async start(): Promise<void> {
    this.calls.push("start");
    if (this.failStart) throw this.failStart;
    this.sandboxState = "running";
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    this.sandboxState = "exited";
  }

  async remove(ref: SandboxRef): Promise<void> {
    this.calls.push("remove");
    this.removed.push(ref);
    this.sandboxState = null;
  }

  async list(): Promise<SandboxSummary[]> {
    return [];
  }
}
