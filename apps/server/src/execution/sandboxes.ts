import { randomBytes } from "node:crypto";
import {
  AGENT_RISHI_VERSION,
  type BackendStatus,
  type Project,
  type ProjectExecutionBackend,
  type ProviderInfo,
  type Role,
  type RunnerRecord,
  type SandboxRef,
  type Session,
  sandboxRefFor,
  type WorktreeCleanupOutcome,
} from "@agent-rishi/contracts";
import type { Db } from "../db/client";
import { findRunnerByRunnerId, listRunnerRecords } from "../events/runner-projection";
import type { RunnerHub } from "../runner/hub";
import { errorMessage, ServiceError } from "../services/errors";
import type { RunnerPort } from "../services/runner-port";
import { BackendError, type ExecutionBackend } from "./backend";
import { checkClone, deletedMessage, keptOutcome } from "./clone-check";
import { SANDBOX_HOME } from "./docker/args";

/** What sandboxes need of the runner hub: adding, finding and removing their runners. */
export type SandboxHub = Pick<RunnerHub, "add" | "remove" | "client" | "forRunnerId">;

export interface SandboxServiceDeps {
  db: Db;
  hub: SandboxHub;
  /** The Docker backend; absent where it can't be offered at all. */
  docker?: ExecutionBackend;
  /** Load the Fake provider in sandboxes' runners (when the server has it on). */
  fake: boolean;
  /** CPU and memory per sandbox (default `DEFAULT_SANDBOX_LIMITS`). */
  limits?: { cpus: number; memoryMb: number };
  /** How long a new sandbox's runner may take to answer (default 2 minutes). */
  connectTimeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Sandboxes without a backend (a server whose services were made without a runner hub): every
 * project runs locally, and nothing is added to a hub.
 */
export function noSandboxes(db: Db, runner: RunnerPort): SandboxService {
  const hub: SandboxHub = {
    add: () => {
      throw new Error("No runner hub for sandboxes");
    },
    remove: async () => undefined,
    client: () => undefined,
    forRunnerId: () => runner,
  };
  return new SandboxService({ db, hub, fake: false });
}

/** Each sandbox's CPU and memory until they are settings (`docs/remote-runners.md` §16). */
export const DEFAULT_SANDBOX_LIMITS = { cpus: 2, memoryMb: 4096 };

/** Why a provider that needs credentials can't start in a container yet (§14, phase 4b). */
export const CREDENTIALS_UNAVAILABLE =
  "Provider sign-in in containers isn't available yet (phase 4b)";

const NOT_GITHUB =
  "Docker sandboxes need a GitHub project: each container clones the repository from GitHub";

/** Poll until `done` or the deadline; true when `done` came true. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BackendError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sandboxes for agent sessions (`docs/remote-runners.md` §8, Phase 4a): a project whose
 * `execution.backend` is `docker` gets a container of its own for each new agent session, with
 * the whole runner inside, reached through an exec link. The orchestrator, PMs and sessions
 * without a project stay on the home runner.
 */
export class SandboxService {
  /** Settles once the sandboxes from before a server restart are linked again (`reattach`). */
  reattached: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SandboxServiceDeps) {}

  /** Every backend and whether it can be used now; for `project`, also whether it may. */
  async statuses(project?: Project, opts: { refresh?: boolean } = {}): Promise<BackendStatus[]> {
    const local: BackendStatus = {
      backend: "local",
      available: true,
      code: "ok",
      version: null,
      reason: null,
      fix: null,
    };
    return [local, await this.dockerStatus(project, opts)];
  }

  private async dockerStatus(
    project?: Project,
    opts: { refresh?: boolean } = {},
  ): Promise<BackendStatus> {
    const { docker } = this.deps;
    if (!docker) {
      return {
        backend: "docker",
        available: false,
        code: "detect_failed",
        version: null,
        reason: "Docker sandboxes are not available in this copy of Agent Rishi",
        fix: null,
      };
    }
    const status = await docker.detect(opts).catch(
      (error: unknown): BackendStatus => ({
        backend: "docker",
        available: false,
        code: "detect_failed",
        version: null,
        reason: `Docker could not be checked: ${errorMessage(error)}`,
        fix: null,
      }),
    );
    if (status.available && project && project.kind !== "github") {
      return { ...status, available: false, code: "unsupported_project", reason: NOT_GITHUB };
    }
    return status;
  }

  /** Refuse switching `project` to `backend` when it can't use it, with the reason (PATCH). */
  async assertUsable(project: Project, backend: ProjectExecutionBackend): Promise<void> {
    if (backend === "local" || project.execution.backend === backend) return;
    const status = await this.dockerStatus(project, { refresh: true });
    if (!status.available) {
      const reason = [status.reason, status.fix].filter(Boolean).join(". ");
      throw new ServiceError(400, "backend_unavailable", reason || "Docker isn't available");
    }
  }

  /** Whether a session of `role` in `project` would run in a sandbox. */
  private sandboxed(role: Role, project: Project | null): boolean {
    return role === "agent" && project?.execution.backend === "docker";
  }

  /**
   * Refuse a new session that can't run in its project's sandbox: a project that isn't on GitHub,
   * or a provider that needs credentials (none reach containers yet). A provider the home runner
   * hasn't loaded is checked again when the session starts.
   */
  assertStartable(role: Role, project: Project | null, provider: ProviderInfo | undefined): void {
    if (!project || !this.sandboxed(role, project)) return;
    if (project.kind !== "github") throw new ServiceError(400, "backend_unavailable", NOT_GITHUB);
    if (provider && !provider.capabilities.credentialFree) {
      throw new ServiceError(400, "sandbox_credentials_unavailable", CREDENTIALS_UNAVAILABLE);
    }
  }

  /**
   * Whether this start makes the session a sandbox: an agent session in a `docker` project that
   * has no runner yet. A fork stays on its source's runner, where the copied conversation is.
   */
  wants(session: Session, project: Project | null, opts: { fork?: boolean } = {}): boolean {
    return this.sandboxed(session.role, project) && !session.runnerId && !opts.fork;
  }

  /**
   * Make the session's sandbox and connect to its runner: check Docker, build the image if
   * needed, start a container, link to it and wait for the runner's handshake and MCP proxy.
   * Returns the runner's journal id, for `sessions.runnerId`. On failure, what was made is
   * removed and the error says what went wrong. `home` is the session's provider as the home
   * runner loaded it; unknown there, the sandbox's own runner decides.
   */
  async place(
    session: Session,
    project: Project,
    home: Pick<ProviderInfo, "capabilities"> | undefined,
  ): Promise<string> {
    const docker = this.deps.docker;
    const status = await this.dockerStatus(project);
    if (!docker || !status.available) {
      const reason = [status.reason, status.fix].filter(Boolean).join(". ");
      throw new ServiceError(503, "backend_unavailable", reason || "Docker isn't available");
    }
    if (home && !home.capabilities.credentialFree) {
      throw new ServiceError(400, "sandbox_credentials_unavailable", CREDENTIALS_UNAVAILABLE);
    }
    const { image } = await docker.prepare((line) => this.deps.log?.(`docker: ${line}`));
    const limits = this.deps.limits ?? DEFAULT_SANDBOX_LIMITS;
    const recordId = `${session.id.slice(0, 8)}-${randomBytes(3).toString("hex")}`;
    const ref = await docker.provision({
      recordId,
      sessionId: session.id,
      projectId: project.id,
      image,
      cpus: limits.cpus,
      memoryMb: limits.memoryMb,
      fake: this.deps.fake,
    });
    try {
      const { runnerId, providers } = await this.connect(docker, recordId, ref, session, project);
      // The sandbox's runner hosts only providers that need no credentials (phase 4a).
      if (!providers.includes(session.provider)) {
        throw new ServiceError(400, "sandbox_credentials_unavailable", CREDENTIALS_UNAVAILABLE);
      }
      return runnerId;
    } catch (error) {
      await this.deps.hub.remove(recordId, { deleted: true }).catch(() => undefined);
      await docker.remove(ref).catch(() => undefined);
      throw error;
    }
  }

  /** Add the sandbox's runner to the hub and wait until it is connected and configured. */
  private async connect(
    docker: ExecutionBackend,
    recordId: string,
    ref: SandboxRef,
    session: Pick<Session, "id">,
    project: Pick<Project, "id">,
  ): Promise<{ runnerId: string; providers: string[] }> {
    const client = this.addRunner(docker, recordId, ref, {
      sessionId: session.id,
      projectId: project.id,
      imageVersion: AGENT_RISHI_VERSION,
    });
    const ms = this.deps.connectTimeoutMs ?? 120_000;
    await withTimeout(
      client.start(),
      ms,
      `The runner in ${ref.container} did not answer within ${Math.round(ms / 1000)} s`,
    );
    const runnerId = client.status.runnerId;
    if (!runnerId) throw new BackendError(`The runner in ${ref.container} reported no id`);
    // The MCP proxy is configured right after the handshake; the session's tools need it.
    await waitFor(() => client.mcpProxyUrl !== null, 15_000);
    return { runnerId, providers: client.status.providers.map((p) => p.id) };
  }

  private addRunner(
    docker: ExecutionBackend,
    recordId: string,
    ref: SandboxRef,
    owner: { sessionId: string | null; projectId: string | null; imageVersion: string | null },
  ) {
    return this.deps.hub.add({
      id: recordId,
      backend: docker.id,
      link: docker.openLink(ref),
      // Reached only through the link: there is no lock file on this machine to find.
      dir: SANDBOX_HOME,
      lockFile: `${SANDBOX_HOME}/runner/runner.json`,
      launch: null,
      sandboxRef: ref.container,
      projectId: owner.projectId,
      sessionId: owner.sessionId,
      imageVersion: owner.imageVersion,
    });
  }

  /**
   * After a server restart: link again to every sandbox that wasn't deleted, starting its
   * container first when it had stopped. Sessions then continue in the same container and the
   * client resumes the runner's journal from its ack position. A container that is gone marks
   * its runner deleted, so its sessions fail naming it.
   */
  reattach(): Promise<void> {
    this.reattached = this.reattachAll().catch((error: unknown) =>
      this.deps.log?.(`sandboxes: reattach failed: ${errorMessage(error)}`),
    );
    return this.reattached;
  }

  private async reattachAll(): Promise<void> {
    const docker = this.deps.docker;
    const records = listRunnerRecords(this.deps.db).filter(
      (r) => r.backend === "docker" && r.state !== "deleted" && r.sandboxRef,
    );
    for (const record of records) {
      if (this.deps.hub.client(record.id)) continue;
      if (!docker) {
        this.deps.log?.(`sandboxes: ${record.id} needs Docker, which this copy can't drive`);
        continue;
      }
      const ref = sandboxRefFor(record.sandboxRef as string);
      try {
        const state = await docker.state(ref);
        if (state === null) {
          this.deps.log?.(`sandboxes: ${ref.container} is gone; runner ${record.id} deleted`);
          await this.deps.hub.remove(record.id, { deleted: true });
          continue;
        }
        if (state === "exited") await docker.start(ref);
      } catch (error) {
        // Docker isn't reachable now: link anyway, the client retries until it is.
        this.deps.log?.(`sandboxes: checking ${ref.container}: ${errorMessage(error)}`);
      }
      const client = this.addRunner(docker, record.id, ref, record);
      client
        .start()
        .catch((error: unknown) =>
          this.deps.log?.(`sandboxes: ${record.id}: ${errorMessage(error)}`),
        );
    }
  }

  /** The live sandbox runner record of a session, if it runs in one. */
  recordFor(session: Pick<Session, "runnerId">): RunnerRecord | undefined {
    if (!session.runnerId) return undefined;
    const record = findRunnerByRunnerId(this.deps.db, session.runnerId);
    if (!record || record.home || record.backend === "local" || record.state === "deleted") {
      return undefined;
    }
    return record.sandboxRef ? record : undefined;
  }

  /**
   * Remove an archived session's sandbox: its container and volume, with the clone in it. The
   * clone is the only copy of what it hasn't pushed (#337), so uncommitted changes, unpushed
   * commits and stashes keep the sandbox unless `force`, and so does a clone that can't be
   * checked: a stopped container is started to check it, and if that fails nothing is deleted.
   * A forced removal says what it deleted. Null when the session has no sandbox.
   */
  async release(
    session: Session,
    opts: { force: boolean },
  ): Promise<WorktreeCleanupOutcome | null> {
    const record = this.recordFor(session);
    if (!record) return null;
    const docker = this.deps.docker;
    if (!docker) {
      return { status: "failed", message: "Docker sandboxes can't be removed by this copy" };
    }
    const ref = sandboxRefFor(record.sandboxRef as string);
    const check = await checkClone({
      runner: this.deps.hub.forRunnerId(session.runnerId as string),
      docker,
      ref,
      cwd: session.cwd,
      // Forced: what is connected is checked, to say what is deleted; nothing is started for it.
      wakeMs: opts.force ? 0 : (this.deps.connectTimeoutMs ?? 120_000),
    });
    if (!opts.force) {
      const kept = keptOutcome(check);
      if (kept) {
        this.deps.log?.(
          `sandboxes: kept ${ref.container} of session ${session.id}: ${kept.message}`,
        );
        return kept;
      }
    }
    try {
      await this.deps.hub.remove(record.id);
      await docker.remove(ref);
    } catch (error) {
      return { status: "failed", message: errorMessage(error) };
    }
    await this.deps.hub.remove(record.id, { deleted: true });
    const deleted = deletedMessage(check);
    this.deps.log?.(
      `sandboxes: removed ${ref.container} with session ${session.id}${deleted ? ` (${deleted})` : ""}`,
    );
    return {
      status: "removed",
      message: deleted,
      ...(check.kind === "work" ? { unpushed: check.work } : {}),
    };
  }
}
