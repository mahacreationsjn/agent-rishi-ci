import {
  VAULT_VALUE_MIN,
  type VaultAuditAction,
  type VaultAuditEntry,
  type VaultGrant,
  type VaultItem,
} from "@agent-rishi/contracts";
import type { VaultApi } from "../feature-apis";

const OWNER = `own_${"0".repeat(32)}`;
const hex = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const delay = <T>(value: T, ms = 80): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

/** The mock server's Vault: items and grants in memory; values are dropped on arrival. */
export function mockVault(): VaultApi {
  const items: VaultItem[] = [];
  const grants: VaultGrant[] = [];
  const audit: VaultAuditEntry[] = [];
  const now = () => new Date().toISOString();
  const record = (action: VaultAuditAction, item: VaultItem, grantId: string | null = null) => {
    audit.unshift({
      seq: audit.length + 1,
      at: now(),
      action,
      itemId: item.id,
      itemName: item.name,
      grantId,
      sessionId: null,
      detail: null,
    });
  };
  const find = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error("No such Vault item");
    return item;
  };
  const checkValue = (value: string) => {
    if (value.length < VAULT_VALUE_MIN) {
      throw new Error(`Too short: a value needs at least ${VAULT_VALUE_MIN} characters`);
    }
  };
  return {
    status: () => delay({ state: "ready" as const, reason: null, items: items.length }),
    items: () => delay(items),
    async create(req) {
      checkValue(req.value);
      const at = now();
      const base = {
        id: `vlt_${hex()}`,
        name: req.name,
        owner: OWNER,
        scope: "personal" as const,
        createdAt: at,
        updatedAt: at,
        lastUsedAt: null,
        readable: true,
      };
      const item: VaultItem =
        req.kind === "env-secret"
          ? { ...base, kind: "env-secret", envName: req.envName }
          : { ...base, kind: "api-credential", provider: req.provider };
      items.push(item);
      record("item.created", item);
      return delay(item);
    },
    async update(id, req) {
      const item = find(id);
      if (req.value !== undefined) checkValue(req.value);
      if (req.name !== undefined && req.name !== item.name) {
        item.name = req.name;
        record("item.renamed", item);
      }
      if (req.value !== undefined) record("item.value_changed", item);
      item.updatedAt = now();
      return delay(item);
    },
    async remove(id) {
      const item = find(id);
      items.splice(items.indexOf(item), 1);
      for (let i = grants.length - 1; i >= 0; i--)
        if (grants[i]?.itemId === id) grants.splice(i, 1);
      record("item.deleted", item);
    },
    async importEnv(text) {
      const created: VaultItem[] = [];
      const skipped: { line: number; name: string | null; reason: string }[] = [];
      for (const [index, raw] of text.split(/\r?\n/).entries()) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        const name = m?.[1];
        const value = m?.[2]?.replace(/^(["'])(.*)\1$/, "$2") ?? "";
        if (!name) {
          skipped.push({ line: index + 1, name: null, reason: "Not a NAME=value line" });
        } else if (value.length < VAULT_VALUE_MIN) {
          skipped.push({ line: index + 1, name, reason: "Too short to hide in transcripts" });
        } else {
          const item = await this.create({ kind: "env-secret", name, envName: name, value });
          created.push(item);
        }
      }
      return delay({ created, skipped });
    },
    grants: (itemId) => delay(grants.filter((g) => !itemId || g.itemId === itemId)),
    async grant(req) {
      const item = find(req.itemId);
      const grant: VaultGrant = {
        id: `vgr_${hex()}`,
        itemId: item.id,
        role: req.role ?? null,
        projectId: req.projectId ?? null,
        destination: req.destination ?? null,
        expiresAt: req.expiresAt ?? null,
        owner: OWNER,
        scope: "personal",
        createdAt: now(),
      };
      grants.push(grant);
      record("grant.created", item, grant.id);
      return delay(grant);
    },
    async revoke(grantId) {
      const grant = grants.find((g) => g.id === grantId);
      if (!grant) throw new Error("No such grant");
      grants.splice(grants.indexOf(grant), 1);
      record("grant.revoked", find(grant.itemId), grantId);
    },
    audit: (query = {}) =>
      delay(
        audit
          .filter((e) => !query.itemId || e.itemId === query.itemId)
          .slice(0, query.limit ?? 100),
      ),
  };
}
