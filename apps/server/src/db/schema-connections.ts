import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Connections that use an API key or an OpenAI-compatible endpoint (`docs/foundation.md` §4).
 * Not a projection: the owner's settings plus the last check's result. A key is never here,
 * only the Vault item that holds it.
 */
export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  baseUrl: text("base_url"),
  vaultItemId: text("vault_item_id"),
  owner: text("owner").notNull(),
  scope: text("scope").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  level: text("level").notNull(),
  verifiedAt: text("verified_at"),
  lastCheckAt: text("last_check_at"),
  lastCheckOk: integer("last_check_ok", { mode: "boolean" }),
  lastCheckMessage: text("last_check_message"),
  /** The last list's models, `{ id, name }[]` as JSON. */
  models: text("models").notNull().default("[]"),
  /** Model ids the owner entered by hand, `string[]` as JSON; kept apart from any list. */
  manualModels: text("manual_models").notNull().default("[]"),
});
