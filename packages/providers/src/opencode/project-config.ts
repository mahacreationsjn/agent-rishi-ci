import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonc } from "../util/jsonc";

/**
 * A project's own OpenCode config (§7.2, #643). OpenCode reads `opencode.json` and `.opencode/`
 * from the folder it runs in, but Agent Rishi lists models from the temp folder and runs sessions in
 * worktrees, which only hold what git tracks. So Agent Rishi reads the project's config itself, from
 * the project's main checkout, and layers it into the inline config (`OPENCODE_CONFIG_CONTENT`):
 * under the user's own inline config and Agent Rishi's settings, which always win.
 *
 * Only the config files are read, at the fixed names below; agents, commands and plugins in
 * `.opencode/` are not. Paths the config names (`{file:…}`, plugins, instructions) are never
 * followed. The config may hold API keys, so it is never logged or put in a message.
 */

/** Project config files, in the order OpenCode layers them (a later file wins). */
export const PROJECT_CONFIG_FILES = [
  "opencode.jsonc",
  "opencode.json",
  ".opencode/opencode.jsonc",
  ".opencode/opencode.json",
] as const;

/** A bigger file is skipped: no hand-written config comes near it. */
const MAX_CONFIG_BYTES = 1_000_000;

/**
 * Keys a project's config never brings in: plugins run inside OpenCode's server, next to its
 * secrets, and could undo Agent Rishi's env guard; permission rules are Agent Rishi's to set.
 */
const RESERVED_KEYS = ["plugins", "plugin", "permission"] as const;

export interface ProjectConfig {
  /** The project's config files merged in OpenCode's order; undefined when there is none. */
  config: Record<string, unknown> | undefined;
  /** The files it came from, relative to the project. */
  files: string[];
  /** Files left out, and why, in words for the user (never their content). */
  warnings: string[];
  /** Changes whenever what the files add changes; a cache key that holds no content. */
  fingerprint: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge `over` onto `base`: objects merge, `plugins` arrays concatenate, the rest wins. */
export function mergeConfig(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    if (key === "plugins" && Array.isArray(prev) && Array.isArray(value))
      out[key] = [...prev, ...value];
    else if (isRecord(prev) && isRecord(value)) out[key] = mergeConfig(prev, value);
    else out[key] = value;
  }
  return out;
}

/**
 * Read the project's OpenCode config from `projectDir`. With `skipIn` (the session's folder), a
 * file that folder already has is left out: git tracks it there, and OpenCode reads that copy
 * itself. A file must be a regular file inside the project (a link out of it is skipped). Never
 * throws: a file that can't be read or isn't valid JSON (JSONC) is skipped with a warning.
 */
export function readProjectConfig(
  projectDir: string,
  opts: { skipIn?: string } = {},
): ProjectConfig {
  const root = realDir(projectDir);
  const empty: ProjectConfig = { config: undefined, files: [], warnings: [], fingerprint: "" };
  if (!root) return empty;
  const skipIn = opts.skipIn ? realDir(opts.skipIn) : undefined;
  if (skipIn && samePath(skipIn, root)) return empty;
  const hash = createHash("sha256");
  let config: Record<string, unknown> | undefined;
  const files: string[] = [];
  const warnings: string[] = [];
  for (const rel of PROJECT_CONFIG_FILES) {
    if (skipIn && existsSync(path.join(skipIn, rel))) continue;
    const read = readConfigFile(root, rel);
    if (read === undefined) continue;
    hash.update(`${rel}\0`);
    if (typeof read === "object") {
      hash.update(JSON.stringify(read));
      config = mergeConfig(config ?? {}, read);
      files.push(rel);
    } else {
      hash.update(read);
      warnings.push(`Left out the project's OpenCode config ${rel}: ${read}.`);
    }
  }
  return {
    config: config ? withoutReserved(config) : undefined,
    files,
    warnings,
    fingerprint: files.length || warnings.length ? hash.digest("hex") : "",
  };
}

/**
 * One config file: its object, a reason it was skipped, or undefined when there is no such
 * file. Its path must stay inside the project once links are resolved.
 */
function readConfigFile(root: string, rel: string): Record<string, unknown> | string | undefined {
  const file = path.join(root, rel);
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return undefined;
  }
  if (!inside(root, real)) return "it links to a file outside the project";
  try {
    const stat = statSync(real);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_CONFIG_BYTES) return "it is larger than 1 MB";
    const value = parseJsonc(readFileSync(real, "utf8"));
    if (value === undefined) return "it isn't valid JSON";
    return isRecord(value) ? value : "it isn't a JSON object";
  } catch {
    return "it could not be read";
  }
}

/** The config without the keys a project never sets (`RESERVED_KEYS`). */
function withoutReserved(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const key of RESERVED_KEYS) delete out[key];
  return out;
}

/**
 * Layer the inline config: the project's config, then the user's own inline config (OpenCode
 * ranks `OPENCODE_CONFIG_CONTENT` above project files), then Agent Rishi's, which wins. An MCP server
 * Agent Rishi sets is Agent Rishi's entry alone, never merged with a project entry of the same name.
 */
export function layerConfig(
  project: Record<string, unknown> | undefined,
  user: Record<string, unknown>,
  agentRishi: Record<string, unknown>,
): Record<string, unknown> {
  const own = mcpServers(agentRishi);
  let base: Record<string, unknown> = withoutReserved(project ?? {});
  if (own && isRecord(base.mcp))
    base = { ...base, mcp: withoutServers(base.mcp, Object.keys(own)) };
  return mergeConfig(mergeConfig(base, user), agentRishi);
}

function mcpServers(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const mcp = config.mcp;
  return isRecord(mcp) && isRecord(mcp.servers) ? mcp.servers : undefined;
}

/**
 * A project's `mcp` without the servers named `names`, in both of OpenCode's forms: V2's
 * `mcp.servers.<name>` and V1's `mcp.<name>`, which OpenCode still reads beside it (a V1
 * `enabled: false` would otherwise reach Agent Rishi's own entry).
 */
function withoutServers(mcp: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const out = { ...mcp };
  if (isRecord(out.servers)) {
    const servers = { ...out.servers };
    for (const name of names) delete servers[name];
    out.servers = servers;
  }
  for (const name of names) if (name !== "servers") delete out[name];
  return out;
}

/**
 * `{env:NAME}` in the config's strings, replaced from the server's environment (empty when it
 * isn't set), as OpenCode does for its config files. `{file:…}` is left as it is: Agent Rishi never
 * reads a path the config names.
 */
export function substituteEnv<T>(value: T, env: NodeJS.ProcessEnv): T {
  const lookup = envLookup(env);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(/\{env:([^}]+)\}/g, (_, name) => lookup(name));
    if (Array.isArray(v)) return v.map(walk);
    if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Environment lookup, ignoring case on Windows as the OS does. */
function envLookup(env: NodeJS.ProcessEnv): (name: string) => string {
  if (process.platform !== "win32") return (name) => env[name] ?? "";
  const upper = new Map(Object.entries(env).map(([k, v]) => [k.toUpperCase(), v]));
  return (name) => upper.get(name.toUpperCase()) ?? "";
}

function realDir(dir: string): string | undefined {
  try {
    const real = realpathSync(dir);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function samePath(a: string, b: string): boolean {
  return norm(path.resolve(a)) === norm(path.resolve(b));
}

function inside(root: string, file: string): boolean {
  const rel = path.relative(norm(root), norm(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
