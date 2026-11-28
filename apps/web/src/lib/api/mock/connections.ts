import { type Connection, connectionKind } from "@agent-rishi/contracts";
import type { ConnectionsApi } from "../feature-apis";

const OWNER = `own_${"0".repeat(32)}`;
const hex = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
const delay = <T>(value: T, ms = 80): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

/**
 * The mock server's connections. A check "lists" two demo models, except for a server whose
 * base URL ends in `/no-models`, which lists none, so its models are added by hand.
 */
export function mockConnections(): ConnectionsApi {
  const list: Connection[] = [];
  const find = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error("No such connection");
    return c;
  };
  const check = (c: Connection) => {
    const at = new Date().toISOString();
    const manual = c.models.filter((m) => m.manual);
    if (c.baseUrl?.endsWith("/no-models")) {
      c.level = c.vaultItemId ? "credential_found" : "configured";
      c.verifiedAt = null;
      c.lastCheck = {
        at,
        ok: false,
        message:
          "The server doesn't list its models at this address. Add its model IDs by hand; it will be verified by a test call.",
      };
      c.models = manual;
      return;
    }
    c.level = "verified";
    c.verifiedAt = at;
    c.lastCheck = { at, ok: true, message: "Listed 2 models" };
    c.models = [
      { id: "demo-large", name: "Demo Large", manual: false },
      { id: "demo-small", name: "Demo Small", manual: false },
      ...manual,
    ];
  };
  return {
    list: () => delay(list),
    async create(req) {
      const at = new Date().toISOString();
      const c: Connection = {
        id: `con_${hex()}`,
        name: req.name,
        provider: req.provider,
        kind: connectionKind(req.provider),
        baseUrl: req.baseUrl ?? null,
        vaultItemId: req.vaultItemId ?? null,
        owner: OWNER,
        scope: "personal",
        createdAt: at,
        updatedAt: at,
        level: "configured",
        verifiedAt: null,
        lastCheck: null,
        models: [],
      };
      check(c);
      list.push(c);
      return delay(c);
    },
    async update(id, req) {
      const c = find(id);
      if (req.name !== undefined) c.name = req.name;
      if (req.baseUrl !== undefined) c.baseUrl = req.baseUrl;
      if (req.vaultItemId !== undefined) c.vaultItemId = req.vaultItemId;
      if (req.manualModels !== undefined) {
        const listed = c.models.filter((m) => !m.manual);
        c.models = [
          ...listed,
          ...[...new Set(req.manualModels)]
            .filter((m) => !listed.some((l) => l.id === m))
            .map((m) => ({ id: m, name: null, manual: true })),
        ];
      }
      c.updatedAt = new Date().toISOString();
      return delay(c);
    },
    async remove(id) {
      list.splice(list.indexOf(find(id)), 1);
    },
    async check(id) {
      const c = find(id);
      check(c);
      return delay(c);
    },
  };
}
