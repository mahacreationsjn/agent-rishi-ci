import {
  type FactoryAdmitRequest,
  FactoryDigest,
  type FactoryDismissRequest,
  type FactoryFileFollowUpRequest,
  type FactoryItem,
  FactoryItemResponse,
  type FactoryLesson,
  FactoryLessonResponse,
  FactoryLoop,
  type FactoryRetryOptions,
  FactoryScorecard,
  type FactorySetTypeRequest,
  type FactorySpecDecisionRequest,
  type FactorySpotCheckRequestInit,
  FactorySpotCheckResponse,
  FactoryStatus,
  type KillSwitchMode,
  type KillSwitchRequestInit,
  KillSwitchResponse,
  type ScorecardDays,
  type SetAutonomyModeRequestInit,
  SetAutonomyModeResponse,
  VisionResponse,
} from "@agent-rishi/contracts";
import type { Fetcher } from "./http";

/**
 * `/api/projects/:id/{autonomy,vision,kill-switch,factory/*}` and `/api/factory/kill-switch`
 * (§10.1, experimental): autonomy modes, the vision, the software/dark factory panel, its
 * items and controls.
 */
export interface FactoryApi {
  status(projectId: string): Promise<FactoryStatus>;
  /** One work item with what it cost so far. */
  item(projectId: string, itemId: string): Promise<FactoryItemResponse>;
  /**
   * The scorecard: first-pass merges, revise rounds, reverts, cost and time to merge by builder
   * and reviewer (provider and model) over the work that finished in the last `days`.
   */
  scorecard(projectId: string, days: ScorecardDays): Promise<FactoryScorecard>;
  /**
   * Switch mode (and save limits). Factory modes need a GitHub project (409
   * `not_a_github_project`), a vision file (409 `vision_required`) and limits with a daily
   * budget (400 `limits_required` / `budget_required`).
   */
  setMode(projectId: string, req: SetAutonomyModeRequestInit): Promise<SetAutonomyModeResponse>;
  /** The vision; the template with `exists: false` when the file is missing. */
  vision(projectId: string): Promise<VisionResponse>;
  saveVision(projectId: string, contents: string): Promise<VisionResponse>;
  /**
   * The project's kill switch, or every project's with `"global"`. On stops now by default;
   * `mode: "drain"` (a project's only) finishes the work in flight, then stops, optionally within
   * `drainLimitMin`. Off releases the switch and cancels a drain.
   */
  killSwitch(
    scope: { projectId: string } | "global",
    on: boolean,
    opts?: { mode?: KillSwitchMode; drainLimitMin?: number | null },
  ): Promise<KillSwitchResponse>;
  /** Clear a pause and the failure count, and cancel a drain. */
  resume(projectId: string): Promise<FactoryLoop>;
  /** Run one loop step now ("Check now"); returns the fresh status. */
  tick(projectId: string): Promise<FactoryStatus>;
  /**
   * Dark factory: start a scout round now, skipping the interval and the backlog threshold;
   * returns the fresh status. 409 `scout_unavailable` says why it can't (as
   * `status.scout.runNowBlockedBy` does).
   */
  runScout(projectId: string): Promise<FactoryStatus>;
  /** Today's digest, now (also raised in the inbox). */
  digest(projectId: string): Promise<FactoryDigest>;
  /** Let an issue from an untrusted author in (it is never merged automatically). */
  admit(projectId: string, req: FactoryAdmitRequest): Promise<FactoryItem>;
  /** Move an item that hasn't started to another pipeline. */
  setType(projectId: string, req: FactorySetTypeRequest): Promise<FactoryItem>;
  /**
   * Run a stopped item again: with its PR open, a fresh review of that PR (`rereview`, the
   * default then); otherwise, or with `rebuild`, from the first step. 409 `no_open_pr` when a
   * re-review is asked for without an open PR.
   */
  retry(projectId: string, itemId: string, opts?: FactoryRetryOptions): Promise<FactoryItem>;
  /**
   * Dismiss a failed item without an open PR: it is rejected with the reason. 409 `pr_open`
   * while its PR is open, `not_failed` for other stages.
   */
  dismiss(projectId: string, itemId: string, req?: FactoryDismissRequest): Promise<FactoryItem>;
  /**
   * Approve a feature's spec that waits for approval, or ask for changes to it (the builder
   * revises its analysis). 409 `spec_not_pending` when its spec doesn't wait.
   */
  decideSpec(
    projectId: string,
    itemId: string,
    req: FactorySpecDecisionRequest,
  ): Promise<FactoryItem>;
  /**
   * Forget one of the lessons the factory's reviewers recorded: it leaves the briefs and is never
   * learned again. 404 `lesson_not_found`.
   */
  forgetLesson(projectId: string, lessonId: string): Promise<FactoryLesson>;
  /**
   * "File issue": file one review follow-up of a merged item (by its position in `followUps`),
   * or link it to the open issue with the same title. Filing it again changes nothing; 400
   * `no_follow_up` when there is no such follow-up.
   */
  fileFollowUp(projectId: string, itemId: string, index: number): Promise<FactoryItem>;
  /**
   * "Dismiss" on the scout's held list: the review follow-up leaves it without an issue (the item
   * keeps it for "File issue"). 409 `follow_up_filed` once it has an issue.
   */
  dismissFollowUp(projectId: string, itemId: string, index: number): Promise<FactoryItem>;
  /**
   * A person's spot-check of a merge: Looks good, or Found a problem with a note (filed as a
   * follow-up issue unless `fileIssue: false`). The verdict is recorded even when GitHub doesn't
   * take the issue (`issueError`). 409 `spot_check_not_pending` when none waits.
   */
  spotCheck(
    projectId: string,
    itemId: string,
    req: FactorySpotCheckRequestInit,
  ): Promise<FactorySpotCheckResponse>;
  /**
   * "File issue": the follow-up issue of a spot-check problem recorded without one. 409
   * `spot_check_not_problem` or `spot_check_issue_filed`.
   */
  fileSpotCheckIssue(projectId: string, itemId: string): Promise<FactorySpotCheckResponse>;
}

const enc = encodeURIComponent;

export function httpFactoryApi(http: Fetcher): FactoryApi {
  const { get, post, call } = http;
  const p = (id: string) => `/projects/${enc(id)}`;
  const item = (v: unknown) => FactoryItemResponse.parse(v).item;
  return {
    status: (id) => get(`${p(id)}/factory`, (v) => FactoryStatus.parse(v)),
    item: (id, itemId) =>
      get(`${p(id)}/factory/items/${enc(itemId)}`, (v) => FactoryItemResponse.parse(v)),
    scorecard: (id, days) =>
      get(`${p(id)}/factory/scorecard?days=${days}`, (v) => FactoryScorecard.parse(v)),
    setMode: (id, req) =>
      call("PUT", `${p(id)}/autonomy`, req, (v) => SetAutonomyModeResponse.parse(v)),
    vision: (id) => get(`${p(id)}/vision`, (v) => VisionResponse.parse(v)),
    saveVision: (id, contents) =>
      call("PUT", `${p(id)}/vision`, { contents }, (v) => VisionResponse.parse(v)),
    killSwitch: (scope, on, opts = {}) =>
      post(
        scope === "global" ? "/factory/kill-switch" : `${p(scope.projectId)}/kill-switch`,
        { on, ...opts } satisfies KillSwitchRequestInit,
        (v) => KillSwitchResponse.parse(v),
      ),
    resume: (id) => post(`${p(id)}/factory/resume`, {}, (v) => FactoryLoop.parse(v)),
    tick: (id) => post(`${p(id)}/factory/tick`, {}, (v) => FactoryStatus.parse(v)),
    runScout: (id) => post(`${p(id)}/factory/scout`, {}, (v) => FactoryStatus.parse(v)),
    digest: (id) => post(`${p(id)}/factory/digest`, {}, (v) => FactoryDigest.parse(v)),
    admit: (id, req) => post(`${p(id)}/factory/admit`, req, item),
    setType: (id, req) => post(`${p(id)}/factory/set-type`, req, item),
    retry: (id, itemId, opts) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/retry`, opts ?? {}, item),
    dismiss: (id, itemId, req = {}) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/dismiss`, req, item),
    decideSpec: (id, itemId, req) => post(`${p(id)}/factory/items/${enc(itemId)}/spec`, req, item),
    forgetLesson: (id, lessonId) =>
      call(
        "DELETE",
        `${p(id)}/factory/lessons/${enc(lessonId)}`,
        undefined,
        (v) => FactoryLessonResponse.parse(v).lesson,
      ),
    fileFollowUp: (id, itemId, index) =>
      post(
        `${p(id)}/factory/items/${enc(itemId)}/follow-ups/file`,
        { index } satisfies FactoryFileFollowUpRequest,
        item,
      ),
    dismissFollowUp: (id, itemId, index) =>
      post(
        `${p(id)}/factory/items/${enc(itemId)}/follow-ups/dismiss`,
        { index } satisfies FactoryFileFollowUpRequest,
        item,
      ),
    spotCheck: (id, itemId, req) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/spot-check`, req, (v) =>
        FactorySpotCheckResponse.parse(v),
      ),
    fileSpotCheckIssue: (id, itemId) =>
      post(`${p(id)}/factory/items/${enc(itemId)}/spot-check/file-issue`, {}, (v) =>
        FactorySpotCheckResponse.parse(v),
      ),
  };
}
