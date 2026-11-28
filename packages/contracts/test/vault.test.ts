import { describe, expect, it } from "vitest";
import {
  CreateVaultGrantRequest,
  CreateVaultItemRequest,
  UpdateVaultItemRequest,
  VaultDestination,
  VaultItemId,
} from "../src/vault";

describe("Vault contracts", () => {
  it("takes an API credential or an env secret, with a value long enough to hide", () => {
    const key = { kind: "api-credential", name: "Key", provider: "sarvam-ai", value: "12345678" };
    expect(CreateVaultItemRequest.safeParse(key).success).toBe(true);
    expect(CreateVaultItemRequest.safeParse({ ...key, value: "1234567" }).success).toBe(false);
    expect(CreateVaultItemRequest.safeParse({ ...key, provider: "Sarvam AI" }).success).toBe(false);
    const env = { kind: "env-secret", name: "Db", envName: "DATABASE_URL", value: "postgres://x" };
    expect(CreateVaultItemRequest.safeParse(env).success).toBe(true);
    expect(CreateVaultItemRequest.safeParse({ ...env, envName: "1BAD" }).success).toBe(false);
    expect(CreateVaultItemRequest.safeParse({ ...env, kind: "login" }).success).toBe(false);
  });

  it("needs something to change", () => {
    expect(UpdateVaultItemRequest.safeParse({}).success).toBe(false);
    expect(UpdateVaultItemRequest.safeParse({ name: "New" }).success).toBe(true);
  });

  it.each([
    ["connection:anthropic", true],
    ["mcp:github", true],
    ["origin:https://staging.example.com:8443", true],
    ["origin:https://example.com/login", false],
    ["anthropic", false],
    ["connection:", false],
  ])("reads %s as a destination: %s", (value, ok) => {
    expect(VaultDestination.safeParse(value).success).toBe(ok);
  });

  it("leaves a grant's bounds open unless set", () => {
    const itemId = `vlt_${"0".repeat(32)}`;
    expect(VaultItemId.safeParse(itemId).success).toBe(true);
    expect(CreateVaultGrantRequest.parse({ itemId })).toEqual({
      itemId,
      role: null,
      projectId: null,
      destination: null,
      expiresAt: null,
    });
  });
});
