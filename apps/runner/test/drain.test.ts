import { expect, it, vi } from "vitest";
import { startRunner } from "../src";
import { SessionHost } from "../src/session-host";
import { removeDir, TestServer, tempDir } from "./helpers";

it("closes and reports failure when draining rejects", async () => {
  const home = tempDir("agent-rishi-drain-");
  const onShutdown = vi.fn();
  const runner = await startRunner({ home, enableFakeProvider: true, onShutdown });
  const server = await TestServer.attach(runner);
  const drain = vi
    .spyOn(SessionHost.prototype, "drain")
    .mockRejectedValueOnce(new Error("drain failed"));
  try {
    await server.request({ name: "runner.drain", reason: "upgrade", exitWhenDrained: true });
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledWith(1));
  } finally {
    drain.mockRestore();
    await server.close();
    await runner.close();
    removeDir(home);
  }
});
