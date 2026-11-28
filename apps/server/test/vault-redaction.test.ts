import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NewEvent, REDACTED, VaultAuditEntry, VaultStatus } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import {
  hideFragments,
  hideValues,
  redactEvent,
  sortValues,
} from "../src/services/vault/redaction";
import { removeTree } from "./support/remove-tree";

const VALUE = "sk-test-0123456789abcdefghij";
const values = sortValues([VALUE]);

describe("hiding Vault values", () => {
  it("hides every whole value, longest first", () => {
    const short = "abcdefgh1234";
    const long = `${short}-and-more-5678`;
    expect(hideValues(`a ${long} b ${short} c`, sortValues([short, long]))).toBe(
      `a ${REDACTED} b ${REDACTED} c`,
    );
    expect(hideValues("nothing here", values)).toBe("nothing here");
  });

  it("hides a value split across streamed chunks", () => {
    const chunks = ["export KEY=sk-te", "st-0123456789", "abcdefghij && run"];
    expect(chunks.map((c) => hideFragments(c, values))).toEqual([
      `export KEY=${REDACTED}`,
      REDACTED,
      `${REDACTED} && run`,
    ]);
    // Ordinary text keeps going.
    expect(hideFragments("sk-tests pass", values)).toBe("sk-tests pass");
    expect(hideFragments("abc", values)).toBe("abc");
  });

  it("redacts every string in an event, and streamed deltas at their edges", () => {
    const message: NewEvent = {
      type: "message.edited",
      sessionId: null,
      payload: {
        sessionId: "s1",
        messageId: "m1",
        text: `use ${VALUE}`,
        at: "2026-11-28T00:00:00Z",
      },
    };
    expect(redactEvent(message, values).payload).toMatchObject({ text: `use ${REDACTED}` });
    expect(redactEvent(message, [])).toBe(message);

    const delta = {
      type: "agent.item.delta",
      sessionId: "s1",
      payload: {
        type: "item.delta",
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        delta: { type: "tool_output", text: "KEY=sk-test-01" },
      },
    } as NewEvent;
    expect(redactEvent(delta, values).payload).toMatchObject({
      itemId: "i1",
      delta: { type: "tool_output", text: `KEY=${REDACTED}` },
    });
  });
});

describe("the Vault in a running server", () => {
  const TOKEN = "b".repeat(64);
  let home: string;
  let server: RunningServer;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "agent-rishi-vault-routes-"));
    server = await startServer({
      port: 0,
      dataDir: join(home, "data"),
      token: TOKEN,
      runner: false,
      secrets: "memory",
      checkSetupOnStart: false,
      userHome: join(home, "user"),
    });
  });
  afterEach(async () => {
    await server.close();
    await removeTree(home);
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/vault${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  };

  it("takes values in but never gives them back", async () => {
    const status = await call("GET", "/status");
    expect(VaultStatus.parse(status.json())).toEqual({ state: "ready", reason: null, items: 0 });

    const made = await call("POST", "/items", {
      kind: "api-credential",
      name: "xAI",
      provider: "xai",
      value: VALUE,
    });
    expect(made.status).toBe(201);
    const id = made.json().id as string;
    const grant = await call("POST", "/grants", { itemId: id, role: "agent" });
    expect(grant.status).toBe(201);
    const renamed = await call("PATCH", `/items/${id}`, { name: "xAI key" });

    const reads = [
      made,
      grant,
      renamed,
      await call("GET", "/items"),
      await call("GET", `/items/${id}`),
      await call("GET", `/grants?itemId=${id}`),
      await call("GET", "/audit"),
    ];
    for (const r of reads) {
      expect(r.status).toBeLessThan(300);
      expect(r.text).not.toContain(VALUE);
    }
    const entries = (reads[6]?.json().entries ?? []) as unknown[];
    expect(entries.map((e) => VaultAuditEntry.parse(e).action)).toEqual([
      "item.renamed",
      "grant.created",
      "item.created",
    ]);
  });

  it("refuses short values and unknown fields", async () => {
    const short = await call("POST", "/items", {
      kind: "env-secret",
      name: "Pin",
      envName: "PIN",
      value: "1234",
    });
    expect(short.status).toBe(400);
    const extra = await call("POST", "/items", {
      kind: "env-secret",
      name: "Db",
      envName: "DB_URL",
      value: VALUE,
      scope: "company",
    });
    expect(extra.status).toBe(400);
    expect((await call("DELETE", "/items/vlt_0000")).status).toBe(404);
  });

  it("stores events with Vault values hidden, as soon as an item is saved", async () => {
    await call("POST", "/items", {
      kind: "env-secret",
      name: "Token",
      envName: "API_TOKEN",
      value: VALUE,
    });
    const before = server.store.headSeq();
    server.store.append([
      {
        type: "message.edited",
        sessionId: null,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          text: `token ${VALUE}`,
          at: "2026-11-28T00:00:00.000Z",
        },
      },
    ]);
    const stored = server.store.listAfter(before);
    expect(JSON.stringify(stored)).not.toContain(VALUE);
    expect(stored[0]?.payload).toMatchObject({ text: `token ${REDACTED}` });
  });
});
