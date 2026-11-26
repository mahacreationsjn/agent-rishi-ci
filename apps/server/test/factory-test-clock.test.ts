import { afterEach, describe, expect, it } from "vitest";
import { localDay } from "../src/services/factory/policy";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";
import { runClockFrom, TEST_START, todayAt } from "./support/test-clock";

// Issue #379: the factory test env's clock started at the real current time, so a test that moved
// it hours ahead crossed midnight when it ran late in the day, and saw the daily digest.

let env: FactoryEnv | undefined;
let restoreSystemClock = () => {};
afterEach(async () => {
  await env?.close();
  env = undefined;
  restoreSystemClock();
  restoreSystemClock = () => {};
});
const { tick, later, enable } = factorySteps(() => env as FactoryEnv);
const HOUR = 3_600_000;
const digests = (e: FactoryEnv) =>
  e.inbox.list({ projectId: e.project.id }).filter((i) => i.id.startsWith("inbox:factory-digest:"));

describe.each(["23:50", "00:05"])("the factory test env with the system clock at %s", (at) => {
  it("starts at a fixed instant and stays within its day when moved hours ahead", async () => {
    restoreSystemClock = runClockFrom(todayAt(at));
    const system = Date.now();
    env = createFactoryEnv();
    expect(Math.abs(env.now().getTime() - TEST_START.getTime())).toBeLessThan(60_000);
    enable();
    await tick();
    later(2 * HOUR);
    await tick();
    expect(digests(env)).toEqual([]);
    expect(localDay(env.now())).toBe(localDay(TEST_START));
    // Closing it puts back the clock that ran before.
    await env.close();
    env = undefined;
    expect(Math.abs(Date.now() - system)).toBeLessThan(60_000);
  });
});

describe("day boundaries in the factory test env", () => {
  it("crosses midnight when a test starts near it on purpose", async () => {
    env = createFactoryEnv({ startAt: new Date(2026, 0, 15, 23, 50) });
    enable();
    await tick();
    later(20 * 60_000);
    await tick();
    expect(digests(env).map((i) => i.id)).toEqual([`inbox:factory-digest:p-app:2026-01-15`]);
    expect(env.factory.data.loopOrNew(env.project.id).day).toBe("2026-01-16");
  });
});
