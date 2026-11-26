import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_RISHI_MCP_CONFIG_DIR } from "@agent-rishi/contracts";

/**
 * A session's MCP config as a private file (§15), for agent CLIs that would otherwise take it on
 * their command line, where any local process (and, on Linux and macOS, any other OS user) can
 * read it: Agent Rishi's bearer token is in it.
 */
export interface PrivateMcpConfig {
  /** The config file's absolute path. */
  readonly file: string;
  /** Delete the file and its session folder. Safe to call more than once. */
  remove(): void;
}

/** The file's name in its session folder. */
export const PRIVATE_MCP_CONFIG_NAME = "mcp.json";

/**
 * How session folders' names start (`session-<session id>-<random>`), so wildcards that reach
 * them are told apart from ones that only match other names (a Glob for `install-token` anywhere
 * under the runner's folder).
 */
export const PRIVATE_MCP_FOLDER_PREFIX = "session-";

/** A session id as a folder name: safe characters only, and short. */
function folderName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
}

/**
 * Write `config` (JSON) to a new owner-only folder for the session and return its file. The folder
 * is in Agent Rishi's data directory (`AGENT_RISHI_MCP_CONFIG_DIR`, guarded like Agent Rishi's credential
 * files, so other sessions' agents ask before reading it), else in the OS temp directory. Folders
 * are made with `mkdtemp` (mode 700 on POSIX, a fresh random name, so another user can't have
 * made it first) and the file with mode 600; on Windows both inherit the user profile's
 * owner-only access.
 */
export function writePrivateMcpConfig(opts: {
  sessionId: string;
  agentRishiHome?: string;
  config: unknown;
}): PrivateMcpConfig {
  const name = folderName(opts.sessionId);
  let dir: string;
  if (opts.agentRishiHome) {
    const root = path.join(opts.agentRishiHome, AGENT_RISHI_MCP_CONFIG_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    dir = mkdtempSync(path.join(root, `${PRIVATE_MCP_FOLDER_PREFIX}${name}-`));
  } else {
    dir = mkdtempSync(path.join(tmpdir(), `agent-rishi-mcp-${name}-`));
  }
  const remove = () => rmSync(dir, { recursive: true, force: true });
  const file = path.join(dir, PRIVATE_MCP_CONFIG_NAME);
  try {
    writeFileSync(file, JSON.stringify(opts.config), { mode: 0o600, flag: "wx" });
  } catch (error) {
    remove();
    throw error;
  }
  return { file, remove };
}
