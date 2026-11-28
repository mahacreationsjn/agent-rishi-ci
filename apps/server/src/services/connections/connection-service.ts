import { randomBytes } from "node:crypto";
import {
  type ApiProvider,
  type Connection,
  type ConnectionLevel,
  type ConnectionModel,
  type CreateConnectionRequest,
  CreateConnectionRequest as CreateConnectionSchema,
  connectionKind,
  type LocalOwner,
  type UpdateConnectionRequest,
} from "@agent-rishi/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { connections } from "../../db/schema";
import { badRequest, errorMessage, notFound, ServiceError } from "../errors";
import type { VaultService } from "../vault/vault-service";
import {
  baseUrlFor,
  type ListedModel,
  listModels,
  ModelListError,
  privateAddress,
} from "./model-list";

export interface ConnectionServiceDeps {
  db: Db;
  vault: VaultService;
  owner: LocalOwner;
  /** Model listing transport (tests point it at a stub). */
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}

type Row = typeof connections.$inferSelect;

/** The Vault destination a connection's key is granted for. */
export const connectionDestination = (id: string) => `connection:${id}`;

/** What a check result belongs to: a result for another address or key is dropped. */
const fingerprint = (row: Pick<Row, "baseUrl" | "vaultItemId">) =>
  `${row.baseUrl ?? ""}\n${row.vaultItemId ?? ""}`;

/**
 * API-key and OpenAI-compatible connections (`docs/foundation.md` §4): stored, checked by
 * listing their models (no tokens), and levelled `configured`, `credential_found` or
 * `verified`.
 *
 * Choosing a Vault key for a connection grants it for that connection only, and only that
 * grant lets the connection send it: one the owner made for something else doesn't. The grant
 * shows in the Vault; removing it there stops the key being sent. A new address withdraws the
 * grant, so a key never follows an edited URL to another host without being chosen again.
 */
export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  list(): Connection[] {
    return this.deps.db
      .select()
      .from(connections)
      .orderBy(connections.createdAt)
      .all()
      .map(toConnection);
  }

  get(id: string): Connection {
    return toConnection(this.row(id));
  }

  /** Save a connection and check it straight away. */
  async create(input: CreateConnectionRequest): Promise<Connection> {
    const req = CreateConnectionSchema.parse(input);
    if (req.vaultItemId) this.checkKey(req.vaultItemId, req.provider);
    assertTransport(req.provider, req.baseUrl, req.vaultItemId);
    const at = this.now();
    const row: Row = {
      id: `con_${randomBytes(16).toString("hex")}`,
      name: req.name,
      provider: req.provider,
      kind: connectionKind(req.provider),
      baseUrl: req.baseUrl,
      vaultItemId: req.vaultItemId,
      owner: this.deps.owner.id,
      scope: "personal",
      createdAt: at,
      updatedAt: at,
      level: req.vaultItemId ? "credential_found" : "configured",
      verifiedAt: null,
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckMessage: null,
      models: "[]",
      manualModels: "[]",
    };
    this.deps.db.insert(connections).values(row).run();
    if (req.vaultItemId) this.grantKey(row.id, req.vaultItemId);
    return this.check(row.id);
  }

  /**
   * Change a connection. Choosing a key, even the one it has, grants it again (after a grant
   * was removed in the Vault) and checks. A new address alone withdraws the key's grant and
   * clears verification: the key must be chosen again to be sent there.
   */
  async update(id: string, req: UpdateConnectionRequest): Promise<Connection> {
    const row = this.row(id);
    const provider = row.provider as ApiProvider;
    const at = this.now();
    const next: Partial<Row> = { updatedAt: at };
    if (req.name !== undefined) next.name = req.name;
    const baseChanged = req.baseUrl !== undefined && req.baseUrl !== row.baseUrl;
    if (baseChanged) {
      if (provider === "openai-compatible" && req.baseUrl === null) {
        throw badRequest("An OpenAI-compatible connection needs its base URL");
      }
      next.baseUrl = req.baseUrl ?? null;
    }
    const keyChosen = req.vaultItemId !== undefined;
    if (keyChosen) {
      if (req.vaultItemId === null && provider !== "openai-compatible") {
        throw badRequest("This provider needs an API key from the Vault");
      }
      if (req.vaultItemId) this.checkKey(req.vaultItemId, provider);
      next.vaultItemId = req.vaultItemId ?? null;
    }
    const key = keyChosen ? (req.vaultItemId ?? null) : row.vaultItemId;
    const base = baseChanged ? (req.baseUrl ?? null) : row.baseUrl;
    if (baseChanged || keyChosen) assertTransport(provider, base, key);
    if (req.manualModels !== undefined) {
      next.manualModels = JSON.stringify([...new Set(req.manualModels)]);
    }
    if (baseChanged || keyChosen) {
      // Whatever was verified was for the old address or key.
      Object.assign(next, { level: key ? "credential_found" : "configured", verifiedAt: null });
    }
    this.deps.db.update(connections).set(next).where(eq(connections.id, id)).run();
    if (keyChosen || baseChanged) this.revokeKey(id, row.vaultItemId);
    if (keyChosen && key) this.grantKey(id, key);
    if (keyChosen || (baseChanged && !key)) return this.check(id);
    if (baseChanged && key) {
      this.save(id, {
        level: "configured",
        lastCheckAt: at,
        lastCheckOk: false,
        lastCheckMessage:
          "The address changed, so its key is no longer granted. Choose the key again to send it to the new address.",
      });
    }
    return this.get(id);
  }

  delete(id: string): void {
    const row = this.row(id);
    this.deps.db.delete(connections).where(eq(connections.id, id)).run();
    this.revokeKey(id, row.vaultItemId);
  }

  /**
   * List the connection's models with its key. A passing list makes it `verified`; a refused
   * key, a removed grant or a server without a models endpoint leaves it below that, saying why.
   * A result is kept only if the connection still has the address and key it was checked with.
   */
  async check(id: string): Promise<Connection> {
    const row = this.row(id);
    const provider = row.provider as ApiProvider;
    const at = this.now();
    const started = fingerprint(row);
    const commit = (values: Partial<Row>) => {
      const current = this.deps.db.select().from(connections).where(eq(connections.id, id)).get();
      if (current && fingerprint(current) === started)
        this.save(id, { lastCheckAt: at, ...values });
      return this.get(id);
    };
    const fail = (level: ConnectionLevel, message: string, listed?: ListedModel[]) =>
      commit({
        level,
        verifiedAt: null,
        lastCheckOk: false,
        lastCheckMessage: message,
        ...(listed ? { models: JSON.stringify(listed) } : {}),
      });
    let key: string | null = null;
    if (row.vaultItemId) {
      const itemId = row.vaultItemId;
      if (!this.granted(id, itemId)) {
        return fail(
          "configured",
          "Its key isn't granted for this connection any more. Choose the key again to grant it.",
        );
      }
      try {
        key = this.deps.vault.use(itemId, {
          role: null,
          projectId: null,
          destination: connectionDestination(id),
        });
      } catch (error) {
        const code = error instanceof ServiceError ? error.code : null;
        const why =
          code === "vault_item_not_found"
            ? "Its key was deleted from the Vault. Choose another key."
            : errorMessage(error);
        return fail("configured", why);
      }
    }
    const base = baseUrlFor(provider, row.baseUrl);
    if (!base) return fail("configured", "It needs a base URL.");
    const keyLevel: ConnectionLevel = key ? "credential_found" : "configured";
    const itemId = row.vaultItemId;
    try {
      const listed = await listModels({
        provider,
        baseUrl: base,
        key,
        fetch: this.deps.fetch,
        stillAllowed: () => !itemId || this.granted(id, itemId),
      });
      return commit({
        level: "verified",
        verifiedAt: at,
        lastCheckOk: true,
        lastCheckMessage: `Listed ${listed.length} ${listed.length === 1 ? "model" : "models"}`,
        models: JSON.stringify(listed),
      });
    } catch (error) {
      if (!(error instanceof ModelListError)) throw error;
      this.deps.log?.(`connection ${id}: ${error.message}`);
      if (error.reason === "unsupported") {
        // Nothing to list: hand-entered models stay, and verification waits for a real call.
        return fail(
          keyLevel,
          `${error.message}. Add its model IDs by hand; it will be verified by a test call.`,
          [],
        );
      }
      return fail(keyLevel, error.message);
    }
  }

  private save(id: string, values: Partial<Row>): void {
    this.deps.db.update(connections).set(values).where(eq(connections.id, id)).run();
  }

  private row(id: string): Row {
    const row = this.deps.db.select().from(connections).where(eq(connections.id, id)).get();
    if (!row) throw notFound("No such connection", "connection_not_found");
    return row;
  }

  /** Whether this connection's own grant for the key is there and hasn't ended. */
  private granted(id: string, itemId: string): boolean {
    const at = this.now();
    try {
      return this.deps.vault
        .listGrants(itemId)
        .some(
          (g) =>
            g.destination === connectionDestination(id) &&
            (g.expiresAt === null || g.expiresAt > at),
        );
    } catch {
      return false;
    }
  }

  /** The key must be an API key, and for this provider unless the server is compatible. */
  private checkKey(itemId: string, provider: ApiProvider): void {
    const item = this.deps.vault.get(itemId);
    if (item.kind !== "api-credential") {
      throw badRequest("Choose an API key, not an environment variable", "connection_key_kind");
    }
    if (provider !== "openai-compatible" && item.provider !== provider) {
      throw badRequest(
        `That key is for ${item.provider}, not ${provider}`,
        "connection_key_provider",
      );
    }
  }

  private grantKey(id: string, itemId: string): void {
    if (!this.granted(id, itemId)) {
      this.deps.vault.grant({ itemId, destination: connectionDestination(id) });
    }
  }

  /** Remove the grants this connection made for its key. */
  private revokeKey(id: string, itemId: string | null): void {
    if (!itemId) return;
    let grants: ReturnType<VaultService["listGrants"]>;
    try {
      grants = this.deps.vault.listGrants(itemId);
    } catch {
      return;
    }
    for (const grant of grants) {
      if (grant.destination === connectionDestination(id)) this.deps.vault.revoke(grant.id);
    }
  }
}

/** A key goes over plain http only to this computer or a private network. */
function assertTransport(provider: ApiProvider, baseUrl: string | null, key: string | null): void {
  const base = baseUrlFor(provider, baseUrl);
  if (!key || !base) return;
  const url = new URL(base);
  if (url.protocol === "http:" && !privateAddress(url)) {
    throw badRequest(
      "A key is sent only over https, except to this computer or a private network",
      "connection_insecure",
    );
  }
}

function parseList<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Listed models, then hand-entered ones the list doesn't have. */
function models(row: Row): ConnectionModel[] {
  const listed = parseList<ListedModel>(row.models).map((m) => ({ ...m, manual: false }));
  const ids = new Set(listed.map((m) => m.id));
  const manual = parseList<string>(row.manualModels)
    .filter((id) => !ids.has(id))
    .map((id) => ({ id, name: null, manual: true }));
  return [...listed, ...manual];
}

function toConnection(row: Row): Connection {
  const lastCheck =
    row.lastCheckAt === null
      ? null
      : { at: row.lastCheckAt, ok: row.lastCheckOk === true, message: row.lastCheckMessage ?? "" };
  return {
    id: row.id,
    name: row.name,
    provider: row.provider as ApiProvider,
    kind: row.kind as Connection["kind"],
    baseUrl: row.baseUrl,
    vaultItemId: row.vaultItemId,
    owner: row.owner,
    scope: row.scope as Connection["scope"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    level: row.level as ConnectionLevel,
    verifiedAt: row.verifiedAt,
    lastCheck,
    models: models(row),
  };
}
