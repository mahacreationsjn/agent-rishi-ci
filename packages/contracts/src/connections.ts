import { z } from "zod";
import { Timestamp } from "./common";
import { ConnectionLevel } from "./connection-level";
import { OwnerId, OwnershipScope } from "./ownership";
import { VaultItemId } from "./vault";

/**
 * Connections (`docs/foundation.md` §4): the account an agent runs on. These are the ones
 * that use an API key from the Vault or an OpenAI-compatible endpoint; a CLI's own login stays
 * the provider's subscription connection, as before.
 */

/** A connection's id: `con_` and 32 hex digits. */
export const ConnectionId = z.string().regex(/^con_[0-9a-f]{32}$/);
export type ConnectionId = z.infer<typeof ConnectionId>;

/**
 * Who a connection talks to (§4.1). `openai-compatible`: any server that speaks the OpenAI API
 * at a base URL (Ollama, LM Studio, vLLM and other hosts).
 */
export const ApiProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "sarvam-ai",
  "openai-compatible",
]);
export type ApiProvider = z.infer<typeof ApiProvider>;

/** `api-key`: a provider's own API with a Vault key. `compatible`: an OpenAI-compatible URL. */
export const ConnectionKind = z.enum(["api-key", "compatible"]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export function connectionKind(provider: ApiProvider): ConnectionKind {
  return provider === "openai-compatible" ? "compatible" : "api-key";
}

/**
 * An http(s) base URL: no query or fragment (not even an empty `?` or `#`), and no user name or
 * password in it, since a key belongs in the Vault, not in a URL that is stored and shown.
 */
export const ConnectionBaseUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (v.includes("?") || v.includes("#")) return false;
    try {
      const url = new URL(v);
      const web = url.protocol === "https:" || url.protocol === "http:";
      return web && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "An http or https URL, without a query or a user name and password");

/** A model as its connection lists it: its id, never hard-coded (§4.2). */
export const ConnectionModel = z.strictObject({
  id: z.string().min(1).max(200),
  name: z.string().max(200).nullable(),
  /** Entered by hand, for a provider that doesn't list its models. */
  manual: z.boolean(),
});
export type ConnectionModel = z.infer<typeof ConnectionModel>;

/** The last check: a models request, which costs no tokens. */
export const ConnectionCheck = z.strictObject({
  at: Timestamp,
  ok: z.boolean(),
  /** What happened, in words; never a key. */
  message: z.string(),
});
export type ConnectionCheck = z.infer<typeof ConnectionCheck>;

export const Connection = z.strictObject({
  id: ConnectionId,
  name: z.string().min(1).max(100),
  provider: ApiProvider,
  kind: ConnectionKind,
  /** Null: the provider's usual address. */
  baseUrl: ConnectionBaseUrl.nullable(),
  /** The Vault item holding its key; null only for a compatible server without one. */
  vaultItemId: VaultItemId.nullable(),
  owner: OwnerId,
  scope: OwnershipScope,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** `configured`, `credential_found` or `verified` (§4.3); only `verified` is ready. */
  level: ConnectionLevel,
  /** When the last passing check ran; null below `verified`. */
  verifiedAt: Timestamp.nullable(),
  lastCheck: ConnectionCheck.nullable(),
  models: z.array(ConnectionModel),
});
export type Connection = z.infer<typeof Connection>;

const name = z.string().trim().min(1).max(100);

export const CreateConnectionRequest = z
  .strictObject({
    name,
    provider: ApiProvider,
    baseUrl: ConnectionBaseUrl.nullable().default(null),
    vaultItemId: VaultItemId.nullable().default(null),
  })
  .refine((r) => r.provider !== "openai-compatible" || r.baseUrl !== null, {
    message: "An OpenAI-compatible connection needs its base URL",
    path: ["baseUrl"],
  })
  .refine((r) => r.provider === "openai-compatible" || r.vaultItemId !== null, {
    message: "This provider needs an API key from the Vault",
    path: ["vaultItemId"],
  });
export type CreateConnectionRequest = z.input<typeof CreateConnectionRequest>;

export const UpdateConnectionRequest = z
  .strictObject({
    name: name.optional(),
    baseUrl: ConnectionBaseUrl.nullable().optional(),
    vaultItemId: VaultItemId.nullable().optional(),
    /** Model ids to keep by hand, for a provider that doesn't list its models. */
    manualModels: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  })
  .refine((r) => Object.values(r).some((v) => v !== undefined), "Nothing to change");
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;
