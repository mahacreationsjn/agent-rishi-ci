import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { killTreeAndOrphans } from "../src/process/tree";
import { CheckRunner } from "../src/workspace/checks";
import { removeDir } from "./helpers";

/**
 * Ending what a check left running (`RunShellOptions.endTree`) starts with a listing of every
 * process; on Windows that is a PowerShell CIM query, about 1 to 2 s (#483). A check that left
 * nothing behind must not wait for it: its result comes as soon as its output closes, and the
 * cleanup still runs for its shell. Here the cleanup never ends, as if the listing hung.
 */
const cleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("../src/process/tree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/process/tree")>();
  return {
    ...actual,
    killTreeAndOrphans: vi.fn(() => new Promise<void>((resolve) => cleanups.push(resolve))),
  };
});

const dir = mkdtempSync(join(tmpdir(), "agent-rishi-check-cleanup-"));
afterEach(() => {
  for (const release of cleanups.splice(0)) release();
  vi.mocked(killTreeAndOrphans).mockClear();
});
afterAll(() => removeDir(dir));

/** The run, or a rejection once it has taken longer than `ms`. */
function within<T>(ms: number, run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the check was still running after ${ms} ms, waiting on its cleanup`)),
      ms,
    );
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

describe("a check that left nothing running (#483)", { timeout: 30_000 }, () => {
  const checks = new CheckRunner(new ProcessSupervisor(), {});
  const base = { name: "check.run" as const, cwd: dir, timeoutMs: 60_000 };

  it("returns its result without waiting for the process listing that ends its strays", async () => {
    const result = await within(
      10_000,
      checks.run({ ...base, sessionId: "s1", command: `node -e "console.log('ok')"` }),
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.output.trim()).toBe("ok");
    // What it might have left running is still ended, from its shell, once that has exited.
    expect(killTreeAndOrphans).toHaveBeenCalledTimes(1);
    expect(killTreeAndOrphans).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ startedAt: expect.any(Number), endedAt: expect.any(Number) }),
    );
  });

  it("frees the session's slot, so the next check runs", async () => {
    const first = await within(10_000, checks.run({ ...base, sessionId: "s2", command: "exit 0" }));
    expect(first.exitCode).toBe(0);
    const second = await within(
      10_000,
      checks.run({ ...base, sessionId: "s2", command: "exit 0" }),
    );
    expect(second.exitCode).toBe(0);
  });
});
