import { z } from "zod";
import { Timestamp } from "./common";

/**
 * Ownership (`docs/foundation.md` §2): who a stored thing belongs to and how widely it is
 * shared. Every agent works for one person, its owner. Today each install has exactly one
 * owner, the person using it; the fields exist so that Enterprise can later hold
 * company-provided items (usable, not readable) without changing what is already stored.
 */

/** An owner's id: `own_` and 32 hex digits, made once per install. Opaque; not a secret. */
export const OwnerId = z.string().regex(/^own_[0-9a-f]{32}$/);
export type OwnerId = z.infer<typeof OwnerId>;

/** How widely an owned thing is shared: one person, a team, or the whole company. */
export const OwnershipScope = z.enum(["personal", "team", "company"]);
export type OwnershipScope = z.infer<typeof OwnershipScope>;

/** The owner and scope that secrets, connections, profiles, role templates and teams carry. */
export const Ownership = z.strictObject({
  owner: OwnerId,
  scope: OwnershipScope,
});
export type Ownership = z.infer<typeof Ownership>;

/** This install's owner: the person using it. */
export const LocalOwner = z.strictObject({
  id: OwnerId,
  createdAt: Timestamp,
});
export type LocalOwner = z.infer<typeof LocalOwner>;

/** Something the local owner keeps for themselves: the default for everything made today. */
export function personal(owner: LocalOwner | OwnerId): Ownership {
  return { owner: typeof owner === "string" ? owner : owner.id, scope: "personal" };
}
