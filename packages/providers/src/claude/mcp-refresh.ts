import type { McpServerState } from "@agent-rishi/contracts";

/** Waits between status reads while a server is still starting; then it waits for the next turn. */
const STARTING_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;

export interface McpStatusRefresherOptions {
  /** `Query.mcpServerStatus()` of the running query; undefined when none runs. */
  read: () => Promise<unknown> | undefined;
  /** Report the list (`ClaudeEventMapper.reportMcpServers`), returning the states it holds. */
  report: (list: unknown) => readonly McpServerState[];
  delaysMs?: readonly number[];
}

/**
 * Keeps a Claude session's MCP server states current between `system/init` messages: reads
 * `mcpServerStatus()` (which also carries a failed server's error) when asked, and again a few
 * times while a server is still starting. A CLI that can't answer is left alone.
 */
export class McpStatusRefresher {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: McpStatusRefresherOptions) {}

  /** Read the statuses now: after `system/init` and after each turn. */
  refresh(): void {
    if (this.stopped) return;
    this.attempt = 0;
    this.clearTimer();
    void this.read();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private async read(): Promise<void> {
    let list: unknown;
    try {
      list = await this.opts.read();
    } catch {
      return;
    }
    if (this.stopped || list === undefined) return;
    const states = this.opts.report(list);
    if (!states.some((s) => s.state === "starting")) return;
    const delay = (this.opts.delaysMs ?? STARTING_DELAYS_MS)[this.attempt++];
    if (delay === undefined) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) void this.read();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
