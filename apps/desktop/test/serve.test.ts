import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureInstallToken, type RunningServer, startServer } from "@agent-rishi/server";
import { expect, it, vi } from "vitest";
import { serve } from "../src/server/serve";

vi.mock("@agent-rishi/server", { spy: true });

it("treats a signal during API shutdown as a forced exit", async () => {
  const { startServer: realStart } =
    await vi.importActual<typeof import("@agent-rishi/server")>("@agent-rishi/server");
  const home = mkdtempSync(join(tmpdir(), "agent-rishi-desktop-serve-"));
  const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);
  const on = vi.spyOn(process, "on");
  let server: RunningServer | undefined;
  let signal: (() => void) | undefined;
  vi.mocked(startServer).mockImplementation(async (options) => {
    server = await realStart({
      ...options,
      runner: false,
      onShutdownStart: () => {
        options.onShutdownStart?.();
        signal?.();
      },
    });
    return server;
  });

  try {
    await serve({ home, port: 0, fake: true });
    signal = on.mock.calls.find(([event]) => event === "SIGTERM")?.[1] as () => void;
    expect(signal).toBeTypeOf("function");
    const response = await fetch(`${server?.url}/api/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${ensureInstallToken(join(home, "install-token"))}` },
    });
    expect(response.status).toBe(200);
    await expect.poll(() => exit.mock.calls.at(-1)?.[0]).toBe(0);
    expect(exit.mock.calls.map(([code]) => code)).toEqual([1, 0]);
  } finally {
    for (const [event, listener] of on.mock.calls) process.off(event, listener);
    await server?.close();
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  }
});
