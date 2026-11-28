import { Connection } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { connections } from "../src/db/schema";
import { connectionDestination } from "../src/services/connections/connection-service";
import { connectionEnv, TEST_KEY as KEY, providerStub } from "./support/connection-env";

/** A connection's key goes only where it was granted, and nothing carries it back. */

const models = { body: { data: [{ id: "claude-x" }], has_more: false } };
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

async function setup(fetchStub: typeof fetch) {
  const env = await connectionEnv(fetchStub);
  dispose = env.dispose;
  return env;
}

async function keyed(fetchStub: typeof fetch) {
  const env = await setup(fetchStub);
  const key = env.vault.create({
    kind: "api-credential",
    name: "Key",
    provider: "anthropic",
    value: KEY,
  });
  const made = await env.service.create({ name: "A", provider: "anthropic", vaultItemId: key.id });
  return { ...env, key, made };
}

const compatible = (baseUrl: string) => ({
  name: "Host",
  provider: "openai-compatible" as const,
  baseUrl,
});

describe("a connection's key", () => {
  it("doesn't follow a redirect", async () => {
    const { fetch, seen } = providerStub(() => ({ status: 307 }));
    const { made } = await keyed(fetch);
    expect(made.level).toBe("credential_found");
    expect(made.lastCheck?.message).toMatch(/sent the request elsewhere/);
    expect(seen).toHaveLength(1);
  });

  it("isn't kept when a server echoes it as a model id or name", async () => {
    const { fetch } = providerStub(() => ({
      body: { data: [{ id: KEY }, { id: "ok", display_name: `name ${KEY}` }], has_more: false },
    }));
    const { made, db } = await keyed(fetch);
    expect(made.models).toEqual([{ id: "ok", name: "name [redacted]", manual: false }]);
    expect(JSON.stringify(db.select().from(connections).all())).not.toContain(KEY);
  });

  it("isn't sent, or quoted, when it can't go in a header", async () => {
    const { fetch, seen } = providerStub(() => models);
    const env = await setup(fetch);
    const bad = env.vault.create({
      kind: "api-credential",
      name: "Pasted",
      provider: "anthropic",
      value: ` ${KEY}\nx `,
    });
    const made = await env.service.create({
      name: "A",
      provider: "anthropic",
      vaultItemId: bad.id,
    });
    expect(made.lastCheck?.message).toMatch(/can't carry/);
    expect(JSON.stringify(made)).not.toContain(KEY);
    expect(seen).toHaveLength(0);
  });

  it("isn't quoted by a transport failure, which is named in fixed words", async () => {
    const failing = (async () => {
      throw Object.assign(new Error(`bad header ${KEY}`), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const { made } = await keyed(failing);
    expect(made.lastCheck?.message).toBe("Couldn't reach api.anthropic.com: ECONNREFUSED");
  });

  it("stops being granted when the address changes, until it is chosen again", async () => {
    const { fetch, seen } = providerStub(() => models);
    const { service, vault, key, made } = await keyed(fetch);
    const calls = seen.length;
    const moved = await service.update(made.id, { baseUrl: "https://proxy.example.test/v1" });
    expect(moved).toMatchObject({ level: "configured", verifiedAt: null });
    expect(moved.lastCheck?.message).toMatch(/address changed/);
    expect(vault.listGrants(key.id)).toEqual([]);
    expect(seen.length).toBe(calls);

    const again = await service.update(made.id, { vaultItemId: key.id });
    expect(again.level).toBe("verified");
    expect(seen.at(-1)?.url).toContain("proxy.example.test");
  });

  it("goes over plain http only to this computer or a private network", async () => {
    const { fetch } = providerStub(() => models);
    const { service, vault } = await setup(fetch);
    const key = vault.create({ kind: "api-credential", name: "K", provider: "local", value: KEY });
    await expect(
      service.create({ ...compatible("http://llm.example.com/v1"), vaultItemId: key.id }),
    ).rejects.toMatchObject({ code: "connection_insecure" });
    for (const url of [
      "http://127.0.0.1:8000/v1",
      "http://192.168.1.9/v1",
      "http://box.local/v1",
    ]) {
      const made = await service.create({ ...compatible(url), vaultItemId: key.id });
      expect(made.level).toBe("verified");
    }
  });

  it("is used only under the connection's own grant, and stops between pages if that goes", async () => {
    let onFirstPage: (() => void) | null = null;
    const { fetch, seen } = providerStub((url) => {
      if (!url.searchParams.get("after_id")) {
        onFirstPage?.();
        return { body: { data: [{ id: "m-1" }], has_more: true, last_id: "m-1" } };
      }
      return { body: { data: [{ id: "m-2" }], has_more: false } };
    });
    const { service, vault, key, made } = await keyed(fetch);
    const revokeOwn = () => {
      for (const g of vault.listGrants(key.id)) {
        if (g.destination === connectionDestination(made.id)) vault.revoke(g.id);
      }
    };
    // A broad grant the owner made for something else doesn't count.
    vault.grant({ itemId: key.id });
    revokeOwn();
    const calls = seen.length;
    expect((await service.check(made.id)).level).toBe("configured");
    expect(seen.length).toBe(calls);

    await service.update(made.id, { vaultItemId: key.id });
    onFirstPage = revokeOwn;
    const before = seen.length;
    const after = await service.check(made.id);
    expect(after.lastCheck?.message).toMatch(/stopped being granted/);
    expect(seen.length - before).toBe(1);
  });
});

describe("connection checks", () => {
  it("drop a result that finished after the address changed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slow = false;
    const fetchStub = (async (input: string | URL | Request) => {
      if (slow && String(input).includes("old.example.test")) await gate;
      return new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 });
    }) as typeof fetch;
    const { service } = await setup(fetchStub);
    const made = await service.create(compatible("https://old.example.test/v1"));
    slow = true;
    const pending = service.check(made.id);
    await service.update(made.id, { baseUrl: "https://new.example.test/v1" });
    const fresh = service.get(made.id);
    release();
    await pending;
    expect(service.get(made.id).lastCheck).toEqual(fresh.lastCheck);
  });

  it("keep hand-entered ids, even ones a list once had", async () => {
    let listing = true;
    const { fetch } = providerStub(() =>
      listing ? { body: { data: [{ id: "a" }] } } : { status: 404 },
    );
    const { service } = await setup(fetch);
    const made = await service.create(compatible("https://llm.example.test/v1"));
    await service.update(made.id, { manualModels: ["a", "b"] });
    expect(service.get(made.id).models.map((m) => [m.id, m.manual])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    listing = false;
    const after = await service.check(made.id);
    expect(after.models.map((m) => [m.id, m.manual])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  it("keep a list within the contract, so one odd id can't break the page", async () => {
    const { fetch } = providerStub(() => ({
      body: { data: [{ id: "x".repeat(201) }, { id: "fine", name: "n".repeat(300) }] },
    }));
    const { service } = await setup(fetch);
    const made = await service.create(compatible("https://llm.example.test/v1"));
    expect(Connection.parse(made).models).toEqual([
      { id: "fine", name: "n".repeat(200), manual: false },
    ]);
  });

  it("stop reading an answer that is too large", async () => {
    const item = '{"id":"m"},';
    const huge = (async () =>
      new Response(`{"data":[${item.repeat(500_000)}{"id":"z"}]}`, {
        status: 200,
      })) as unknown as typeof fetch;
    const { service } = await setup(huge);
    const made = await service.create(compatible("https://llm.example.test/v1"));
    expect(made.lastCheck?.message).toMatch(/too much data/);
  });
});

describe("base URLs", () => {
  it.each([
    ["https://user:pass@llm.example.test/v1"],
    ["https://llm.example.test/v1?"],
    ["https://llm.example.test/v1#"],
    ["ftp://llm.example.test/v1"],
  ])("refuse %s", async (baseUrl) => {
    const { fetch } = providerStub(() => models);
    const { service } = await setup(fetch);
    await expect(service.create(compatible(baseUrl))).rejects.toBeTruthy();
  });
});
