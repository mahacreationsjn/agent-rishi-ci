import type {
  BackendStatus,
  SandboxRef,
  SandboxSpec,
  SandboxSummary,
} from "@agent-rishi/contracts";

/**
 * Argument lists for every `docker` command the Docker backend runs, and parsers for their
 * output (`docs/remote-runners.md` §5.2). Pure, so they are tested without Docker. Nothing
 * secret ever goes into these arguments: the GitHub token reaches a container only inside a
 * runner command over the link (§9.2), and provider credentials not at all yet (§14).
 */

/** Where the runner keeps its home (journal, lock file, clones) inside a container. */
export const SANDBOX_HOME = "/data";
/** The image's non-root user (`node` in the Node.js images). */
export const SANDBOX_USER = "1000:1000";
/** The oldest Docker Engine API Agent Rishi drives: Docker 20.10. */
export const MIN_DOCKER_API = "1.41";
export const MIN_DOCKER_VERSION = "20.10";
/** Labels on everything the backend makes. */
export const LABEL = {
  install: "agent-rishi.install",
  session: "agent-rishi.session",
  project: "agent-rishi.project",
  runner: "agent-rishi.runner",
  version: "agent-rishi.version",
  build: "agent-rishi.build",
} as const;

/** The runner image's name for an Agent Rishi version. */
export function imageName(version: string): string {
  return `agent-rishi-runner:${version}`;
}

/** `docker version` as JSON: the client's and, when the daemon answers, the server's. */
export function versionArgs(): string[] {
  return ["version", "--format", "{{json .}}"];
}

/** What `detect` needs from a `docker version` run. */
export interface VersionRun {
  /** The executable was not found on PATH. */
  notFound: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const FIX_INSTALL = "Install Docker Desktop, or Docker Engine on Linux, then check again";
const FIX_START = "Start Docker Desktop (or the docker service), then check again";

/** Compare two `major.minor` API versions. */
function apiAtLeast(version: string, min: string): boolean {
  const [a = 0, b = 0] = version.split(".").map(Number);
  const [c = 0, d = 0] = min.split(".").map(Number);
  return a > c || (a === c && b >= d);
}

/** The first line of a tool's error output, without Docker's "docker: Error response from daemon:". */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.replace(/^(docker:\s*)?(error response from daemon|error):\s*/i, "").trim();
}

/** Whether Docker's error says the daemon can't be reached. */
function daemonDown(stderr: string): boolean {
  return /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker_engine|dockerDesktopLinuxEngine|connection refused|the system cannot find the file specified/i.test(
    stderr,
  );
}

/** Read `docker version --format '{{json .}}'` into a backend status. */
export function parseVersion(run: VersionRun): BackendStatus {
  const base = { backend: "docker" as const, version: null };
  if (run.notFound) {
    return {
      ...base,
      available: false,
      code: "not_found",
      reason: "Docker not found: there is no docker command on this machine",
      fix: FIX_INSTALL,
    };
  }
  if (run.timedOut) {
    return {
      ...base,
      available: false,
      code: "daemon_down",
      reason: "Docker did not answer in time",
      fix: FIX_START,
    };
  }
  let parsed: { Server?: { Version?: string; ApiVersion?: string } | null } | null = null;
  try {
    parsed = JSON.parse(run.stdout.trim().split(/\r?\n/)[0] ?? "");
  } catch {
    parsed = null;
  }
  const server = parsed?.Server;
  if (!server?.Version) {
    if (daemonDown(run.stderr) || (parsed && !server)) {
      return {
        ...base,
        available: false,
        code: "daemon_down",
        reason: "Docker is installed but its daemon isn't running",
        fix: FIX_START,
      };
    }
    return {
      ...base,
      available: false,
      code: "detect_failed",
      reason: `Docker could not be checked: ${firstLine(run.stderr) || "no version reported"}`,
      fix: null,
    };
  }
  const api = server.ApiVersion ?? "0.0";
  if (!apiAtLeast(api, MIN_DOCKER_API)) {
    return {
      backend: "docker",
      version: server.Version,
      available: false,
      code: "too_old",
      reason: `Docker ${server.Version} is too old; Agent Rishi needs ${MIN_DOCKER_VERSION} or newer`,
      fix: "Update Docker, then check again",
    };
  }
  return {
    backend: "docker",
    version: server.Version,
    available: true,
    code: "ok",
    reason: null,
    fix: null,
  };
}

/** The image's labels as JSON (`null` printed when it has none); fails when it doesn't exist. */
export function imageLabelsArgs(image: string): string[] {
  return ["image", "inspect", "--format", "{{json .Config.Labels}}", image];
}

/** Labels from `imageLabelsArgs` output; null when the output isn't a label map. */
export function parseLabels(stdout: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() || "null");
    if (parsed === null) return {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}

/** Build the runner image from a prepared context folder (`image.ts`). */
export function buildArgs(opts: {
  image: string;
  context: string;
  version: string;
  build: string;
}): string[] {
  return [
    "build",
    "--tag",
    opts.image,
    "--label",
    `${LABEL.version}=${opts.version}`,
    "--label",
    `${LABEL.build}=${opts.build}`,
    opts.context,
  ];
}

/** A sandbox's labels, as `key=value` strings. */
function sandboxLabels(spec: SandboxSpec, install: string, version: string): string[] {
  return [
    `${LABEL.install}=${install}`,
    `${LABEL.session}=${spec.sessionId}`,
    `${LABEL.project}=${spec.projectId}`,
    `${LABEL.runner}=${spec.recordId}`,
    `${LABEL.version}=${version}`,
  ];
}

const labelFlags = (labels: string[]) => labels.flatMap((l) => ["--label", l]);

/** Make the named volume that holds a sandbox's runner home and clones. */
export function volumeCreateArgs(
  ref: SandboxRef,
  spec: SandboxSpec,
  install: string,
  version: string,
): string[] {
  return ["volume", "create", ...labelFlags(sandboxLabels(spec, install, version)), ref.volume];
}

/** Remove a sandbox's volume; `--force` makes a missing one no error. */
export function volumeRemoveArgs(ref: SandboxRef): string[] {
  return ["volume", "rm", "--force", ref.volume];
}

/**
 * Start a sandbox: the runner as the container's process, under `--init`, as the non-root user,
 * with CPU, memory and process limits and every capability dropped. Its only mount is its own
 * volume; no host folder, no published port, no `--privileged` and no environment variables.
 * Docker restarts it when it crashes or the daemon restarts, unless it was stopped on purpose.
 */
export function runArgs(
  ref: SandboxRef,
  spec: SandboxSpec,
  install: string,
  version: string,
): string[] {
  return [
    "run",
    "--detach",
    "--init",
    "--name",
    ref.container,
    "--hostname",
    ref.container,
    "--user",
    SANDBOX_USER,
    "--cpus",
    String(spec.cpus),
    "--memory",
    `${spec.memoryMb}m`,
    "--pids-limit",
    "1024",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--restart",
    "unless-stopped",
    "--mount",
    `type=volume,source=${ref.volume},target=${SANDBOX_HOME}`,
    "--workdir",
    SANDBOX_HOME,
    ...labelFlags(sandboxLabels(spec, install, version)),
    spec.image,
    "agent-rishi-runner",
    "--home",
    SANDBOX_HOME,
    "--backend",
    "docker",
    "--no-builtin",
    ...(spec.fake ? ["--fake"] : []),
  ];
}

/**
 * The exec link (`docs/remote-runners.md` §6): `agent-rishi runner-link` in the container, its
 * stdin and stdout piped to the server. It reads the runner's token from the lock file inside.
 */
export function execLinkArgs(ref: SandboxRef): string[] {
  return [
    "exec",
    "--interactive",
    "--user",
    SANDBOX_USER,
    ref.container,
    "agent-rishi",
    "runner-link",
    "--home",
    SANDBOX_HOME,
  ];
}

/**
 * Set the git identity commits in the sandbox carry (the user's own, from this machine): name
 * and email are not secrets, and live in the container's own `~/.gitconfig`, not its config.
 */
export function gitIdentityArgs(ref: SandboxRef, key: "name" | "email", value: string): string[] {
  return [
    "exec",
    "--user",
    SANDBOX_USER,
    ref.container,
    "git",
    "config",
    "--global",
    `user.${key}`,
    value,
  ];
}

export function startArgs(ref: SandboxRef): string[] {
  return ["start", ref.container];
}

/** Stop a sandbox, giving the runner 10 s to close cleanly. */
export function stopArgs(ref: SandboxRef): string[] {
  return ["stop", "--time", "10", ref.container];
}

export function removeArgs(ref: SandboxRef): string[] {
  return ["rm", "--force", ref.container];
}

/** A container's state as JSON; fails when it doesn't exist. */
export function inspectStateArgs(ref: SandboxRef): string[] {
  return ["container", "inspect", "--format", "{{json .State.Status}}", ref.container];
}

/** `running`, `exited` or `other` from `inspectStateArgs` or `docker ps` output. */
export function parseState(text: string): SandboxSummary["state"] {
  const status = text.trim().replace(/^"|"$/g, "").toLowerCase();
  if (status === "running") return "running";
  if (status === "exited" || status === "created") return "exited";
  return "other";
}

/** Whether Docker's error says the container, volume or image doesn't exist. */
export function isNoSuchObject(stderr: string): boolean {
  return /no such (container|object|volume|image)|not found/i.test(stderr);
}

/** Every container this install made, as one JSON object per line. */
export function listArgs(install: string): string[] {
  return [
    "ps",
    "--all",
    "--no-trunc",
    "--filter",
    `label=${LABEL.install}=${install}`,
    "--format",
    "{{json .}}",
  ];
}

/** `docker ps`'s comma-separated `key=value` labels. */
function psLabels(text: unknown): Record<string, string> {
  if (typeof text !== "string") return {};
  const out: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}

/** The sandboxes in `listArgs` output; lines that aren't containers are skipped. */
export function parseList(stdout: string): SandboxSummary[] {
  const out: SandboxSummary[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const container = typeof row.Names === "string" ? row.Names.split(",")[0] : undefined;
    if (!container) continue;
    const labels = psLabels(row.Labels);
    const mounts = typeof row.Mounts === "string" ? row.Mounts.split(",").filter(Boolean) : [];
    out.push({
      container,
      volume: mounts[0] ?? null,
      sessionId: labels[LABEL.session] ?? null,
      projectId: labels[LABEL.project] ?? null,
      recordId: labels[LABEL.runner] ?? null,
      version: labels[LABEL.version] ?? null,
      state: parseState(String(row.State ?? "")),
    });
  }
  return out;
}
