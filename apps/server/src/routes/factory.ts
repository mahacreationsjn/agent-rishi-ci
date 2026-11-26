import {
  FactoryAdmitRequest,
  FactoryDismissRequest,
  FactoryFileFollowUpRequest,
  type FactoryItemResponse,
  type FactoryLessonResponse,
  FactoryRetryOptions,
  type FactoryScorecard,
  FactoryScorecardQuery,
  FactorySetTypeRequest,
  FactorySpecDecisionRequest,
  FactorySpotCheckRequest,
  type FactorySpotCheckResponse,
  KillSwitchRequest,
  PutVisionRequest,
  SetAutonomyModeRequest,
} from "@agent-rishi/contracts";
import { Hono } from "hono";
import type { AppServices } from "../services/container";
import { jsonBody, queryOf } from "./validate";

/**
 * `/api/projects/:id/...`: autonomy mode, vision, the factory panel and its controls (§10.1).
 * Mounted under `/projects`. `factory/scout` is "Run scout now": 409 `scout_unavailable` with
 * the reason when no round can start. `kill-switch` takes `mode` (`now`, the default, or
 * `drain`: finish the work in flight, then stop); `factory/resume` also cancels a drain.
 * `DELETE factory/lessons/:lessonId` forgets a lesson (404 `lesson_not_found`).
 * `follow-ups/file` is "File issue" for one review follow-up of a merged item (and "File now" on
 * the scout's held list); `follow-ups/dismiss` drops a held one (409 `follow_up_filed` once filed).
 * `items/:itemId/spec` approves a feature's spec or asks for changes (409 `spec_not_pending`
 * unless it waits for approval).
 * `factory/scorecard?days=7|30|90` (30 by default) is the scorecard by builder and reviewer.
 * `items/:itemId/spot-check` records a person's spot-check of a merge (409
 * `spot_check_not_pending` unless one waits); `spot-check/file-issue` files the follow-up issue of
 * a problem recorded without one (409 `spot_check_not_problem` or `spot_check_issue_filed`).
 */
export function projectFactoryRoutes(s: AppServices) {
  const f = s.factory;
  return new Hono()
    .get("/:id/factory", async (c) => c.json(await f.status(c.req.param("id"))))
    .put("/:id/autonomy", jsonBody(SetAutonomyModeRequest), async (c) =>
      c.json(await f.setMode(c.req.param("id"), c.req.valid("json"))),
    )
    .get("/:id/vision", (c) => c.json(f.vision(c.req.param("id"))))
    .put("/:id/vision", jsonBody(PutVisionRequest), async (c) =>
      c.json(await f.putVision(c.req.param("id"), c.req.valid("json").contents)),
    )
    .post("/:id/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
      const { on, mode, drainLimitMin } = c.req.valid("json");
      return c.json(await f.setKillSwitch(c.req.param("id"), on, { mode, drainLimitMin }));
    })
    .post("/:id/factory/resume", async (c) => c.json(await f.resume(c.req.param("id"))))
    .post("/:id/factory/tick", async (c) => {
      await f.checkNow(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/scout", async (c) => {
      await f.runScout(c.req.param("id"));
      return c.json(await f.status(c.req.param("id")));
    })
    .post("/:id/factory/digest", async (c) => c.json(await f.digestNow(c.req.param("id"))))
    .get("/:id/factory/scorecard", queryOf(FactoryScorecardQuery), async (c) =>
      c.json<FactoryScorecard>(await f.scorecard(c.req.param("id"), c.req.valid("query").days)),
    )
    .get("/:id/factory/items/:itemId", async (c) => {
      const id = c.req.param("id");
      return c.json<FactoryItemResponse>(
        await f.itemResponse(id, f.item(id, c.req.param("itemId"))),
      );
    })
    .post("/:id/factory/admit", jsonBody(FactoryAdmitRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.admit(id, c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/set-type", jsonBody(FactorySetTypeRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.setType(id, c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/retry", jsonBody(FactoryRetryOptions), async (c) => {
      const id = c.req.param("id");
      const item = f.retry(id, c.req.param("itemId"), c.req.valid("json").mode);
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/dismiss", jsonBody(FactoryDismissRequest), async (c) => {
      const id = c.req.param("id");
      const item = f.dismiss(id, c.req.param("itemId"), c.req.valid("json"), "user");
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/spec", jsonBody(FactorySpecDecisionRequest), async (c) => {
      const id = c.req.param("id");
      const item = await f.decideSpec(id, c.req.param("itemId"), c.req.valid("json"));
      return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
    })
    .post("/:id/factory/items/:itemId/spot-check", jsonBody(FactorySpotCheckRequest), async (c) =>
      c.json<FactorySpotCheckResponse>(
        await f.decideSpotCheck(c.req.param("id"), c.req.param("itemId"), c.req.valid("json")),
      ),
    )
    .post("/:id/factory/items/:itemId/spot-check/file-issue", async (c) =>
      c.json<FactorySpotCheckResponse>(
        await f.fileSpotCheckIssue(c.req.param("id"), c.req.param("itemId")),
      ),
    )
    .delete("/:id/factory/lessons/:lessonId", (c) =>
      c.json<FactoryLessonResponse>({
        lesson: f.forgetLesson(c.req.param("id"), c.req.param("lessonId")),
      }),
    )
    .post(
      "/:id/factory/items/:itemId/follow-ups/file",
      jsonBody(FactoryFileFollowUpRequest),
      async (c) => {
        const id = c.req.param("id");
        const item = await f.fileFollowUp(id, c.req.param("itemId"), c.req.valid("json").index);
        return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
      },
    )
    .post(
      "/:id/factory/items/:itemId/follow-ups/dismiss",
      jsonBody(FactoryFileFollowUpRequest),
      async (c) => {
        const id = c.req.param("id");
        const itemId = c.req.param("itemId");
        const item = await f.dismissFollowUp(id, itemId, c.req.valid("json").index);
        return c.json<FactoryItemResponse>(await f.itemResponse(id, item));
      },
    );
}

/** `/api/factory`: the global kill switch (Stop now only: 400 `drain_per_project` for a drain). */
export function factoryRoutes(s: AppServices) {
  return new Hono().post("/kill-switch", jsonBody(KillSwitchRequest), async (c) => {
    const { on, mode } = c.req.valid("json");
    return c.json(await s.factory.setGlobalKillSwitch(on, mode));
  });
}
