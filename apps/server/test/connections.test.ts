import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/client";
import { connections } from "../src/db/schema";
import {
  ConnectionService,
  connectionDestination,
} from "../src/services/connections/connection-service";
import { listModels, ModelListError } from "../src/services/connections/model-list";
import { ensureLocalOwner } from "../src/services/owner";
import { MemorySecretStore } from "../src/services/secrets";
import { VaultService } from "../src/services/vault/vault-service";

const KEY = "sk-ant-test-0123456789abcdef";

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** A provider stub: answers by path, and records each request's URL and headers. */
function stub(answer: (url: URL) => { status?: number; body?: unknown }) {
  const seen: Seen[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), headers: Object.fromEntries(new Headers(init?.headers)) });
    const { status = 200, body = {} } = answer(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, seen };
}

let dir: string;
let close: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-connections-"));
});
afterEach(() => {
  close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function setup(fetchStub: typeof fetch) {
  const database = openDatabase(join(dir, "agent-rishi.db"));
  close = () => database.close();
  const owner = ensureLocalOwner(database.db);
  const vault = new VaultService({
    db: database.db,
    keys: new MemorySecretStore(),
    owner,
    allowMemoryKey: true,
  });
  await vault.open();
  const service = new ConnectionService({ db: database.db, vault, owner, fetch: fetchStub });
  return { service, vault, db: database.db };
}

describe("listing a provider's models", () => {
  it("pages Anthropic's list with its own headers", async () => {
    const { fetch, seen } = stub((url) =>
      url.searchParams.get("after_id")
        ? { body: { data: [{ id: "m-3" }], has_more: false } }
        : {
            body: {
              data: [{ id: "m-1", display_name: "One" }, { id: "m-2" }],
              has_more: true,
              last_id: "m-2",
            },
          },
    );
    const models = await listModels({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      key: KEY,
      fetch,
    });
    expect(models).toEqual([
      { id: "m-1", name: "One" },
      { id: "m-2", name: null },
      { id: "m-3", name: null },
    ]);
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]?.headers["anthropic-version"]).toBeTruthy();
    expect(seen[1]?.url).toContain("after_id=m-2");
  });

  it("keeps only Gemini models that generate content", async () => {
    const { fetch, seen } = stub(() => ({
      body: {
        models: [
          {
            name: "models/g-pro",
            displayName: "Pro",
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/g-embed", supportedGenerationMethods: ["embedContent"] },
        ],
      },
    }));
    const models = await listModels({
      provider: "gemini",
      baseUrl: "https://g/v1beta",
      key: KEY,
      fetch,
    });
    expect(models).toEqual([{ id: "g-pro", name: "Pro" }]);
    expect(seen[0]?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("asks OpenAI-style servers with a bearer key, or none for a local server", async () => {
    const { fetch, seen } = stub(() => ({ body: { data: [{ id: "llama3" }] } }));
    await listModels({ provider: "xai", baseUrl: "https://api.x.ai/v1", key: KEY, fetch });
    await listModels({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      key: null,
      fetch,
    });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[1]?.headers.authorization).toBeUndefined();
    expect(seen[1]?.url).toBe("http://127.0.0.1:11434/v1/models");
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "unsupported"],
    [500, "failed"],
  ] as const)("reads HTTP %i as %s, never echoing the key", async (status, reason) => {
    const { fetch } = stub(() => ({ status }));
    const error = await listModels({
      provider: "openai",
      baseUrl: "https://o/v1",
      key: KEY,
      fetch,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelListError);
    expect((error as ModelListError).reason).toBe(reason);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("hides the key if an unreachable server's error repeats it", async () => {
    const failing = (async () => {
      throw new Error(`connect refused for ${KEY}`);
    }) as unknown as typeof fetch;
    const error = (await listModels({
      provider: "openai",
      baseUrl: "https://o/v1",
      key: KEY,
      fetch: failing,
    }).catch((e: unknown) => e)) as ModelListError;
    expect(error.reason).toBe("failed");
    expect(error.message).not.toContain(KEY);
  });
});

describe("connections", () => {
  const models = {
    body: { data: [{ id: "claude-x", display_name: "Claude X" }], has_more: false },
  };

  it("is verified once its models list, with its key granted to it alone", async () => {
    const { fetch } = stub(() => models);
    const { service, vault, db } = await setup(fetch);
    const key = vault.create({
      kind: "api-credential",
      name: "Key",
      provider: "anthropic",
      value: KEY,
    });
    const made = await service.create({
      name: "Anthropic",
      provider: "anthropic",
      vaultItemId: key.id,
    });
    expect(Connection.parse(made)).toMatchObject({
      kind: "api-key",
      level: "verified",
      lastCheck: { ok: true, message: "Listed 1 model" },
      models: [{ id: "claude-x", name: "Claude X", manual: false }],
    });
    expect(made.verifiedAt).not.toBeNull();
    expect(vault.listGrants(key.id)).toMatchObject([
      { destination: connectionDestination(made.id), role: null, projectId: null },
    ]);
    expect(JSON.stringify([made, db.select().from(connections).all()])).not.toContain(KEY);
    expect(vault.audit({ itemId: key.id, limit: 5 }).map((e) => e.action)).toContain("item.used");
  });

  it("drops below verified when the key is refused, and says why", async () => {
    let status = 200;
    const { fetch } = stub(() => (status === 200 ? models : { status }));
    const { service, vault } = await setup(fetch);
    const key = vault.create({
      kind: "api-credential",
      name: "Key",
      provider: "anthropic",
      value: KEY,
    });
    const made = await service.create({ name: "A", provider: "anthropic", vaultItemId: key.id });
    status = 401;
    const after = await service.check(made.id);
    expect(after).toMatchObject({ level: "credential_found", verifiedAt: null });
    expect(after.lastCheck?.message).toMatch(/refused the key/);
  });

  it("stops using a key whose grant was removed in the Vault", async () => {
    const { fetch, seen } = stub(() => models);
    const { service, vault } = await setup(fetch);
    const key = vault.create({
      kind: "api-credential",
      name: "Key",
      provider: "anthropic",
      value: KEY,
    });
    const made = await service.create({ name: "A", provider: "anthropic", vaultItemId: key.id });
    for (const g of vault.listGrants(key.id)) vault.revoke(g.id);
    const calls = seen.length;
    const after = await service.check(made.id);
    expect(after.level).toBe("configured");
    expect(after.lastCheck?.message).toMatch(/isn't granted/);
    expect(seen.length).toBe(calls);
  });

  it("refuses a key for another provider, or an environment variable", async () => {
    const { fetch } = stub(() => models);
    const { service, vault } = await setup(fetch);
    const openai = vault.create({
      kind: "api-credential",
      name: "O",
      provider: "openai",
      value: KEY,
    });
    const env = vault.create({ kind: "env-secret", name: "E", envName: "E", value: KEY });
    await expect(
      service.create({ name: "A", provider: "anthropic", vaultItemId: openai.id }),
    ).rejects.toMatchObject({ code: "connection_key_provider" });
    await expect(
      service.create({ name: "A", provider: "anthropic", vaultItemId: env.id }),
    ).rejects.toMatchObject({ code: "connection_key_kind" });
  });

  it("lists Sarvam AI's models from its V2 API, with its own key header", async () => {
    // The shape Sarvam AI answered with on 2026-11-28 (ids changed).
    const { fetch, seen } = stub(() => ({
      body: {
        object: "list",
        data: [
          { id: "sarvam-a", owned_by: "sarvam", access: "standard", created: 0 },
          { id: "open-b", owned_by: "open-source", access: "provisioned", created: 0 },
        ],
      },
    }));
    const { service, vault } = await setup(fetch);
    const key = vault.create({
      kind: "api-credential",
      name: "S",
      provider: "sarvam-ai",
      value: KEY,
    });
    const made = await service.create({
      name: "Sarvam",
      provider: "sarvam-ai",
      vaultItemId: key.id,
    });
    expect(made.level).toBe("verified");
    expect(made.models.map((m) => m.id)).toEqual(["sarvam-a", "open-b"]);
    expect(seen[0]?.url).toBe("https://api.sarvam.ai/v2/models");
    expect(seen[0]?.headers["api-subscription-key"]).toBe(KEY);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("keeps hand-entered models for a server that doesn't list them", async () => {
    const { fetch } = stub(() => ({ status: 404 }));
    const { service, vault } = await setup(fetch);
    const key = vault.create({
      kind: "api-credential",
      name: "S",
      provider: "local",
      value: KEY,
    });
    const made = await service.create({
      name: "Host",
      provider: "openai-compatible",
      baseUrl: "https://llm.example.test/v1",
      vaultItemId: key.id,
    });
    expect(made.level).toBe("credential_found");
    expect(made.lastCheck?.message).toMatch(/Add its model IDs by hand/);
    const withModels = await service.update(made.id, { manualModels: ["sarvam-m", "sarvam-m"] });
    expect(withModels.models).toEqual([{ id: "sarvam-m", name: null, manual: true }]);
    expect((await service.check(made.id)).models).toEqual(withModels.models);
  });

  it("lists a keyless local server, and removes its grants when deleted", async () => {
    const { fetch } = stub(() => ({ body: { data: [{ id: "qwen3" }] } }));
    const { service, vault } = await setup(fetch);
    const local = await service.create({
      name: "Ollama",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(local).toMatchObject({ kind: "compatible", level: "verified", vaultItemId: null });

    const key = vault.create({
      kind: "api-credential",
      name: "Key",
      provider: "anthropic",
      value: KEY,
    });
    const keyed = await service.create({ name: "A", provider: "anthropic", vaultItemId: key.id });
    service.delete(keyed.id);
    expect(vault.listGrants(key.id)).toEqual([]);
    expect(service.list().map((c) => c.id)).toEqual([local.id]);
  });

  it("moves the grant when the key changes", async () => {
    const { fetch } = stub(() => models);
    const { service, vault } = await setup(fetch);
    const a = vault.create({
      kind: "api-credential",
      name: "A",
      provider: "anthropic",
      value: KEY,
    });
    const b = vault.create({
      kind: "api-credential",
      name: "B",
      provider: "anthropic",
      value: `${KEY}-b`,
    });
    const made = await service.create({ name: "A", provider: "anthropic", vaultItemId: a.id });
    await service.update(made.id, { vaultItemId: b.id });
    expect(vault.listGrants(a.id)).toEqual([]);
    expect(vault.listGrants(b.id).map((g) => g.destination)).toEqual([
      connectionDestination(made.id),
    ]);
  });
});
