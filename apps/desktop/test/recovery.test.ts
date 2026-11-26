import { expect, it, vi } from "vitest";
import { loadAfterReady } from "../src/main/recovery";

it("waits for readiness before retrying a failed navigation once", async () => {
  const steps: string[] = [];
  const load = vi.fn(async () => {
    steps.push("load");
    throw new Error("navigation failed");
  });
  await expect(
    loadAfterReady(load, async () => {
      steps.push("ready");
    }),
  ).rejects.toThrow("navigation failed");
  expect(steps).toEqual(["load", "ready", "load"]);
});

it("does not retry if the server never becomes ready", async () => {
  const load = vi.fn().mockRejectedValue(new Error("navigation failed"));
  const wait = vi.fn().mockRejectedValue(new Error("server unavailable"));
  await expect(loadAfterReady(load, wait)).rejects.toThrow("server unavailable");
  expect(load).toHaveBeenCalledTimes(1);
});
