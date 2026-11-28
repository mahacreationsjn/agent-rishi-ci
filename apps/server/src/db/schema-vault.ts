import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The Vault (`docs/foundation.md` §3). Not projections: no event makes these rows, so a value
 * never reaches the append-only event log, and deleting an item really removes its ciphertext.
 *
 * `sealed` is AES-256-GCM ciphertext whose associated data binds it to its item id, owner and
 * kind (`services/vault/crypto.ts`); the key lives only in the OS keychain.
 */
export const vaultItems = sqliteTable("vault_items", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  scope: text("scope").notNull(),
  /** `api-credential` items: the provider slug. */
  provider: text("provider"),
  /** `env-secret` items: the variable's name. */
  envName: text("env_name"),
  sealed: text("sealed").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

/** The owner's consent for an item to be applied without asking (§3.3); null bounds mean any. */
export const vaultGrants = sqliteTable(
  "vault_grants",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => vaultItems.id, { onDelete: "cascade" }),
    role: text("role"),
    projectId: text("project_id"),
    destination: text("destination"),
    expiresAt: text("expires_at"),
    owner: text("owner").notNull(),
    scope: text("scope").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("vault_grants_item").on(t.itemId)],
);

/** Every use, grant and change, without the value (§3.4). Kept after its item is deleted. */
export const vaultAudit = sqliteTable(
  "vault_audit",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    action: text("action").notNull(),
    itemId: text("item_id").notNull(),
    itemName: text("item_name").notNull(),
    grantId: text("grant_id"),
    sessionId: text("session_id"),
    detail: text("detail"),
  },
  (t) => [index("vault_audit_item").on(t.itemId, t.seq)],
);

/**
 * One sealed check value, made with the key that sealed the items. Opening it tells a right key
 * from a wrong one before anything else is read or written.
 */
export const vaultMeta = sqliteTable("vault_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
