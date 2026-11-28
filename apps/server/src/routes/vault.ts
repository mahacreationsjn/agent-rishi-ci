import {
  CreateVaultGrantRequest,
  CreateVaultItemRequest,
  UpdateVaultItemRequest,
  VaultAuditQuery,
  VaultItemId,
} from "@agent-rishi/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/vault` (`docs/foundation.md` §3): items, grants and the audit. Values go in, never out:
 * no route returns one.
 */
export function vaultRoutes(s: AppServices) {
  return new Hono()
    .get("/status", (c) => c.json(s.vault.status()))
    .get("/items", (c) => c.json({ items: s.vault.list() }))
    .post("/items", jsonBody(CreateVaultItemRequest), (c) =>
      c.json(s.vault.create(c.req.valid("json")), 201),
    )
    .get("/items/:id", (c) => c.json(s.vault.get(c.req.param("id"))))
    .patch("/items/:id", jsonBody(UpdateVaultItemRequest), (c) =>
      c.json(s.vault.update(c.req.param("id"), c.req.valid("json"))),
    )
    .delete("/items/:id", async (c) => {
      await s.vault.delete(c.req.param("id"));
      return c.json({ ok: true as const });
    })
    .get("/grants", queryOf(z.object({ itemId: VaultItemId.optional() })), (c) =>
      c.json({ grants: s.vault.listGrants(c.req.valid("query").itemId) }),
    )
    .post("/grants", jsonBody(CreateVaultGrantRequest), (c) =>
      c.json(s.vault.grant(c.req.valid("json")), 201),
    )
    .delete("/grants/:id", (c) => {
      s.vault.revoke(c.req.param("id"));
      return c.json({ ok: true as const });
    })
    .get("/audit", queryOf(VaultAuditQuery), (c) =>
      c.json({ entries: s.vault.audit(c.req.valid("query")) }),
    );
}
