import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #318: the runner's one shared Chromium holds every session's context, so it must not
 * open a CDP port anyone on loopback can attach to. Playwright drives it over a pipe; the
 * launch must not add a TCP debugging port next to it.
 */
type LaunchCall = { args?: string[]; ignoreDefaultArgs?: unknown };
const launches = vi.hoisted(() => [] as LaunchCall[]);

vi.mock("playwright-core", () => ({
  chromium: {
    launch: vi.fn(async (options: LaunchCall) => {
      launches.push(options);
      return {
        newBrowserCDPSession: async () => {
          throw new Error("no CDP session in this test");
        },
        close: async () => undefined,
      };
    }),
    executablePath: () => "",
  },
}));

const { launchChromium } = await import("../src/browser/launcher");

describe("launchChromium arguments", () => {
  beforeEach(() => {
    launches.length = 0;
  });

  it("opens no TCP debugging port and keeps Playwright's pipe", async () => {
    const launched = await launchChromium({ executablePath: "chromium-under-test" });
    expect(launched).toMatchObject({ channel: "executable", pid: null });
    expect(launched).not.toHaveProperty("cdpUrl");
    expect(launches).toHaveLength(1);
    for (const { args = [], ignoreDefaultArgs } of launches) {
      expect(args.filter((a) => a.startsWith("--remote-debugging-port"))).toEqual([]);
      expect(args.filter((a) => a.startsWith("--remote-debugging-address"))).toEqual([]);
      // Playwright adds --remote-debugging-pipe itself; dropping its defaults would lose it.
      expect(ignoreDefaultArgs).toBeUndefined();
    }
  });

  it("never adds a debugging port for an installed channel either", async () => {
    await launchChromium({ channels: ["msedge"] });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.args?.some((a) => a.startsWith("--remote-debugging"))).toBe(false);
  });
});
