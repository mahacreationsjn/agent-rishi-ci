import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_RISHI_VERSION,
  type BackendStatus,
  type SandboxRef,
  type SandboxSpec,
  type SandboxSummary,
  sandboxRefFor,
} from "@agent-rishi/contracts";
import { type ExecLinkConfig, execLink } from "../../runner/transport-exec";
import { type Exec, type ExecResult, resolveExecutable, runTool } from "../../services/exec";
import { BackendError, type ExecutionBackend } from "../backend";
import {
  buildArgs,
  execLinkArgs,
  firstLine,
  gitIdentityArgs,
  imageLabelsArgs,
  imageName,
  inspectStateArgs,
  isNoSuchObject,
  LABEL,
  listArgs,
  parseLabels,
  parseList,
  parseState,
  parseVersion,
  removeArgs,
  runArgs,
  startArgs,
  stopArgs,
  versionArgs,
  volumeCreateArgs,
  volumeRemoveArgs,
} from "./args";
import { contextHash, findImageSource, type ImageSource, writeContext } from "./image";

export interface DockerBackendOptions {
  /** Agent Rishi's data directory: this install's id lives in it (`install-id`). */
  home: string;
  /** Runs `docker` (tests script it). */
  exec?: Exec;
  /** The `docker` command (default: `docker` on PATH). */
  command?: string;
  /** The Agent Rishi version the image and labels carry (default: this build's). */
  version?: string;
  /** Where the image is built from (default: this package's own bundle). */
  imageSource?: () => ImageSource | null;
  /** The user's git name and email, given to commits in sandboxes; none: the image's own. */
  gitIdentity?: () => Promise<{ name?: string | null; email?: string | null }>;
  /** How long a detect result is reused (default 30 s). */
  detectTtlMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const QUICK_MS = 30_000;
const RUN_MS = 2 * 60_000;
const BUILD_MS = 20 * 60_000;

/** This install's id, made once and kept in `<home>/install-id`; labels every sandbox. */
export function installId(home: string): string {
  const file = join(home, "install-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{12}$/.test(id)) return id;
  } catch {
    // Not made yet.
  }
  const id = randomBytes(6).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${id}\n`);
  return id;
}

/** The container name for a runner record: `agent-rishi-<record id>`. */
export function containerNameFor(recordId: string): string {
  return `agent-rishi-${recordId}`;
}

/**
 * The `docker` execution backend (`docs/remote-runners.md` §5.2): a container per agent session
 * with the whole runner inside, driven through the `docker` CLI. That works with Docker Desktop,
 * Docker Engine on Linux, and `DOCKER_HOST` or contexts pointing at another machine.
 */
export class DockerBackend implements ExecutionBackend {
  readonly id = "docker" as const;
  private readonly exec: Exec;
  private readonly version: string;
  private detected: { at: number; status: BackendStatus } | undefined;
  private preparing: Promise<{ image: string }> | undefined;
  private install: string | undefined;

  constructor(private readonly opts: DockerBackendOptions) {
    this.exec = opts.exec ?? runTool;
    this.version = opts.version ?? AGENT_RISHI_VERSION;
  }

  private get command(): string {
    return this.opts.command ?? "docker";
  }

  private installLabel(): string {
    this.install ??= installId(this.opts.home);
    return this.install;
  }

  private run(args: string[], timeoutMs = QUICK_MS, maxOutput?: number): Promise<ExecResult> {
    return this.exec(this.command, args, { timeoutMs, ...(maxOutput ? { maxOutput } : {}) });
  }

  /** Run a command that must succeed; its error output's first line explains a failure. */
  private async must(what: string, args: string[], timeoutMs = QUICK_MS): Promise<ExecResult> {
    const result = await this.run(args, timeoutMs);
    if (result.notFound) throw new BackendError("Docker not found", "not_found");
    if (result.timedOut) throw new BackendError(`Docker timed out while ${what}`);
    if (result.code !== 0) {
      throw new BackendError(`Docker failed ${what}: ${firstLine(result.stderr) || "no output"}`);
    }
    return result;
  }

  async detect(opts: { refresh?: boolean } = {}): Promise<BackendStatus> {
    const now = this.opts.now?.() ?? Date.now();
    const ttl = this.opts.detectTtlMs ?? 30_000;
    if (!opts.refresh && this.detected && now - this.detected.at < ttl) return this.detected.status;
    const result = await this.run(versionArgs(), 15_000);
    const status = parseVersion(result);
    this.detected = { at: now, status };
    return status;
  }

  prepare(onProgress?: (line: string) => void): Promise<{ image: string }> {
    // One build at a time: sessions starting together wait for the same image.
    this.preparing ??= this.ensureImage(onProgress).finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  private async ensureImage(onProgress?: (line: string) => void): Promise<{ image: string }> {
    const source = (this.opts.imageSource ?? findImageSource)();
    if (!source) {
      throw new BackendError(
        "This copy of Agent Rishi can't build the runner image: build the CLI first (pnpm build), or run Agent Rishi from the agent-rishi package",
      );
    }
    const image = imageName(this.version);
    const build = contextHash(source, this.version);
    const inspected = await this.run(imageLabelsArgs(image));
    const labels = inspected.code === 0 ? parseLabels(inspected.stdout) : null;
    if (labels?.[LABEL.build] === build) return { image };
    onProgress?.(`Building the runner image ${image} (the first time takes a few minutes)`);
    this.opts.log?.(`docker: building ${image} (build ${build})`);
    const context = mkdtempSync(join(tmpdir(), "agent-rishi-image-"));
    try {
      writeContext(source, context, this.version);
      const result = await this.run(
        buildArgs({ image, context, version: this.version, build }),
        BUILD_MS,
        4 * 1024 * 1024,
      );
      if (result.code !== 0) {
        const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
        throw new BackendError(
          result.timedOut
            ? `Building ${image} timed out`
            : `Building ${image} failed: ${tail || "no output"}`,
        );
      }
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
    this.opts.log?.(`docker: built ${image}`);
    return { image };
  }

  async provision(spec: SandboxSpec): Promise<SandboxRef> {
    const ref = sandboxRefFor(containerNameFor(spec.recordId));
    const install = this.installLabel();
    try {
      await this.must("making a volume", volumeCreateArgs(ref, spec, install, this.version));
      await this.must("starting the container", runArgs(ref, spec, install, this.version), RUN_MS);
    } catch (error) {
      await this.remove(ref).catch(() => undefined);
      throw error;
    }
    await this.setGitIdentity(ref);
    this.opts.log?.(`docker: started ${ref.container} for session ${spec.sessionId}`);
    return ref;
  }

  /** Give commits in the sandbox the user's git name and email; the image's own otherwise. */
  private async setGitIdentity(ref: SandboxRef): Promise<void> {
    const identity = await this.opts.gitIdentity?.().catch(() => undefined);
    for (const key of ["name", "email"] as const) {
      const value = identity?.[key]?.trim();
      if (!value) continue;
      const result = await this.run(gitIdentityArgs(ref, key, value));
      if (result.code !== 0) {
        this.opts.log?.(`docker: could not set git user.${key} in ${ref.container}`);
      }
    }
  }

  openLink(ref: SandboxRef): ExecLinkConfig {
    const command = resolveExecutable(this.command) ?? this.command;
    return execLink(command, execLinkArgs(ref));
  }

  async state(ref: SandboxRef): Promise<SandboxSummary["state"] | null> {
    const result = await this.run(inspectStateArgs(ref));
    if (result.notFound) throw new BackendError("Docker not found", "not_found");
    if (result.code === 0) return parseState(result.stdout);
    if (isNoSuchObject(result.stderr)) return null;
    throw new BackendError(`Docker failed checking ${ref.container}: ${firstLine(result.stderr)}`);
  }

  async start(ref: SandboxRef): Promise<void> {
    await this.must(`starting ${ref.container}`, startArgs(ref), RUN_MS);
  }

  async stop(ref: SandboxRef): Promise<void> {
    await this.must(`stopping ${ref.container}`, stopArgs(ref), RUN_MS);
  }

  async remove(ref: SandboxRef): Promise<void> {
    const container = await this.run(removeArgs(ref), RUN_MS);
    if (container.notFound) throw new BackendError("Docker not found", "not_found");
    if (container.code !== 0 && !isNoSuchObject(container.stderr)) {
      throw new BackendError(
        `Docker failed removing ${ref.container}: ${firstLine(container.stderr)}`,
      );
    }
    await this.must(`removing the volume ${ref.volume}`, volumeRemoveArgs(ref), RUN_MS);
    this.opts.log?.(`docker: removed ${ref.container} and ${ref.volume}`);
  }

  async list(): Promise<SandboxSummary[]> {
    const result = await this.must("listing containers", listArgs(this.installLabel()));
    return parseList(result.stdout);
  }
}
