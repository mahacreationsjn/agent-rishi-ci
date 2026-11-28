import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAgyAuth } from "../src/antigravity/detect";
import { runCommand } from "../src/util/exec";

vi.mock("../src/util/exec", { spy: true });

const run = vi.mocked(runCommand);
const unknown = { loggedIn: null, authMethod: null };
const oauth = { loggedIn: true, authMethod: "oauth-personal" };
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agent-rishi-agy-auth-"));
});

afterEach(() => {
  run.mockReset();
  rmSync(home, { recursive: true, force: true });
});

describe("Antigravity CLI auth detection", () => {
  it("recognizes the legacy token file by its presence", async () => {
    const agyHome = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agyHome, { recursive: true });
    writeFileSync(join(agyHome, "antigravity-oauth-token"), "");
    await expect(readAgyAuth(home, {}, "win32")).resolves.toEqual(oauth);
    expect(run).not.toHaveBeenCalled();
  });

  it("recognizes a configured API key without passing it to a command", async () => {
    await expect(readAgyAuth(home, { GEMINI_API_KEY: "test-key" }, "win32")).resolves.toEqual({
      loggedIn: true,
      authMethod: "gemini-api-key",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("checks the Windows target and sees changes on the next check", async () => {
    run.mockResolvedValueOnce({
      code: 0,
      stdout: "Currently stored credentials for gemini:antigravity:\r\n\r\n* NONE *\r\n",
      stderr: "",
      timedOut: false,
    });
    run.mockResolvedValueOnce({
      code: 0,
      stdout: "    Ziel: LegacyGeneric:target=gemini:antigravity\r\n    Benutzer: antigravity\r\n",
      stderr: "",
      timedOut: false,
    });
    await expect(readAgyAuth(home, {}, "win32")).resolves.toEqual(unknown);
    await expect(readAgyAuth(home, {}, "win32")).resolves.toEqual(oauth);
    expect(run).toHaveBeenCalledWith(
      { kind: "native", path: expect.stringMatching(/\\System32\\cmdkey\.exe$/i) },
      ["/list:gemini:antigravity"],
      { timeoutMs: 2_000 },
    );
  });

  it("recognizes the unprefixed Windows Credential Manager target", async () => {
    run.mockResolvedValueOnce({
      code: 0,
      stdout:
        "Currently stored credentials for gemini:antigravity:\r\n" +
        "    Target: gemini:antigravity\r\n" +
        "    Type: Generic\r\n" +
        "    User: antigravity\r\n" +
        "    Local machine persistence\r\n",
      stderr: "",
      timedOut: false,
    });
    await expect(readAgyAuth(home, {}, "win32")).resolves.toEqual(oauth);
  });

  it("ignores a different Windows target and the cmdkey header", async () => {
    run.mockResolvedValueOnce({
      code: 0,
      stdout:
        "Currently stored credentials for gemini:antigravity:\r\n" +
        "    Target: gemini:antigravity-other\r\n",
      stderr: "",
      timedOut: false,
    });
    await expect(readAgyAuth(home, {}, "win32")).resolves.toEqual(unknown);
  });

  it("checks macOS Keychain metadata and reports unknown when the query fails", async () => {
    run.mockResolvedValueOnce({ code: 0, stdout: "metadata", stderr: "", timedOut: false });
    run.mockResolvedValueOnce({ code: null, stdout: "", stderr: "", timedOut: true });
    await expect(readAgyAuth(home, {}, "darwin")).resolves.toEqual(oauth);
    await expect(readAgyAuth(home, {}, "darwin")).resolves.toEqual(unknown);
    expect(run).toHaveBeenCalledWith(
      { kind: "native", path: "/usr/bin/security" },
      ["find-generic-password", "-s", "gemini", "-a", "antigravity"],
      { timeoutMs: 2_000 },
    );
  });

  it("finds the Linux keyring entry through the Secret Service's item search", async () => {
    const found = "([objectpath '/org/freedesktop/secrets/collection/login/7'], @ao [])\n";
    run.mockResolvedValueOnce({ code: 0, stdout: found, stderr: "", timedOut: false });
    await expect(readAgyAuth(home, { GEMINI_API_KEY: " " }, "linux")).resolves.toEqual(oauth);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0] ?? [];
    expect(command).toEqual({ kind: "native", path: "gdbus" });
    expect(args).toContain("org.freedesktop.Secret.Service.SearchItems");
    expect(args).toContain("{'service': 'gemini', 'username': 'antigravity'}");
  });

  it("counts a locked Linux item, and searches the other account attribute", async () => {
    const none = "(@ao [], @ao [])\n";
    const locked = "(@ao [], [objectpath '/org/freedesktop/secrets/collection/login/2'])\n";
    run.mockResolvedValueOnce({ code: 0, stdout: none, stderr: "", timedOut: false });
    run.mockResolvedValueOnce({ code: 0, stdout: locked, stderr: "", timedOut: false });
    await expect(readAgyAuth(home, {}, "linux")).resolves.toEqual(oauth);
    expect(run.mock.calls[1]?.[1]).toContain("{'service': 'gemini', 'account': 'antigravity'}");
  });

  it("falls back to busctl without gdbus, and reports unknown when nothing answers", async () => {
    const missing = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      error: new Error("ENOENT"),
    };
    run.mockResolvedValueOnce(missing);
    run.mockResolvedValueOnce({
      code: 0,
      stdout: 'ao 1 "/org/freedesktop/secrets/collection/login/3" ao 0\n',
      stderr: "",
      timedOut: false,
    });
    await expect(readAgyAuth(home, {}, "linux")).resolves.toEqual(oauth);
    expect(run.mock.calls[1]?.[0]).toEqual({ kind: "native", path: "busctl" });
    run.mockReset();
    run.mockResolvedValue(missing);
    await expect(readAgyAuth(home, {}, "linux")).resolves.toEqual(unknown);
    // Only item paths are ever asked for: no secret is retrieved.
    for (const [, args] of run.mock.calls) {
      expect(args.join(" ")).not.toMatch(/GetSecret|lookup|--show-secret/i);
    }
  });
});
