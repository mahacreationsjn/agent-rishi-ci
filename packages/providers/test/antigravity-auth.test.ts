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

  it("reports unknown on Linux without querying the keyring", async () => {
    await expect(readAgyAuth(home, { GEMINI_API_KEY: " " }, "linux")).resolves.toEqual(unknown);
    expect(run).not.toHaveBeenCalled();
  });
});
