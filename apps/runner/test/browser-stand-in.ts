import { createServer } from "node:net";
import { type Browser, chromium } from "playwright-core";
import { findInstalledChannels } from "../src/browser";

/** A Chromium standing in for the desktop app's browser views in tests. */
export interface StandInApp {
  browser: Browser;
  /** Its browser-level CDP endpoint on 127.0.0.1: the stand-in for the app's relay. */
  cdpUrl: string;
  /** Browser process id, for cleanup; null if it could not be determined. */
  pid: number | null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function cdpEndpoint(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(5_000),
    });
    return (
      ((await response.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? null
    );
  } catch {
    return null;
  }
}

async function browserPid(browser: Browser): Promise<number | null> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const info = (await cdp.send("SystemInfo.getProcessInfo")) as {
      processInfo: { type: string; id: number }[];
    };
    await cdp.detach().catch(() => undefined);
    return info.processInfo.find((p) => p.type === "browser")?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * A second, empty Chromium whose CDP endpoint plays the desktop app's per-session relay (§17
 * Phase 2) in the native-engine tests. Test only: the runner's own Chromium opens no debugging
 * port (issue #318), and the real relay checks a per-session secret on every connection.
 */
export async function launchStandInApp(): Promise<StandInApp> {
  const channel = findInstalledChannels()[0];
  if (!channel) throw new Error("No installed Edge or Chrome");
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const browser = await chromium.launch({
      channel,
      headless: true,
      args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    });
    const cdpUrl = await cdpEndpoint(port);
    if (cdpUrl) return { browser, cdpUrl, pid: await browserPid(browser) };
    // The port was taken between the probe and the launch: try another.
    await browser.close().catch(() => undefined);
    if (attempt === 3)
      throw new Error(`The stand-in's CDP endpoint on port ${port} did not answer`);
  }
}
