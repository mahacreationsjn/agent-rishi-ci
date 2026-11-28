import { randomBytes } from "node:crypto";
import {
  type CreateVaultGrantRequest,
  CreateVaultGrantRequest as CreateVaultGrantSchema,
  type CreateVaultItemRequest,
  type LocalOwner,
  type UpdateVaultItemRequest,
  type VaultAuditAction,
  type VaultAuditEntry,
  type VaultAuditQuery,
  type VaultGrant,
  type VaultItem,
  type VaultState,
  type VaultStatus,
} from "@agent-rishi/contracts";
import { and, count, desc, eq, lt, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client";
import { vaultAudit, vaultGrants, vaultItems, vaultMeta } from "../../db/schema";
import type { Tx } from "../../events/projection-db";
import type { EventRedactor } from "../../events/store";
import { badRequest, conflict, forbidden, notFound, ServiceError } from "../errors";
import type { SecretStore } from "../secrets";
import {
  decodeDataKey,
  encodeDataKey,
  newDataKey,
  open,
  type SealContext,
  seal,
  VaultSealError,
} from "./crypto";
import { redactEvent, sortValues } from "./redaction";

/** Where and by whom a value is to be applied, matched against grants (§3.3). */
export interface VaultUse {
  role: string | null;
  projectId: string | null;
  destination: string | null;
  sessionId?: string | null;
}

export interface VaultServiceDeps {
  db: Db;
  /** The OS keychain, which holds only the data key. */
  keys: SecretStore;
  owner: LocalOwner;
  /**
   * Keep the data key in an in-memory store (tests). Without it, a store that isn't the OS
   * keychain leaves the Vault unavailable, since its key would be lost when the server stops.
   */
  allowMemoryKey?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
}

const KEY_CHECK = "key-check";
const KEY_CHECK_TEXT = "agent-rishi vault key check";

type ItemRow = typeof vaultItems.$inferSelect;
type GrantRow = typeof vaultGrants.$inferSelect;

const newId = (prefix: "vlt" | "vgr") => `${prefix}_${randomBytes(16).toString("hex")}`;

/**
 * The Vault (`docs/foundation.md` §3): items sealed with a data key kept in the OS keychain,
 * the owner's grants, and an audit of every use and change. No method returns a value except
 * `use`, which Agent Rishi calls to apply one, never a tool an agent can reach.
 *
 * It fails closed. A missing or wrong key locks it: nothing is read, made or overwritten, and
 * the key is never re-created while there are items it sealed. Items can still be deleted.
 */
export class VaultService {
  private key: Buffer | null = null;
  private state: VaultState = "unavailable";
  private reason: string | null = "The Vault has not been opened yet.";
  /** Values of the readable items, by id. */
  private readonly values = new Map<string, string>();
  /** The same values, longest first, for redaction. */
  private sorted: string[] = [];

  constructor(private readonly deps: VaultServiceDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** Read the key and the items. Called on start, and again after deletes while locked. */
  async open(): Promise<VaultStatus> {
    this.key = null;
    this.values.clear();
    this.sorted = [];
    const items = this.itemCount();
    const { keys } = this.deps;
    if (keys.backend === "memory" && !this.deps.allowMemoryKey) {
      return this.settle(
        "unavailable",
        "There is no OS keychain to keep the Vault's key in, so the Vault can't keep anything. On Linux, install and unlock a Secret Service keyring (GNOME Keyring or KWallet), then restart Agent Rishi.",
      );
    }
    let stored: string | null;
    try {
      stored = await keys.get("vault.dataKey");
    } catch (error) {
      const why = `The OS keychain could not be read (${String(error)}).`;
      return items > 0 ? this.settle("locked", why) : this.settle("unavailable", why);
    }
    let key = stored === null ? null : decodeDataKey(stored);
    if (stored !== null && !key) {
      return this.settle(
        items > 0 ? "locked" : "unavailable",
        "The Vault's key in the OS keychain is damaged. Agent Rishi doesn't overwrite it; remove the keychain entry agent-rishi / vault.dataKey and restart to start a new, empty Vault.",
      );
    }
    const check = this.db.select().from(vaultMeta).where(eq(vaultMeta.key, KEY_CHECK)).get();
    if (items === 0) {
      if (!key) {
        const made = newDataKey();
        try {
          await keys.set("vault.dataKey", encodeDataKey(made));
          if ((await keys.get("vault.dataKey")) !== encodeDataKey(made)) {
            return this.settle("unavailable", "The OS keychain didn't keep the Vault's key.");
          }
        } catch (error) {
          return this.settle(
            "unavailable",
            `The Vault's key could not be saved in the OS keychain (${String(error)}).`,
          );
        }
        key = made;
      }
      // An empty Vault takes the keychain's key, whatever sealed the check before.
      if (!check || !this.opens(key, check.value)) {
        const value = seal(key, KEY_CHECK_TEXT, this.checkContext());
        this.db
          .insert(vaultMeta)
          .values({ key: KEY_CHECK, value })
          .onConflictDoUpdate({ target: vaultMeta.key, set: { value } })
          .run();
      }
      this.key = key;
      return this.settle("ready", null);
    }
    const plural = items === 1 ? "item" : "items";
    if (!key) {
      return this.settle(
        "locked",
        `The Vault's key is missing from the OS keychain, so its ${items} ${plural} can't be read. Bring the keychain entry back, or delete the items to start again.`,
      );
    }
    if (!check || !this.opens(key, check.value)) {
      return this.settle(
        "locked",
        `The key in the OS keychain doesn't match the Vault's ${items} ${plural} (were they restored from another computer?). Nothing was changed; delete the items to start again.`,
      );
    }
    this.key = key;
    for (const row of this.db.select().from(vaultItems).all()) {
      try {
        this.values.set(row.id, open(key, row.sealed, itemContext(row)));
      } catch (error) {
        if (!(error instanceof VaultSealError)) throw error;
        this.deps.log?.(`vault: item ${row.id} can't be decrypted`);
      }
    }
    this.sorted = sortValues(this.values.values());
    return this.settle("ready", null);
  }

  status(): VaultStatus {
    return { state: this.state, reason: this.reason, items: this.itemCount() };
  }

  list(): VaultItem[] {
    return this.db
      .select()
      .from(vaultItems)
      .orderBy(vaultItems.createdAt)
      .all()
      .map((row) => this.toItem(row));
  }

  get(id: string): VaultItem {
    return this.toItem(this.row(id));
  }

  create(request: CreateVaultItemRequest): VaultItem {
    const key = this.readyKey();
    const at = this.now();
    const row: ItemRow = {
      id: newId("vlt"),
      kind: request.kind,
      name: request.name,
      owner: this.deps.owner.id,
      scope: "personal",
      provider: request.kind === "api-credential" ? request.provider : null,
      envName: request.kind === "env-secret" ? request.envName : null,
      sealed: "",
      createdAt: at,
      updatedAt: at,
      lastUsedAt: null,
    };
    row.sealed = seal(key, request.value, itemContext(row));
    this.db.transaction((tx) => {
      tx.insert(vaultItems).values(row).run();
      this.record(tx, "item.created", row, {});
    });
    this.remember(row.id, request.value);
    return this.toItem(row);
  }

  update(id: string, request: UpdateVaultItemRequest): VaultItem {
    const row = this.row(id);
    const key = request.value === undefined ? null : this.readyKey();
    const at = this.now();
    const next: ItemRow = { ...row, name: request.name ?? row.name, updatedAt: at };
    if (key && request.value !== undefined)
      next.sealed = seal(key, request.value, itemContext(row));
    this.db.transaction((tx) => {
      tx.update(vaultItems)
        .set({ name: next.name, sealed: next.sealed, updatedAt: at })
        .where(eq(vaultItems.id, id))
        .run();
      if (next.name !== row.name) {
        this.record(tx, "item.renamed", next, { detail: `was "${row.name}"` });
      }
      if (request.value !== undefined) this.record(tx, "item.value_changed", next, {});
    });
    if (request.value !== undefined) this.remember(id, request.value);
    return this.toItem(next);
  }

  /** Delete an item and its grants. Works while locked; an emptied locked Vault opens again. */
  async delete(id: string): Promise<void> {
    const row = this.row(id);
    this.db.transaction((tx) => {
      tx.delete(vaultGrants).where(eq(vaultGrants.itemId, id)).run();
      tx.delete(vaultItems).where(eq(vaultItems.id, id)).run();
      this.record(tx, "item.deleted", row, {});
    });
    this.values.delete(id);
    this.sorted = sortValues(this.values.values());
    if (this.state !== "ready" && this.itemCount() === 0) await this.open();
  }

  listGrants(itemId?: string): VaultGrant[] {
    return this.db
      .select()
      .from(vaultGrants)
      .where(itemId ? eq(vaultGrants.itemId, itemId) : undefined)
      .orderBy(vaultGrants.createdAt)
      .all()
      .map(toGrant);
  }

  grant(input: CreateVaultGrantRequest): VaultGrant {
    const request = CreateVaultGrantSchema.parse(input);
    const item = this.row(request.itemId);
    const at = this.now();
    if (request.expiresAt !== null && request.expiresAt <= at) {
      throw badRequest("A grant must end in the future", "grant_expired");
    }
    const row: GrantRow = {
      id: newId("vgr"),
      itemId: item.id,
      role: request.role,
      projectId: request.projectId,
      destination: request.destination,
      expiresAt: request.expiresAt,
      owner: this.deps.owner.id,
      scope: "personal",
      createdAt: at,
    };
    this.db.transaction((tx) => {
      tx.insert(vaultGrants).values(row).run();
      this.record(tx, "grant.created", item, { grantId: row.id, detail: describeBounds(row) });
    });
    return toGrant(row);
  }

  revoke(grantId: string): void {
    const grant = this.db.select().from(vaultGrants).where(eq(vaultGrants.id, grantId)).get();
    if (!grant) throw notFound("No such grant", "grant_not_found");
    const item = this.row(grant.itemId);
    this.db.transaction((tx) => {
      tx.delete(vaultGrants).where(eq(vaultGrants.id, grantId)).run();
      this.record(tx, "grant.revoked", item, { grantId, detail: describeBounds(grant) });
    });
  }

  audit(query: VaultAuditQuery): VaultAuditEntry[] {
    const where: SQL[] = [];
    if (query.itemId) where.push(eq(vaultAudit.itemId, query.itemId));
    if (query.before) where.push(lt(vaultAudit.seq, query.before));
    return this.db
      .select()
      .from(vaultAudit)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(vaultAudit.seq))
      .limit(query.limit)
      .all() as VaultAuditEntry[];
  }

  /**
   * An item's value, for Agent Rishi to apply where `use` says, when a grant allows it. Without
   * one it is refused (`vault_grant_needed`) and the refusal is recorded. Both are audited.
   */
  use(itemId: string, use: VaultUse): string {
    const row = this.row(itemId);
    this.readyKey();
    const value = this.values.get(itemId);
    if (value === undefined) {
      throw conflict(
        `"${row.name}" can't be decrypted. Enter its value again.`,
        "vault_unreadable",
      );
    }
    const at = this.now();
    const grant = this.db
      .select()
      .from(vaultGrants)
      .where(eq(vaultGrants.itemId, itemId))
      .all()
      .find((g) => allows(g, use, at));
    const detail = describeUse(use);
    const sessionId = use.sessionId ?? null;
    if (!grant) {
      this.db.transaction((tx) => this.record(tx, "item.use_refused", row, { sessionId, detail }));
      throw forbidden(`"${row.name}" isn't granted for ${detail}.`, "vault_grant_needed");
    }
    this.db.transaction((tx) => {
      tx.update(vaultItems).set({ lastUsedAt: at }).where(eq(vaultItems.id, itemId)).run();
      this.record(tx, "item.used", row, { grantId: grant.id, sessionId, detail });
    });
    return value;
  }

  /** Every readable value, longest first: for redaction outside the event log (exports). */
  knownValues(): readonly string[] {
    return this.sorted;
  }

  /** Hides every known value in an event before the event log stores it. */
  redactor(): EventRedactor {
    return (event) => redactEvent(event, this.sorted);
  }

  private settle(state: VaultState, reason: string | null): VaultStatus {
    this.state = state;
    this.reason = reason;
    if (reason) this.deps.log?.(`vault ${state}: ${reason}`);
    return this.status();
  }

  private readyKey(): Buffer {
    if (this.state === "ready" && this.key) return this.key;
    const reason = this.reason ?? "The Vault isn't ready.";
    if (this.state === "locked") throw conflict(reason, "vault_locked");
    throw new ServiceError(503, "vault_unavailable", reason);
  }

  private opens(key: Buffer, sealed: string): boolean {
    try {
      return open(key, sealed, this.checkContext()) === KEY_CHECK_TEXT;
    } catch {
      return false;
    }
  }

  private checkContext(): SealContext {
    return { id: KEY_CHECK, owner: this.deps.owner.id, purpose: KEY_CHECK };
  }

  private remember(id: string, value: string): void {
    this.values.set(id, value);
    this.sorted = sortValues(this.values.values());
  }

  private itemCount(): number {
    return this.db.select({ n: count() }).from(vaultItems).get()?.n ?? 0;
  }

  private row(id: string): ItemRow {
    const row = this.db.select().from(vaultItems).where(eq(vaultItems.id, id)).get();
    if (!row) throw notFound("No such Vault item", "vault_item_not_found");
    return row;
  }

  private toItem(row: ItemRow): VaultItem {
    const base = {
      id: row.id,
      name: row.name,
      owner: row.owner,
      scope: row.scope as VaultItem["scope"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
      readable: this.state === "ready" && this.values.has(row.id),
    };
    return row.kind === "env-secret"
      ? { ...base, kind: "env-secret", envName: row.envName ?? "" }
      : { ...base, kind: "api-credential", provider: row.provider ?? "" };
  }

  private record(
    tx: Tx,
    action: VaultAuditAction,
    item: Pick<ItemRow, "id" | "name">,
    extra: { grantId?: string; sessionId?: string | null; detail?: string },
  ): void {
    tx.insert(vaultAudit)
      .values({
        at: this.now(),
        action,
        itemId: item.id,
        itemName: item.name,
        grantId: extra.grantId ?? null,
        sessionId: extra.sessionId ?? null,
        detail: extra.detail ?? null,
      })
      .run();
  }
}

function itemContext(row: Pick<ItemRow, "id" | "owner" | "kind">): SealContext {
  return { id: row.id, owner: row.owner, purpose: row.kind };
}

function toGrant(row: GrantRow): VaultGrant {
  return { ...row, scope: row.scope as VaultGrant["scope"] };
}

/** Whether a grant covers this use: every bound it sets matches, and it hasn't ended. */
function allows(grant: GrantRow, use: VaultUse, at: string): boolean {
  if (grant.expiresAt !== null && grant.expiresAt <= at) return false;
  if (grant.role !== null && grant.role !== use.role) return false;
  if (grant.projectId !== null && grant.projectId !== use.projectId) return false;
  return grant.destination === null || grant.destination === use.destination;
}

function describeBounds(g: Pick<GrantRow, "role" | "projectId" | "destination" | "expiresAt">) {
  const parts = [
    `role ${g.role ?? "any"}`,
    `project ${g.projectId ?? "any"}`,
    `destination ${g.destination ?? "any"}`,
  ];
  if (g.expiresAt) parts.push(`until ${g.expiresAt}`);
  return parts.join(", ");
}

function describeUse(use: VaultUse): string {
  return [
    `role ${use.role ?? "none"}`,
    `project ${use.projectId ?? "none"}`,
    `destination ${use.destination ?? "none"}`,
  ].join(", ");
}
