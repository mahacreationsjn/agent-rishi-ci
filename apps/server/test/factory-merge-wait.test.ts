import { afterEach, describe, expect, it } from "vitest";
import { READY_RECHECK_MS } from "../src/services/factory/verify";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

let env: FactoryEnv;
afterEach(() => env?.close());
const { enable, verifying, tick, review, item, later, prEntry } = factorySteps(() => env);

describe("Factory PRs waiting on a GitHub gate", () => {
  it.each(["draft", "required checks"] as const)(
    "withdraws a stale merge decision while waiting on %s and restores it when clear",
    async (gate) => {
      env = createFactoryEnv();
      await enable("software_factory", { autoMerge: false });
      const { id, pr } = await verifying();
      await tick();
      review(id);
      await tick();
      const inboxId = `inbox:factory-ready:${id}`;
      expect(env.inbox.find(inboxId)?.status).toBe("open");
      if (gate === "draft") pr.ref = { ...pr.ref, state: "draft" };
      else {
        pr.mergeState = "blocked";
        pr.checks = "none";
      }
      later(READY_RECHECK_MS + 1);
      await tick();
      expect(item(id)).toMatchObject({
        stage: "verifying",
        mergeWait: expect.stringContaining(gate === "draft" ? gate : "required GitHub checks"),
      });
      expect((await prEntry(pr.ref.number))?.state).not.toBe("waiting_for_you");
      expect(env.inbox.find(inboxId)?.status).toBe("resolved");
      expect(env.gh.merges).toHaveLength(0);
      pr.ref = { ...pr.ref, state: "open" };
      pr.mergeState = "clean";
      pr.checks = "success";
      await tick();
      expect(item(id).mergeWait).toBeNull();
      expect((await prEntry(pr.ref.number))?.state).toBe("waiting_for_you");
      expect(env.inbox.find(inboxId)?.status).toBe("open");
    },
  );
});
