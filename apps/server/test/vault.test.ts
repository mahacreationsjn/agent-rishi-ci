import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultItem } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { vaultItems } from "../src/db/schema";
import { ensureLocalOwner } from "../src/services/owner";
import { MemorySecretStore, type SecretStore } from "../src/services/secrets";
import { newDataKey, open, seal, VaultSealError } from "../src/services/vault/crypto";
import { VaultService } from "../src/services/vault/vault-service";

const KEY_VALUE = "sk-test-0123456789abcdefghij";
const OTHER_VALUE = "postgres://app:s3cretpass@db/app";

let dir: string;
let databases: Array<{ close(): void }>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-vault-"));
  databases = [];
});
afterEach(() => {
  for (const d of databases) d.close();
  rmSync(dir, { recursive: true, force: true });
});

function db(name = "agent-rishi.db") {
  const database = openDatabase(join(dir, name));
  databases.push(database);
  return database.db;
}

async function vault(opts: { file?: string; keys?: SecretStore; now?: () => Date } = {}) {
  const d = db(opts.file);
  const service = new VaultService({
    db: d,
    keys: opts.keys ?? new MemorySecretStore(),
    owner: ensureLocalOwner(d),
    allowMemoryKey: true,
    now: opts.now,
  });
  await service.open();
  return { service, db: d };
}

const apiKey = { kind: "api-credential", name: "Anthropic key", provider: "anthropic" } as const;
const use = { role: "agent", projectId: "p1", destination: "connection:anthropic" };

describe("Vault sealing", () => {
  const ctx = { id: "vlt_1", owner: "own_1", purpose: "api-credential" };

  it("opens what it sealed, and only with the same key and context", () => {
    const key = newDataKey();
    const sealed = seal(key, KEY_VALUE, ctx);
    expect(sealed).not.toContain(KEY_VALUE);
    expect(open(key, sealed, ctx)).toBe(KEY_VALUE);
    expect(() => open(newDataKey(), sealed, ctx)).toThrow(VaultSealError);
    expect(() => open(key, sealed, { ...ctx, id: "vlt_2" })).toThrow(VaultSealError);
    expect(() => open(key, sealed, { ...ctx, owner: "own_2" })).toThrow(VaultSealError);
    expect(() => open(key, sealed, { ...ctx, purpose: "env-secret" })).toThrow(VaultSealError);
  });

  it("refuses a damaged value", () => {
    const key = newDataKey();
    const [v, iv, tag, body] = seal(key, KEY_VALUE, ctx).split(".");
    const flipped = `${body?.[0] === "A" ? "B" : "A"}${body?.slice(1)}`;
    expect(() => open(key, [v, iv, tag, flipped].join("."), ctx)).toThrow(VaultSealError);
    expect(() => open(key, "v0.x.y.z", ctx)).toThrow(VaultSealError);
  });
});

describe("the Vault", () => {
  it("makes its key on the first start and reads its items after a restart", async () => {
    const keys = new MemorySecretStore();
    const first = await vault({ keys });
    expect(first.service.status()).toEqual({ state: "ready", reason: null, items: 0 });
    expect(await keys.get("vault.dataKey")).not.toBeNull();
    const item = first.service.create({ ...apiKey, value: KEY_VALUE });

    const again = await vault({ keys });
    expect(again.service.status().state).toBe("ready");
    expect(again.service.get(item.id)).toMatchObject({ name: "Anthropic key", readable: true });
    expect(again.service.knownValues()).toEqual([KEY_VALUE]);
  });

  it("never shows a value, and stores only ciphertext", async () => {
    const { service, db: d } = await vault();
    const made = service.create({ ...apiKey, value: KEY_VALUE });
    const env = service.create({
      kind: "env-secret",
      name: "Database",
      envName: "DATABASE_URL",
      value: OTHER_VALUE,
    });
    const shown = JSON.stringify([made, env, service.list(), service.get(made.id)]);
    expect(shown).not.toContain(KEY_VALUE);
    expect(shown).not.toContain(OTHER_VALUE);
    for (const item of service.list()) expect(VaultItem.safeParse(item).success).toBe(true);
    const stored = JSON.stringify(d.select().from(vaultItems).all());
    expect(stored).not.toContain(KEY_VALUE);
    expect(stored).not.toContain(OTHER_VALUE);
  });

  it("is unavailable without a keychain, rather than keeping a key that won't survive", async () => {
    const d = db();
    const keys = new MemorySecretStore();
    const service = new VaultService({ db: d, keys, owner: ensureLocalOwner(d) });
    expect((await service.open()).state).toBe("unavailable");
    expect(await keys.get("vault.dataKey")).toBeNull();
    expect(() => service.create({ ...apiKey, value: KEY_VALUE })).toThrow(
      expect.objectContaining({ status: 503, code: "vault_unavailable" }),
    );
  });

  it("locks when its key is missing, never re-creating it while items remain", async () => {
    const keys = new MemorySecretStore();
    const first = await vault({ keys });
    const item = first.service.create({ ...apiKey, value: KEY_VALUE });
    await keys.delete("vault.dataKey");

    const { service } = await vault({ keys });
    expect(service.status()).toMatchObject({ state: "locked", items: 1 });
    expect(service.status().reason).toMatch(/missing from the OS keychain/);
    expect(await keys.get("vault.dataKey")).toBeNull();
    expect(service.get(item.id).readable).toBe(false);
    expect(() => service.create({ ...apiKey, value: KEY_VALUE })).toThrow(
      expect.objectContaining({ code: "vault_locked" }),
    );
    expect(() => service.update(item.id, { value: "another-value-1234" })).toThrow(
      expect.objectContaining({ code: "vault_locked" }),
    );
    expect(() => service.use(item.id, use)).toThrow(
      expect.objectContaining({ code: "vault_locked" }),
    );
    // Renaming needs no key; deleting the last item starts an empty Vault with a new key.
    expect(service.update(item.id, { name: "Old key" }).name).toBe("Old key");
    await service.delete(item.id);
    expect(service.status()).toEqual({ state: "ready", reason: null, items: 0 });
    expect(await keys.get("vault.dataKey")).not.toBeNull();
  });

  it("locks with another keychain's key (a restore on another computer), changing nothing", async () => {
    const first = await vault({ file: "a.db" });
    first.service.create({ ...apiKey, value: KEY_VALUE });
    databases.pop()?.close();

    const elsewhere = new MemorySecretStore();
    await elsewhere.set("vault.dataKey", newDataKey().toString("base64"));
    const theirs = await elsewhere.get("vault.dataKey");
    const { service } = await vault({ file: "a.db", keys: elsewhere });
    expect(service.status().state).toBe("locked");
    expect(service.status().reason).toMatch(/doesn't match/);
    expect(await elsewhere.get("vault.dataKey")).toBe(theirs);
  });

  it("marks a value copied onto another item unreadable, and still deletes it", async () => {
    const keys = new MemorySecretStore();
    const first = await vault({ keys });
    const a = first.service.create({ ...apiKey, value: KEY_VALUE });
    const b = first.service.create({ ...apiKey, name: "Second", value: "sk-other-0123456789xyz" });
    const sealedA = first.db
      .select()
      .from(vaultItems)
      .all()
      .find((r) => r.id === a.id)?.sealed;
    first.db
      .update(vaultItems)
      .set({ sealed: sealedA ?? "" })
      .run();

    const { service } = await vault({ keys });
    expect(service.status().state).toBe("ready");
    expect(service.get(a.id).readable).toBe(true);
    expect(service.get(b.id).readable).toBe(false);
    expect(() => service.use(b.id, use)).toThrow(
      expect.objectContaining({ code: "vault_unreadable" }),
    );
    await service.delete(b.id);
    expect(service.list().map((i) => i.id)).toEqual([a.id]);
  });
});

describe("Vault grants", () => {
  let clock = new Date("2026-11-28T00:00:00.000Z");
  const now = () => clock;
  beforeEach(() => {
    clock = new Date("2026-11-28T00:00:00.000Z");
  });

  it("applies an item only where a grant allows it, and audits both", async () => {
    const { service } = await vault({ now });
    const item = service.create({ ...apiKey, value: KEY_VALUE });
    expect(() => service.use(item.id, { ...use, sessionId: "s1" })).toThrow(
      expect.objectContaining({ status: 403, code: "vault_grant_needed" }),
    );

    const grant = service.grant({ itemId: item.id, role: "agent", projectId: "p1" });
    expect(grant).toMatchObject({ destination: null, expiresAt: null, scope: "personal" });
    expect(service.use(item.id, { ...use, sessionId: "s1" })).toBe(KEY_VALUE);
    expect(service.get(item.id).lastUsedAt).toBe(clock.toISOString());
    expect(() => service.use(item.id, { ...use, role: "pm" })).toThrow(
      expect.objectContaining({ code: "vault_grant_needed" }),
    );
    expect(() => service.use(item.id, { ...use, projectId: "p2" })).toThrow(
      expect.objectContaining({ code: "vault_grant_needed" }),
    );

    service.revoke(grant.id);
    expect(() => service.use(item.id, use)).toThrow(
      expect.objectContaining({ code: "vault_grant_needed" }),
    );

    const audit = service.audit({ limit: 100 });
    expect(audit.map((e) => e.action).reverse()).toEqual([
      "item.created",
      "item.use_refused",
      "grant.created",
      "item.used",
      "item.use_refused",
      "item.use_refused",
      "grant.revoked",
      "item.use_refused",
    ]);
    expect(audit.find((e) => e.action === "item.used")).toMatchObject({
      sessionId: "s1",
      grantId: grant.id,
      itemName: "Anthropic key",
    });
    expect(JSON.stringify(audit)).not.toContain(KEY_VALUE);
  });

  it("ends a grant when it expires, and refuses one that already has", async () => {
    const { service } = await vault({ now });
    const item = service.create({ ...apiKey, value: KEY_VALUE });
    service.grant({ itemId: item.id, expiresAt: "2026-11-28T01:00:00.000Z" });
    expect(service.use(item.id, use)).toBe(KEY_VALUE);
    clock = new Date("2026-11-28T01:00:00.000Z");
    expect(() => service.use(item.id, use)).toThrow(
      expect.objectContaining({ code: "vault_grant_needed" }),
    );
    expect(() => service.grant({ itemId: item.id, expiresAt: "2026-11-27T00:00:00.000Z" })).toThrow(
      expect.objectContaining({ code: "grant_expired" }),
    );
  });

  it("deletes an item's grants with it and keeps its audit", async () => {
    const { service } = await vault({ now });
    const item = service.create({ ...apiKey, value: KEY_VALUE });
    service.grant({ itemId: item.id, destination: "connection:anthropic" });
    await service.delete(item.id);
    expect(service.listGrants()).toEqual([]);
    expect(service.knownValues()).toEqual([]);
    expect(service.audit({ itemId: item.id, limit: 10 }).map((e) => e.action)).toEqual([
      "item.deleted",
      "grant.created",
      "item.created",
    ]);
  });
});
