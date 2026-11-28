import { randomBytes } from "node:crypto";
import { LocalOwner } from "@agent-rishi/contracts";
import type { Db } from "../db/client";
import { installOwner } from "../db/schema";

/**
 * This install's owner (`docs/foundation.md` §2): read it, or make it on the first start. The
 * id never changes afterwards; everything an owner keeps (Vault items, connections, templates)
 * is bound to it. More than one row would be a bug: the oldest one wins.
 */
export function ensureLocalOwner(db: Db, now: () => Date = () => new Date()): LocalOwner {
  const existing = db.select().from(installOwner).orderBy(installOwner.createdAt).get();
  if (existing) return LocalOwner.parse(existing);
  const owner: LocalOwner = {
    id: `own_${randomBytes(16).toString("hex")}`,
    createdAt: now().toISOString(),
  };
  db.insert(installOwner).values(owner).run();
  return owner;
}
