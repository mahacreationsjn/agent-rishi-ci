import type { SecretKey } from "@agent-rishi/contracts";

/**
 * Keychain entries only Agent Rishi itself uses. They are not `SecretKey`s, so `/api/secrets`
 * never lists, sets or deletes them. `vault.dataKey`: the key that seals Vault items.
 */
export type InternalSecretKey = "vault.dataKey";

/** Every name the keychain store accepts. */
export type StoredSecretKey = SecretKey | InternalSecretKey;

/**
 * Secrets in the OS keychain (§6), e.g. an optional ElevenLabs key. Values never go to files,
 * logs or API responses.
 */
export interface SecretStore {
  readonly backend: "keyring" | "memory";
  get(key: StoredSecretKey): Promise<string | null>;
  set(key: StoredSecretKey, value: string): Promise<void>;
  delete(key: StoredSecretKey): Promise<void>;
}

/** In-memory store for tests and machines without a usable keychain. */
export class MemorySecretStore implements SecretStore {
  readonly backend = "memory" as const;
  private readonly values = new Map<StoredSecretKey, string>();

  async get(key: StoredSecretKey): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: StoredSecretKey, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: StoredSecretKey): Promise<void> {
    this.values.delete(key);
  }
}

interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type EntryCtor = new (service: string, account: string) => KeyringEntry;

/** OS keychain through `@napi-rs/keyring` (Credential Manager, Keychain, Secret Service). */
export class KeyringSecretStore implements SecretStore {
  readonly backend = "keyring" as const;

  constructor(
    private readonly Entry: EntryCtor,
    private readonly service = "agent-rishi",
  ) {}

  async get(key: StoredSecretKey): Promise<string | null> {
    return new this.Entry(this.service, key).getPassword();
  }
  async set(key: StoredSecretKey, value: string): Promise<void> {
    await new this.Entry(this.service, key).setPassword(value);
  }
  async delete(key: StoredSecretKey): Promise<void> {
    await new this.Entry(this.service, key).deletePassword();
  }
}

/**
 * The OS keychain when the native module loads, else an in-memory store (secrets then last
 * only until the server stops). Loaded lazily so a missing prebuilt binary never blocks startup.
 */
export async function createSecretStore(log?: (m: string) => void): Promise<SecretStore> {
  try {
    const mod = (await import("@napi-rs/keyring")) as unknown as { AsyncEntry: EntryCtor };
    return new KeyringSecretStore(mod.AsyncEntry);
  } catch (error) {
    log?.(`keychain unavailable, keeping secrets in memory: ${String(error)}`);
    return new MemorySecretStore();
  }
}
