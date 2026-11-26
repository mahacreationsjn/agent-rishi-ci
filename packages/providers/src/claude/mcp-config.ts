import { existsSync } from "node:fs";
import type { SessionOptions } from "@agent-rishi/contracts";
import { type PrivateMcpConfig, writePrivateMcpConfig } from "../util/private-mcp-config";
import { claudeMcpServers } from "./options";

/**
 * A Claude session's MCP servers as the private file the CLI reads with `--mcp-config <file>`
 * (§15): never inline on its command line, where any local process could read the bearer token.
 */
export class ClaudeMcpConfig {
  private written: PrivateMcpConfig | undefined;

  constructor(
    private readonly opts: Pick<SessionOptions, "sessionId" | "mcpServers" | "agentRishiHome">,
  ) {}

  /**
   * The file's path, none without servers. Written once, or again when it went missing, since a
   * query restarted after the CLI exits reads it again.
   */
  file(): string | undefined {
    if (this.opts.mcpServers.length === 0) return undefined;
    if (this.written && existsSync(this.written.file)) return this.written.file;
    this.remove();
    this.written = writePrivateMcpConfig({
      sessionId: this.opts.sessionId,
      ...(this.opts.agentRishiHome ? { agentRishiHome: this.opts.agentRishiHome } : {}),
      config: { mcpServers: claudeMcpServers(this.opts.mcpServers) },
    });
    return this.written.file;
  }

  /** Delete the file and its folder (when the session closes). */
  remove(): void {
    try {
      this.written?.remove();
    } catch {
      // Best effort: the token in it is revoked when the session ends.
    }
    this.written = undefined;
  }
}
