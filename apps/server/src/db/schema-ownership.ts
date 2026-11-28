import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * This install's owner (`docs/foundation.md` §2): one row, made on the first start. It lives in
 * the database, not a file of its own, so a restored backup keeps the same owner as the items
 * it holds (Vault items are bound to their owner). Not a projection: no event makes it.
 */
export const installOwner = sqliteTable("install_owner", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
});
