import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "@agent-rishi/server";
import { expect, it, vi } from "vitest";
import { parseCli } from "../src/args";
import { runCommand } from "../src/commands";

vi.mock("@agent-rishi/server", { spy: true });

it.each(["SIGINT", "SIGTERM"] as const)("exits 1 when closing after %s fails", async (signal) => {
  const home = mkdtempSync(join(tmpdir(), "agent-rishi-cli-close-"));
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const on = vi.spyOn(process, "on");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const args = ["--home", home, "--no-open"];
  const close = vi.fn().mockRejectedValue(new Error("close failed"));
  vi.mocked(startServer).mockResolvedValue({
    close,
    network: { enabled: false },
  } as unknown as RunningServer);

  try {
    void runCommand(args, parseCli(args));
    await expect.poll(() => on.mock.calls.some(([event]) => event === signal)).toBe(true);
    const handler = on.mock.calls.find(([event]) => event === signal)?.[1];
    // A second signal while closing is ignored.
    handler?.(signal);
    handler?.(signal);
    expect(close).toHaveBeenCalledOnce();
    await expect.poll(() => exit.mock.calls.at(-1)?.[0]).toBe(1);
  } finally {
    for (const [event, listener] of on.mock.calls) process.off(event, listener);
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  }
});
