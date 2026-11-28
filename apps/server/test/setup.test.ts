import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ProviderStatus } from "@agent-rishi/contracts";
import type { ExecutableLookup } from "@agent-rishi/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "../src/services/exec";
import { parseGhAuthJson, parseGhAuthText, parseVersion } from "../src/services/setup/parse";
import { SetupService, type SetupServiceDeps } from "../src/services/setup/setup-service";
import { execLocate } from "../src/services/setup/tool-lookup";
import { SettingsStore } from "../src/settings-store";
import { removeTree } from "./support/remove-tree";

const NOW = Date.parse("2026-11-07T10:00:00.000Z");
const VERIFIED_AT = "2026-11-07T09:59:00.000Z";

describe("detection parsers", () => {
  it("reads versions", () => {
    expect(parseVersion("2.1.318 (Claude Code)")).toBe("2.1.318");
    expect(parseVersion("gh version 2.81.0 (2025-10-01)")).toBe("2.81.0");
    expect(parseVersion("nothing")).toBeNull();
  });

  it("reads gh login state without capturing tokens", () => {
    expect(
      parseGhAuthJson(
        '{"hosts":{"github.com":[{"state":"success","active":true,"login":"octo","tokenSource":"keyring"}]}}',
      ),
    ).toEqual({ loggedIn: true, account: "octo" });
    const text =
      "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token: gho_****";
    const parsed = parseGhAuthText(0, text);
    expect(parsed).toEqual({ loggedIn: true, account: "octo" });
    expect(JSON.stringify(parsed)).not.toContain("gho_");
  });
});

/** Fake CLIs: a map from "command args" to a result (commands match by file name). */
function fakeExec(table: Record<string, Partial<ExecResult>>, calls: string[] = []): Exec {
  return async (command, args) => {
    const key = [basename(command), ...args].join(" ");
    calls.push(key);
    const hit = table[key];
    if (!hit)
      return { code: null, stdout: "", stderr: "", notFound: true, timedOut: false, path: null };
    return {
      code: 0,
      stdout: "",
      stderr: "",
      notFound: false,
      timedOut: false,
      path: `/bin/${command}`,
      ...hit,
    };
  };
}

/** Fake look-up: a tool is found at `/bin/<name>` when the table answers its `--version`. */
function fakeLocate(
  table: Record<string, Partial<ExecResult>>,
): (name: string) => Promise<ExecutableLookup> {
  return async (name) => {
    const hit = table[`${name} --version`];
    if (!hit || (hit.code ?? 0) !== 0) return { version: null, broken: [] };
    const version = /\d+\.\d+\.\d+/.exec(hit.stdout ?? "")?.[0] ?? null;
    return { command: { kind: "native", path: `/bin/${name}` }, version, broken: [] };
  };
}

/** What the runner's detection reports for a provider: installed and signed in by default. */
function provider(providerId: string, over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    providerId,
    installed: true,
    version: "1.0.0",
    executablePath: `/bin/${providerId}`,
    loggedIn: true,
    authMethod: null,
    account: null,
    loginExpiresAt: null,
    supported: true,
    issues: [],
    checkedAt: new Date(NOW).toISOString(),
    level: "credential_found",
    verifiedAt: null,
    ...over,
  };
}

const tools: Record<string, Partial<ExecResult>> = {
  "git --version": { stdout: "git version 2.50.1" },
  "git config --get user.name": { stdout: "Ada" },
  "git config --get user.email": { stdout: "ada@example.com" },
};

/** A service over fake tools and a fixed provider detection, a bash setup terminal. */
function service(
  statuses: ProviderStatus[] | (() => Promise<ProviderStatus[]>),
  deps: Partial<SetupServiceDeps> & { calls?: string[] } = {},
): SetupService {
  const { calls, ...rest } = deps;
  return new SetupService({
    exec: fakeExec(tools, calls),
    locate: fakeLocate(tools),
    detectProviders: typeof statuses === "function" ? statuses : async () => statuses,
    refreshPath: async () => undefined,
    shell: "/bin/bash",
    settings,
    platform: "linux",
    now: () => NOW,
    browserProbe: { exists: () => false },
    ...rest,
  });
}

const byId = async (setup: SetupService, refresh = false) =>
  Object.fromEntries((await setup.status({ refresh })).checks.map((c) => [c.id, c]));

let dir: string;
let settings: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-setup-"));
  settings = new SettingsStore(join(dir, "settings.json"));
});

afterEach(() => removeTree(dir));

describe("provider rows: the runner's detection, with its level", () => {
  it("shows only a verified provider as ready", async () => {
    const setup = service([
      provider("claude", { level: "verified", verifiedAt: VERIFIED_AT, account: "a@b.c" }),
      provider("codex", { level: "credential_found" }),
    ]);
    const status = await setup.status();
    const checks = Object.fromEntries(status.checks.map((c) => [c.id, c]));
    expect(checks.claude).toMatchObject({
      state: "ok",
      level: "verified",
      verifiedAt: VERIFIED_AT,
      account: "a@b.c",
      message: "Signed in and verified",
      fix: null,
    });
    expect(checks.codex).toMatchObject({
      state: "warning",
      level: "credential_found",
      verifiedAt: null,
      message: "Signed in, not verified yet",
      fix: { kind: "login", command: "/bin/codex login" },
    });
    expect(checks.codex?.detail).toContain("costs no tokens");
    expect(status.ready).toBe(true);
  });

  it("is not ready while every provider is only signed in", async () => {
    const status = await service([provider("gemini"), provider("antigravity")]).status();
    const rows = status.checks.filter((c) => c.level !== undefined);
    expect(rows.map((c) => [c.id, c.state])).toEqual([
      ["gemini", "warning"],
      ["antigravity", "warning"],
    ]);
    expect(status.ready).toBe(false);
  });

  it("never treats a status without a level (an older runner) as verified", async () => {
    const { level: _level, verifiedAt: _at, ...old } = provider("claude");
    const status = await service([old]).status();
    expect(status.checks.find((c) => c.id === "claude")).toMatchObject({
      level: "credential_found",
      state: "warning",
    });
    expect(status.ready).toBe(false);
  });

  it("asks to sign in below credential found, with the found copy by its path", async () => {
    const checks = await byId(
      service([
        provider("codex", {
          loggedIn: false,
          level: "configured",
          issues: [{ code: "not_logged_in", message: "Codex is not logged in." }],
        }),
        provider("gemini", {
          loggedIn: null,
          level: "configured",
          issues: [{ code: "detect_failed", message: "Could not confirm Gemini CLI's login." }],
        }),
      ]),
    );
    expect(checks.codex).toMatchObject({
      state: "missing",
      level: "configured",
      message: "Not signed in to Codex",
      detail: "Codex is not logged in.",
      fix: { kind: "login", command: "/bin/codex login" },
    });
    expect(checks.gemini).toMatchObject({
      state: "warning",
      message: "Could not confirm the Gemini CLI login",
      fix: { kind: "login", command: "/bin/gemini" },
    });
  });

  it("reports not installed, broken and too old with the fix that applies", async () => {
    const shim = "C:\\Users\\Ada\\AppData\\Roaming\\npm\\claude.cmd";
    const checks = await byId(
      service([
        provider("claude", {
          installed: false,
          executablePath: null,
          loggedIn: null,
          level: null,
          broken: [{ path: shim, reason: "points at a missing package" }],
          issues: [
            { code: "broken_install", message: `Claude Code is installed but broken: ${shim}` },
          ],
        }),
        provider("cursor", {
          installed: false,
          executablePath: null,
          loggedIn: null,
          level: null,
          issues: [{ code: "not_installed", message: "The Cursor CLI is not installed." }],
        }),
        provider("gemini", {
          version: "0.36.0",
          supported: false,
          loggedIn: null,
          level: null,
          issues: [
            {
              code: "version_unsupported",
              message: "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it.",
              fix: { kind: "upgrade", command: "npm install -g @google/gemini-cli@latest" },
              minVersion: "0.68.0",
            },
          ],
        }),
      ]),
    );
    expect(checks.claude).toMatchObject({
      state: "missing",
      installed: false,
      level: null,
      message: `Claude Code is installed but broken: ${shim}`,
      fix: { kind: "install", command: "npm install -g @anthropic-ai/claude-code" },
    });
    expect(checks.claude?.broken).toHaveLength(1);
    expect(checks.cursor).toMatchObject({
      state: "missing",
      message: "Cursor is not installed",
      fix: { kind: "install", url: "https://cursor.com/docs/cli/installation" },
    });
    expect(checks.gemini).toMatchObject({
      state: "missing",
      level: null,
      message: "Gemini CLI 0.36.0 is too old (needs 0.68.0+). Update it.",
      fix: { kind: "upgrade", command: "npm install -g @google/gemini-cli@latest" },
    });
  });

  it("flags an expiring login and OpenCode's free models on a verified provider", async () => {
    const verified = { level: "verified" as const, verifiedAt: VERIFIED_AT };
    const checks = await byId(
      service([
        provider("claude", {
          ...verified,
          issues: [{ code: "login_expiring", message: "Claude Code login expires soon." }],
        }),
        provider("opencode", { ...verified, authMethod: "free" }),
      ]),
    );
    expect(checks.claude).toMatchObject({
      state: "warning",
      level: "verified",
      message: "Your Claude Code login expires soon; sign in again",
      fix: { kind: "login", command: "/bin/claude auth login" },
    });
    expect(checks.opencode).toMatchObject({ state: "warning", level: "verified" });
  });

  it("shows only the providers detection reports, in setup's order", async () => {
    const status = await service([
      provider("antigravity"),
      provider("fake"),
      provider("claude"),
    ]).status();
    expect(status.checks.map((c) => c.id)).toEqual([
      "claude",
      "antigravity",
      "gh",
      "git",
      "browser",
      "node",
    ]);
  });

  it("signs in with the found copy quoted for the shell, or by name for an npm script", async () => {
    const native = "C:\\Users\\Ada Lovelace\\.local\\bin\\claude.exe";
    const setup = service(
      [
        provider("claude", { executablePath: native }),
        provider("codex", {
          executablePath: "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
        }),
      ],
      { shell: "powershell.exe" },
    );
    const checks = await byId(setup);
    expect(checks.claude?.fix?.command).toBe(`& '${native}' auth login`);
    expect(setup.loginCommand("claude")).toEqual({
      tool: "claude",
      command: `& '${native}' auth login`,
      args: ["auth", "login"],
    });
    expect(checks.codex?.fix?.command).toBe("codex login");
    expect(setup.loginCommand("codex").command).toBe("codex login");
  });

  it("marks every provider row failed when detection fails or takes too long", async () => {
    const failing = await byId(service(async () => Promise.reject(new Error("runner went away"))));
    expect(failing.claude).toMatchObject({
      state: "error",
      label: "Claude Code",
      message: "Check failed: runner went away",
    });
    expect(failing.antigravity?.state).toBe("error");
    const slow = service(() => new Promise(() => {}), { detectTimeoutMs: 20 });
    const status = await slow.status();
    expect(status.checks.find((c) => c.id === "gemini")?.message).toMatch(/timed out/);
    expect(status.ready).toBe(false);
    // The other tools are still checked.
    expect(status.checks.find((c) => c.id === "git")?.state).toBe("ok");
  });
});

describe("SetupService", () => {
  it("checks git, gh, Node.js and the browser itself", async () => {
    const checks = await byId(service([], { nodeVersion: "v24.16.0" }));
    expect(checks.gh).toMatchObject({ state: "missing", installed: false });
    expect(checks.git).toMatchObject({ state: "ok", account: "Ada <ada@example.com>" });
    expect(checks.node).toMatchObject({ state: "ok", version: "24.16.0" });
    expect(checks.browser?.state).toBe("warning");
  });

  it("caches results and detects again on refresh", async () => {
    const detect = vi.fn(async () => [provider("claude")]);
    const calls: string[] = [];
    const setup = service(detect, { calls });
    await setup.status();
    const first = calls.length;
    await setup.status();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(first);
    await setup.status({ refresh: true });
    expect(detect).toHaveBeenCalledTimes(2);
    expect(calls.length).toBe(first * 2);
  });

  it("reports every completed check, but not cached results", async () => {
    const checked: string[] = [];
    const setup = service([provider("claude", { level: "verified", verifiedAt: VERIFIED_AT })], {
      onChecked: (status) => {
        checked.push(status.checkedAt);
        throw new Error("a failing listener does not fail the check");
      },
    });
    await setup.status();
    await setup.status();
    expect(checked).toHaveLength(1);
    await expect(setup.status({ refresh: true })).resolves.toMatchObject({ ready: true });
    expect(checked).toHaveLength(2);
  });

  it("times out a slow tool check instead of hanging", async () => {
    const slow: Exec = (command, args) =>
      basename(command) === "git" ? new Promise(() => {}) : fakeExec(tools)(command, args);
    const status = await service([], { exec: slow, checkTimeoutMs: 50 }).status();
    expect(status.checks.find((c) => c.id === "git")).toMatchObject({
      state: "error",
      label: "git",
    });
  });

  it("persists completion in settings and hands out login commands", () => {
    const setup = service([]);
    setup.complete();
    expect(new SettingsStore(join(dir, "settings.json")).get().setup.completed).toBe(true);
    // Before a check found the tool, the bare command is all there is.
    expect(setup.loginCommand("gh")).toMatchObject({
      command: "gh auth login --web --git-protocol https",
    });
    expect(setup.loginCommand("opencode")).toEqual({
      tool: "opencode",
      command: "opencode auth login",
      args: ["auth", "login"],
    });
  });

  it("looks tools up through an injected exec, so fake CLIs never reach real ones", async () => {
    const calls: string[] = [];
    const locate = execLocate(fakeExec({ "gh --version": { stdout: "gh version 2.81.0" } }, calls));
    expect(await locate("gh")).toEqual({
      command: { kind: "native", path: "/bin/gh" },
      version: "2.81.0",
      broken: [],
    });
    expect(await locate("git")).toEqual({ version: null, broken: [] });
    expect(calls).toEqual(["gh --version", "git --version"]);
  });

  it("picks up a PATH change on re-check, without a restart", async () => {
    let path = ["/usr/bin"];
    const refreshPath = vi.fn(async () => {
      path = ["/usr/bin", "/home/ada/.local/bin"];
    });
    const locate = async (name: string): Promise<ExecutableLookup> =>
      name === "gh" && path.includes("/home/ada/.local/bin")
        ? {
            command: { kind: "native", path: "/home/ada/.local/bin/gh" },
            version: "2.81.0",
            broken: [],
          }
        : fakeLocate({})(name);
    const setup = service([], { locate, refreshPath });
    expect((await byId(setup)).gh?.installed).toBe(false);
    // A plain (cached or first) status leaves PATH alone; a re-check refreshes it first.
    expect(refreshPath).not.toHaveBeenCalled();
    const after = await byId(setup, true);
    expect(refreshPath).toHaveBeenCalledTimes(1);
    expect(after.gh).toMatchObject({
      installed: true,
      executablePath: "/home/ada/.local/bin/gh",
    });
  });
});
