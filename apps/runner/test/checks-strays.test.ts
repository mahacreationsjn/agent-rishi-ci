import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { isAlive } from "../src/process/tree";
import { CheckRunner } from "../src/workspace/checks";
import { removeDir } from "./helpers";

/**
 * A check that leaves a process in the background (#412): a server or watcher that still holds
 * the check's output once the check's own process has exited. The check still finishes and
 * frees the session's check slot, and what it left running is killed where it can be found.
 */

const dir = mkdtempSync(join(tmpdir(), "agent-rishi-check-strays-"));
afterAll(async () => {
  // Whatever a run left behind, so the folder can go.
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".pid"))) {
    const pid = Number(readFileSync(join(dir, file), "utf8"));
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
    await gone(pid);
  }
  try {
    removeDir(dir);
  } catch {
    // Windows may hold the folder a moment after killing what ran in it.
  }
});

const windows = process.platform === "win32";
const node = (code: string) => `node -e "${code}"`;
/** Forward slashes, so the path can sit in a JS string inside the command line. */
const slashed = (path: string) => path.replace(/\\/g, "/");

/** A process that writes its pid to `pidFile`, then waits `ms` (a server, a watcher). */
const background = (pidFile: string, ms: number) =>
  node(
    `require('fs').writeFileSync('${slashed(pidFile)}', String(process.pid)); setTimeout(function(){}, ${ms})`,
  );
/** Waits until `pidFile` exists, prints "started", then stays `ms` more. */
const thenWait = (pidFile: string, ms = 0) =>
  node(
    `var t = setInterval(function(){ if (require('fs').existsSync('${slashed(pidFile)}')) { clearInterval(t); console.log('started'); setTimeout(function(){}, ${ms}); } }, 20)`,
  );
/** The check's shell starts `command` in the background, sharing its output, then runs `then`. */
const inBackground = (command: string, then: string) =>
  windows ? `start "" /b ${command} & ${then}` : `${command} & ${then}`;

/**
 * A process that starts a child sharing its output and exits: the child detaches itself (its
 * own process group; on Windows, where Node ends a child it didn't detach when it exits itself,
 * out of Node's job), so once its parent is gone nothing ties it to the check.
 */
const detachedChild = (pidFile: string, ms: number) =>
  node(
    [
      `var c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(function(){}, ${ms})'], { stdio: 'inherit', detached: true, windowsHide: true })`,
      `require('fs').writeFileSync('${slashed(pidFile)}', String(c.pid))`,
      "c.unref()",
      "console.log('started')",
    ].join("; "),
  );

/** The run, or a rejection once it has taken longer than `ms`. */
function within<T>(ms: number, run: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the check was still running after ${ms} ms`)), ms);
  });
  return Promise.race([run, late]).finally(() => clearTimeout(timer));
}

async function pidIn(pidFile: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile)) {
    if (Date.now() > deadline) throw new Error("the background process never started");
    await new Promise((r) => setTimeout(r, 20));
  }
  return Number(readFileSync(pidFile, "utf8"));
}

async function gone(pid: number, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// Each test waits on real processes and, on Windows, PowerShell process listings.
describe("a check that leaves a process in the background (#412)", { timeout: 90_000 }, () => {
  const checks = new CheckRunner(new ProcessSupervisor(), {});
  const base = { name: "check.run" as const, cwd: dir, timeoutMs: 60_000 };
  // Refused (`check_running`) while the session's slot is still taken.
  const next = (sessionId: string) => checks.run({ ...base, sessionId, command: node("0") });

  it("finishes when its shell exits, kills what it left running, and the next check runs", async () => {
    const pidFile = join(dir, "exit.pid");
    const command = inBackground(background(pidFile, 30_000), thenWait(pidFile));
    const result = await within(30_000, checks.run({ ...base, sessionId: "s1", command }));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.output).toContain("started");
    expect(await gone(await pidIn(pidFile))).toBe(true);
    expect((await next("s1")).exitCode).toBe(0);
  });

  it("finishes when its own process exits, though a detached child keeps its output", async () => {
    const pidFile = join(dir, "detached.pid");
    const command = detachedChild(pidFile, 30_000);
    const result = await within(30_000, checks.run({ ...base, sessionId: "s2", command }));
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.output).toContain("started");
    expect((await next("s2")).exitCode).toBe(0);
  });

  it("kills the whole tree on the timeout", async () => {
    const pidFile = join(dir, "timeout.pid");
    const command = inBackground(background(pidFile, 30_000), thenWait(pidFile, 30_000));
    const result = await within(
      30_000,
      checks.run({ ...base, sessionId: "s3", timeoutMs: 1_500, command }),
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true, cancelled: false });
    expect(await gone(await pidIn(pidFile))).toBe(true);
    expect((await next("s3")).exitCode).toBe(0);
  });

  it("kills the whole tree on Stop and frees the session's slot", async () => {
    const pidFile = join(dir, "stop.pid");
    const command = inBackground(background(pidFile, 30_000), thenWait(pidFile, 30_000));
    const run = checks.run({ ...base, sessionId: "s4", command });
    const pid = await pidIn(pidFile);
    expect(checks.cancel("s4")).toBe(true);
    const result = await within(30_000, run);
    expect(result).toMatchObject({ exitCode: null, timedOut: false, cancelled: true });
    expect(await gone(pid)).toBe(true);
    expect((await next("s4")).exitCode).toBe(0);
  });
});
