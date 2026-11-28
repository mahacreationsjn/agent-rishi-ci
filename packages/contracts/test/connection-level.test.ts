import { describe, expect, it } from "vitest";
import { ConnectionLevel, hasConnectionLevel, ProviderStatus, SetupCheck } from "../src";

const ts = "2026-11-28T10:00:00.000Z";

const status = {
  providerId: "gemini",
  installed: true,
  version: "0.70.0",
  executablePath: "/usr/bin/gemini",
  loggedIn: true,
  authMethod: "oauth-personal",
  account: null,
  loginExpiresAt: null,
  supported: true,
  issues: [],
  checkedAt: ts,
};

describe("connection levels", () => {
  it("round-trips a verified provider status and setup check through JSON", () => {
    const verified = { ...status, level: "verified", verifiedAt: ts };
    expect(ProviderStatus.parse(JSON.parse(JSON.stringify(verified)))).toEqual(verified);
    const check = {
      id: "gemini",
      label: "Gemini CLI",
      state: "ok",
      installed: true,
      version: "0.70.0",
      executablePath: "/usr/bin/gemini",
      loggedIn: true,
      authMethod: "oauth-personal",
      account: null,
      loginExpiresAt: null,
      message: "Signed in and verified",
      fix: null,
      durationMs: 12,
      level: "verified",
      verifiedAt: ts,
    };
    expect(SetupCheck.parse(JSON.parse(JSON.stringify(check)))).toEqual(check);
  });

  it("accepts a status without a level (a bare adapter, an older runner) and a null one", () => {
    expect(ProviderStatus.parse(status).level).toBeUndefined();
    expect(ProviderStatus.parse({ ...status, level: null, verifiedAt: null }).level).toBeNull();
  });

  it("refuses an unknown level", () => {
    expect(ConnectionLevel.safeParse("ready").success).toBe(false);
    expect(ProviderStatus.safeParse({ ...status, level: "signed_in" }).success).toBe(false);
  });

  it("orders the levels: configured < credential found < verified", () => {
    expect(hasConnectionLevel("verified", "credential_found")).toBe(true);
    expect(hasConnectionLevel("credential_found", "credential_found")).toBe(true);
    expect(hasConnectionLevel("configured", "credential_found")).toBe(false);
    expect(hasConnectionLevel(null, "configured")).toBe(false);
    expect(hasConnectionLevel(undefined, "configured")).toBe(false);
  });
});
