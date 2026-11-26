import { execFile } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { findInstalledChannels, type LaunchedBrowser, launchChromium } from "../src/browser";
import { type ListeningSocket, parseLsof, parseNetstat } from "../src/ports";
import { isAlive, killTree, listDescendants } from "../src/process/tree";

const hasBrowser = findInstalledChannels().length > 0;

/** stdout of a command; tools like lsof exit non-zero when they find nothing. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 30_000 }, (_error, stdout) =>
      resolve(stdout ?? ""),
    );
  });
}

/** Every listening TCP socket on this machine, on any address. */
async function tcpListeners(): Promise<ListeningSocket[]> {
  return process.platform === "win32"
    ? parseNetstat(await run("netstat", ["-ano"]))
    : parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]));
}

/**
 * Issue #318: the runner's one Chromium holds every session's context (tabs, cookies), so a
 * CDP port on loopback would hand all of them to anyone who can reach it: another session's
 * agent, another OS user, a container. Playwright drives it over a pipe; nothing in its
 * process tree may listen on TCP.
 */
describe.skipIf(!hasBrowser)("the runner's Chromium (installed Edge/Chrome)", () => {
  let launched: LaunchedBrowser | undefined;

  afterAll(async () => {
    await launched?.browser.close().catch(() => undefined);
    if (launched?.pid && isAlive(launched.pid)) await killTree(launched.pid);
  }, 60_000);

  it("opens no TCP listener", { timeout: 90_000 }, async () => {
    launched = await launchChromium();
    // A page, so the renderer and network service processes are up too.
    const context = await launched.browser.newContext();
    const page = await context.newPage();
    await page.setContent("<title>listeners</title><p>no debugging port</p>");

    const pid = launched.pid;
    expect(pid).toBeGreaterThan(0);
    const tree = new Set([pid as number, ...(await listDescendants(pid as number))]);
    const listeners = (await tcpListeners()).filter((s) => tree.has(s.pid));
    expect(listeners).toEqual([]);
  });
});
