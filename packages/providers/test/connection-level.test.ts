import type { ProviderStatus } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import type { ProviderAdapter } from "../src/adapter";
import { ConnectionLevels, connectionLevel } from "../src/connection-level";
import { ProviderRegistry } from "../src/registry";

const T0 = Date.parse("2026-11-28T10:00:00.000Z");

function status(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    providerId: "codex",
    installed: true,
    version: "1.0.0",
    executablePath: "/bin/codex",
    loggedIn: true,
    authMethod: "chatgpt",
    account: null,
    loginExpiresAt: null,
    supported: true,
    issues: [],
    checkedAt: new Date(T0).toISOString(),
    ...over,
  };
}

describe("connectionLevel", () => {
  it("has no level for a provider that is missing or can't run", () => {
    expect(connectionLevel(status({ installed: false }), T0)).toBeNull();
    expect(connectionLevel(status({ supported: false }), T0)).toBeNull();
  });

  it("is configured without evidence of a login, even after a check passed", () => {
    expect(connectionLevel(status({ loggedIn: false }), T0)).toBe("configured");
    expect(connectionLevel(status({ loggedIn: null }), T0)).toBe("configured");
  });

  it("is credential found with a login, and verified once a real check passed", () => {
    expect(connectionLevel(status(), undefined)).toBe("credential_found");
    expect(connectionLevel(status(), T0)).toBe("verified");
  });
});

describe("ConnectionLevels", () => {
  it("counts a check that passed before the first detection", () => {
    const levels = new ConnectionLevels(() => T0 + 1_000);
    expect(levels.apply(status(), T0)).toMatchObject({
      level: "verified",
      verifiedAt: new Date(T0).toISOString(),
    });
  });

  it("doesn't let a check from another login verify a new one", () => {
    let now = T0;
    const levels = new ConnectionLevels(() => now);
    expect(levels.apply(status({ account: "a@x" }), T0)?.level).toBe("verified");
    now = T0 + 60_000;
    // Another account: the earlier check ran with the old login.
    const switched = levels.apply(status({ account: "b@x" }), T0);
    expect(switched).toMatchObject({ level: "credential_found", verifiedAt: null });
    // The next real check, with the new login, verifies it.
    expect(levels.apply(status({ account: "b@x" }), now + 5)?.level).toBe("verified");
  });

  it("asks for a new check after a sign-out and back in", () => {
    let now = T0;
    const levels = new ConnectionLevels(() => now);
    levels.apply(status(), T0);
    now += 1_000;
    expect(levels.apply(status({ loggedIn: false }), T0)?.level).toBe("configured");
    now += 1_000;
    expect(levels.apply(status(), T0)?.level).toBe("credential_found");
  });

  it("keeps the login it saw when a detection can't tell", () => {
    let now = T0;
    const levels = new ConnectionLevels(() => now);
    levels.apply(status(), T0);
    now += 1_000;
    expect(levels.apply(status({ loggedIn: null, authMethod: null }), T0)?.level).toBe(
      "configured",
    );
    expect(levels.apply(status(), T0)?.level).toBe("verified");
  });
});

/** An adapter whose detection and real check the test controls. */
function stubAdapter(
  id: string,
  opts: { verifiedAt?: () => number | undefined; listed?: () => void },
) {
  const adapter: ProviderAdapter = {
    id,
    displayName: id,
    detect: async () => status({ providerId: id }),
    capabilities: () => ({
      resume: false,
      steer: false,
      interrupt: false,
      approvals: false,
      userQuestions: false,
      subagents: false,
      rollback: false,
      fork: false,
      images: false,
      planMode: false,
      reasoningEffort: false,
      mcp: false,
      skills: false,
    }),
    models: () => [],
    refreshModels: async () => opts.listed?.(),
    openSession: async () => {
      throw new Error("not used");
    },
    ...(opts.verifiedAt ? { verifiedAt: opts.verifiedAt } : {}),
  };
  return adapter;
}

describe("ProviderRegistry.detect: the one detection", () => {
  it("is verified only after the real check, and only for adapters that can be checked", async () => {
    let checkedAt: number | undefined;
    const registry = new ProviderRegistry([
      stubAdapter("checked", {
        verifiedAt: () => checkedAt,
        listed: () => {
          checkedAt = Date.now();
        },
      }),
      stubAdapter("unchecked", {}),
    ]);
    const before = await registry.detect();
    expect(before.map((s) => s.level)).toEqual(["credential_found", "credential_found"]);
    const after = await registry.detect(undefined, { verify: true });
    expect(after.map((s) => [s.providerId, s.level])).toEqual([
      ["checked", "verified"],
      ["unchecked", "credential_found"],
    ]);
    // `withLevels` gives the same answer for statuses taken before the check.
    expect(registry.withLevels(before).map((s) => s.level)).toEqual([
      "verified",
      "credential_found",
    ]);
  });

  it("detects only the providers asked for, and survives a throwing verifiedAt", async () => {
    const registry = new ProviderRegistry([
      stubAdapter("a", {
        verifiedAt: () => {
          throw new Error("broken");
        },
      }),
      stubAdapter("b", {}),
    ]);
    const statuses = await registry.detect(["a"]);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ providerId: "a", level: "credential_found" });
  });
});
