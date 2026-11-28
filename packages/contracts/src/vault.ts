import { z } from "zod";
import { Id, Timestamp } from "./common";
import { OwnerId, OwnershipScope } from "./ownership";

/**
 * The Vault (`docs/foundation.md` §3): secrets agents use, which Agent Rishi puts where they are
 * needed. No schema here carries a value except the requests that set one; nothing the server
 * returns does.
 */

/** A Vault item's id: `vlt_` and 32 hex digits. */
export const VaultItemId = z.string().regex(/^vlt_[0-9a-f]{32}$/);
export type VaultItemId = z.infer<typeof VaultItemId>;

/** A grant's id: `vgr_` and 32 hex digits. */
export const VaultGrantId = z.string().regex(/^vgr_[0-9a-f]{32}$/);
export type VaultGrantId = z.infer<typeof VaultGrantId>;

/**
 * What an item is for (§3.1). `api-credential`: a model provider's API key. `env-secret`: one
 * environment variable for a project's sessions or an MCP server. Logins come later.
 */
export const VaultItemKind = z.enum(["api-credential", "env-secret"]);
export type VaultItemKind = z.infer<typeof VaultItemKind>;

/** A provider an API credential belongs to, as a short slug (`anthropic`, `xai`, `local-ollama`). */
export const VaultProvider = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export type VaultProvider = z.infer<typeof VaultProvider>;

/** An environment variable's name, as shells accept it. */
export const VaultEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export type VaultEnvName = z.infer<typeof VaultEnvName>;

export const VaultItemName = z.string().trim().min(1).max(100);

/**
 * The shortest value the Vault keeps. Values are hidden wherever they appear in stored text
 * (§3.4); a shorter one would hide ordinary words too.
 */
export const VAULT_VALUE_MIN = 8;
export const VAULT_VALUE_MAX = 10_000;
export const VaultValue = z.string().min(VAULT_VALUE_MIN).max(VAULT_VALUE_MAX);

const itemBase = {
  id: VaultItemId,
  name: VaultItemName,
  owner: OwnerId,
  scope: OwnershipScope,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  /** False when this item's value can't be decrypted (copied from elsewhere, damaged). */
  readable: z.boolean(),
};

/** An item as the server shows it: what it is, never its value. */
export const VaultItem = z.discriminatedUnion("kind", [
  z.strictObject({ ...itemBase, kind: z.literal("api-credential"), provider: VaultProvider }),
  z.strictObject({ ...itemBase, kind: z.literal("env-secret"), envName: VaultEnvName }),
]);
export type VaultItem = z.infer<typeof VaultItem>;

/** A new item, with its value. Everything made today is the install owner's, `personal`. */
export const CreateVaultItemRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("api-credential"),
    name: VaultItemName,
    provider: VaultProvider,
    value: VaultValue,
  }),
  z.strictObject({
    kind: z.literal("env-secret"),
    name: VaultItemName,
    envName: VaultEnvName,
    value: VaultValue,
  }),
]);
export type CreateVaultItemRequest = z.infer<typeof CreateVaultItemRequest>;

/** Rename an item, give it a new value, or both. */
export const UpdateVaultItemRequest = z
  .strictObject({ name: VaultItemName.optional(), value: VaultValue.optional() })
  .refine((r) => r.name !== undefined || r.value !== undefined, "Nothing to change");
export type UpdateVaultItemRequest = z.infer<typeof UpdateVaultItemRequest>;

/** A role's name in a grant (`agent`, `pm`, a role template's id). */
export const VaultRole = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Where a value goes (§3.3): a connection, an origin or an MCP server, as `connection:<id>`,
 * `origin:<scheme://host:port>` or `mcp:<name>`.
 */
export const VaultDestination = z
  .string()
  .regex(/^(?:connection|mcp):[A-Za-z0-9._-]{1,128}$|^origin:[a-z][a-z0-9+.-]*:\/\/[^\s/]+$/);
export type VaultDestination = z.infer<typeof VaultDestination>;

/**
 * The owner's consent for an item to be applied without asking (§3.3). Each bound left null
 * means any: a grant with no bounds lets every session use the item.
 */
export const VaultGrant = z.strictObject({
  id: VaultGrantId,
  itemId: VaultItemId,
  role: VaultRole.nullable(),
  projectId: Id.nullable(),
  destination: VaultDestination.nullable(),
  expiresAt: Timestamp.nullable(),
  owner: OwnerId,
  scope: OwnershipScope,
  createdAt: Timestamp,
});
export type VaultGrant = z.infer<typeof VaultGrant>;

export const CreateVaultGrantRequest = z.strictObject({
  itemId: VaultItemId,
  role: VaultRole.nullable().default(null),
  projectId: Id.nullable().default(null),
  destination: VaultDestination.nullable().default(null),
  expiresAt: Timestamp.nullable().default(null),
});
export type CreateVaultGrantRequest = z.input<typeof CreateVaultGrantRequest>;

/**
 * Whether the Vault can be used. `ready`: items can be made and used. `locked`: there are items
 * but their key is missing or wrong, so nothing is read or made; items can still be deleted.
 * `unavailable`: no OS keychain to hold the key, so nothing can be kept.
 */
export const VaultState = z.enum(["ready", "locked", "unavailable"]);
export type VaultState = z.infer<typeof VaultState>;

export const VaultStatus = z.strictObject({
  state: VaultState,
  /** Why it isn't ready, in words for the owner. */
  reason: z.string().nullable(),
  items: z.int().nonnegative(),
});
export type VaultStatus = z.infer<typeof VaultStatus>;

/** A `.env` file's text, to save each `NAME=value` in it as an `env-secret` item. */
export const ImportVaultEnvRequest = z.strictObject({ text: z.string().min(1).max(200_000) });
export type ImportVaultEnvRequest = z.infer<typeof ImportVaultEnvRequest>;

/** A line that wasn't saved, and why; never its value. */
export const VaultImportSkip = z.strictObject({
  line: z.int().positive(),
  name: z.string().nullable(),
  reason: z.string(),
});
export type VaultImportSkip = z.infer<typeof VaultImportSkip>;

export const ImportVaultEnvResponse = z.strictObject({
  created: z.array(VaultItem),
  skipped: z.array(VaultImportSkip),
});
export type ImportVaultEnvResponse = z.infer<typeof ImportVaultEnvResponse>;

/** What an audit entry records (§3.4). */
export const VaultAuditAction = z.enum([
  "item.created",
  "item.imported",
  "item.renamed",
  "item.value_changed",
  "item.deleted",
  "grant.created",
  "grant.revoked",
  "item.used",
  "item.use_refused",
]);
export type VaultAuditAction = z.infer<typeof VaultAuditAction>;

/** One use, grant or change, without the value. */
export const VaultAuditEntry = z.strictObject({
  seq: z.int().positive(),
  at: Timestamp,
  action: VaultAuditAction,
  itemId: VaultItemId,
  /** The item's name when it happened, so entries stay readable after a delete. */
  itemName: z.string(),
  grantId: VaultGrantId.nullable(),
  sessionId: Id.nullable(),
  /** Context in words (the destination, the role), never a value. */
  detail: z.string().nullable(),
});
export type VaultAuditEntry = z.infer<typeof VaultAuditEntry>;

export const VaultAuditQuery = z.object({
  itemId: VaultItemId.optional(),
  /** Entries before this seq, for paging back. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type VaultAuditQuery = z.infer<typeof VaultAuditQuery>;
