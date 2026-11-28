import { CreateConnectionRequest, UpdateConnectionRequest } from "@agent-rishi/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody } from "./validate";

/**
 * `/api/connections` (`docs/foundation.md` §4): API-key and OpenAI-compatible connections. A
 * connection names its Vault key; no route returns a key.
 */
export function connectionRoutes(s: AppServices) {
  return new Hono()
    .get("/", (c) => c.json({ connections: s.connections.list() }))
    .post("/", jsonBody(CreateConnectionRequest), async (c) =>
      c.json(await s.connections.create(c.req.valid("json")), 201),
    )
    .get("/:id", (c) => c.json(s.connections.get(c.req.param("id"))))
    .patch("/:id", jsonBody(UpdateConnectionRequest), async (c) =>
      c.json(await s.connections.update(c.req.param("id"), c.req.valid("json"))),
    )
    .delete("/:id", (c) => {
      s.connections.delete(c.req.param("id"));
      return c.json({ ok: true as const });
    })
    .post("/:id/check", async (c) => c.json(await s.connections.check(c.req.param("id"))));
}
