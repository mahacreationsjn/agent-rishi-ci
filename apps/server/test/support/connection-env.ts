import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/client";
import { ConnectionService } from "../../src/services/connections/connection-service";
import { ensureLocalOwner } from "../../src/services/owner";
import { MemorySecretStore } from "../../src/services/secrets";
import { VaultService } from "../../src/services/vault/vault-service";

/** A key shaped like a real one, for tests. */
export const TEST_KEY = "sk-ant-test-0123456789abcdef";

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

/** A provider stub: answers by URL, and records each request's URL and headers. */
export function providerStub(answer: (url: URL) => { status?: number; body?: unknown }) {
  const seen: SeenRequest[] = [];
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

/**
 * A database, an open Vault (key in memory) and a connection service over `fetchStub`, in a
 * temporary folder. Call `dispose` after the test.
 */
export async function connectionEnv(fetchStub: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "agent-rishi-connections-"));
  const database = openDatabase(join(dir, "agent-rishi.db"));
  const owner = ensureLocalOwner(database.db);
  const vault = new VaultService({
    db: database.db,
    keys: new MemorySecretStore(),
    owner,
    allowMemoryKey: true,
  });
  await vault.open();
  const service = new ConnectionService({ db: database.db, vault, owner, fetch: fetchStub });
  const dispose = () => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { service, vault, db: database.db, dispose };
}
