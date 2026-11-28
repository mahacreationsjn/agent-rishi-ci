import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for Vault values (`docs/foundation.md` §3.2). A sealed value is
 * `v1.<iv>.<tag>.<ciphertext>` in base64url. Its associated data names what it belongs to
 * (item id, owner, kind), so a value copied onto another item or install doesn't open.
 */

export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

/** Raised when a value doesn't open: wrong key, other associated data, or damaged. */
export class VaultSealError extends Error {
  constructor(message = "The value could not be decrypted") {
    super(message);
    this.name = "VaultSealError";
  }
}

/** What a sealed value belongs to; every part must match to open it. */
export interface SealContext {
  id: string;
  owner: string;
  purpose: string;
}

function associatedData(ctx: SealContext): Buffer {
  return Buffer.from(["agent-rishi-vault", VERSION, ctx.id, ctx.owner, ctx.purpose].join("\0"));
}

export function newDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

export function seal(key: Buffer, plaintext: string, ctx: SealContext): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(associatedData(ctx));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url"));
  return [VERSION, ...parts].join(".");
}

export function open(key: Buffer, sealed: string, ctx: SealContext): string {
  const [version, iv, tag, body, ...rest] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || body === undefined || rest.length > 0) {
    throw new VaultSealError("The value is not in a form this version can read");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(associatedData(ctx));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VaultSealError();
  }
}

/** The data key as the keychain keeps it, and back; null when it isn't a key. */
export function encodeDataKey(key: Buffer): string {
  return key.toString("base64");
}
export function decodeDataKey(stored: string): Buffer | null {
  const key = Buffer.from(stored.trim(), "base64");
  return key.length === DATA_KEY_BYTES ? key : null;
}
