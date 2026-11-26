import type { ExecutionBackendsResponse } from "@agent-rishi/contracts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppServices } from "../services/container";
import { queryOf } from "./validate";

/**
 * `/api/execution`: where agent sessions can run (`docs/remote-runners.md` §5). `backends` says
 * whether each backend can be used now, with the reason and the fix when it can't; given a
 * project, also whether that project may use it. `refresh=true` checks again instead of using
 * the last result (kept 30 s).
 */
export function executionRoutes(s: AppServices) {
  return new Hono().get(
    "/backends",
    queryOf(
      z.object({ projectId: z.string().min(1).optional(), refresh: z.enum(["true"]).optional() }),
    ),
    async (c) => {
      const { projectId, refresh } = c.req.valid("query");
      const project = projectId ? s.projects.get(projectId) : undefined;
      const backends = await s.sandboxes.statuses(project, { refresh: refresh === "true" });
      return c.json<ExecutionBackendsResponse>({ backends });
    },
  );
}
