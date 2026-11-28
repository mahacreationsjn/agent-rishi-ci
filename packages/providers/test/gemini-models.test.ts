import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiAdapter } from "../src/gemini/adapter";
import type { GeminiAuth } from "../src/gemini/auth";
import { ProviderRegistry } from "../src/registry";

/** Gemini CLI lists the account's models only in a session: `refreshModels` opens one. */

const fakeGemini = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-gemini", "gemini.mjs"),
};

const signedIn = (): GeminiAuth => ({
  loggedIn: true,
  authMethod: "oauth-personal",
  account: "ada@example.com",
});

type Logged = { method: string; params: Record<string, unknown> };
let dir: string;
const logFile = () => join(dir, "acp.log");
const logged = (method: string): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
        .filter((m) => m.method === method)
    : [];

const saved = { log: process.env.FAKE_GEMINI_LOG, auth: process.env.FAKE_GEMINI_AUTH };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-gemini-models-"));
  process.env.FAKE_GEMINI_LOG = logFile();
  delete process.env.FAKE_GEMINI_AUTH;
});

afterEach(() => {
  for (const [key, value] of [
    ["FAKE_GEMINI_LOG", saved.log],
    ["FAKE_GEMINI_AUTH", saved.auth],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Gemini CLI model list", () => {
  it("lists the account's models before any session, without a prompt or a login", async () => {
    const adapter = new GeminiAdapter({ executable: fakeGemini, auth: signedIn });
    expect(adapter.models().map((m) => m.id)).toEqual([
      "default",
      "auto",
      "pro",
      "flash",
      "flash-lite",
    ]);
    expect(adapter.verifiedAt()).toBeUndefined();

    await adapter.refreshModels();

    // The CLI's own list, as it reported it: nothing is hard-coded.
    expect(adapter.models().map((m) => m.id)).toEqual([
      "default",
      "auto",
      "gemini-3-pro-preview",
      "gemini-2.5-flash",
    ]);
    expect(adapter.verifiedAt()).toBeTypeOf("number");
    expect(logged("session/new")).toHaveLength(1);
    expect(logged("session/new")[0]?.params.mcpServers).toEqual([]);
    expect(logged("authenticate")).toEqual([]);
    expect(logged("session/prompt")).toEqual([]);
  });

  it("starts nothing without evidence of a login", async () => {
    for (const auth of [
      (): GeminiAuth => ({ loggedIn: false, authMethod: null, account: null }),
      (): GeminiAuth => ({ loggedIn: null, authMethod: "oauth-personal", account: null }),
    ]) {
      const adapter = new GeminiAdapter({ executable: fakeGemini, auth });
      await adapter.refreshModels();
      expect(adapter.verifiedAt()).toBeUndefined();
    }
    expect(logged("initialize")).toEqual([]);
  });

  it("keeps the aliases and is not verified when the CLI can't use its login", async () => {
    process.env.FAKE_GEMINI_AUTH = "missing";
    const adapter = new GeminiAdapter({ executable: fakeGemini, auth: signedIn });
    await expect(adapter.refreshModels()).resolves.toBeUndefined();
    expect(adapter.models().map((m) => m.id)).toContain("pro");
    expect(adapter.verifiedAt()).toBeUndefined();
    expect(logged("authenticate")).toEqual([]);
  });

  it("skips a recent list from the same CLI", async () => {
    const adapter = new GeminiAdapter({ executable: fakeGemini, auth: signedIn });
    await adapter.refreshModels();
    await adapter.refreshModels({ maxAgeMs: 60_000 });
    expect(logged("session/new")).toHaveLength(1);
  });

  it("reaches verified through the registry's detection only after the listing passed", async () => {
    const registry = new ProviderRegistry([
      new GeminiAdapter({ executable: fakeGemini, auth: signedIn }),
    ]);
    const [before] = await registry.detect();
    expect(before).toMatchObject({ level: "credential_found", verifiedAt: null, loggedIn: true });
    const [after] = await registry.detect(undefined, { verify: true });
    expect(after?.level).toBe("verified");
    expect(Date.parse(after?.verifiedAt ?? "")).not.toBeNaN();
  });
});
