import {
  type FactoryFollowUp,
  type FactoryItem,
  type FactoryLoop,
  FOLLOW_UP_LABEL,
  type GitHubIssueRef,
  type Project,
} from "@agent-rishi/contracts";
import { badRequest, errorMessage } from "../errors";
import type { FactoryContext } from "./context";
import {
  type FollowUpPass,
  filedAtOnce,
  heldFollowUps,
  holdFollowUp,
  maintainHeldFollowUps,
  openIssueFor,
  scoutHoldsFollowUps,
  setFollowUp,
} from "./follow-ups-held";
import { FACTORY_LABEL } from "./intake";
import { FOLLOW_UPS_DUE } from "./store";

/**
 * Review follow-ups (§10.1, Review and revise): the reviewer's non-blocking findings. They
 * never fail a merge check or start a revise round. When the pull request merges, the item keeps
 * the follow-ups of the verdict on record. A dark factory whose scout runs rounds holds the low
 * and medium ones for the scout (`follow-ups-held.ts`) and files high-severity and security ones
 * at once; with the scout off it files each one at once (labelled and linked to the PR). The
 * software factory lists them on the item to file with "File issue". A follow-up whose title
 * matches an open issue is linked to that issue instead of filed again.
 */

/** How long the dark factory keeps retrying follow-ups GitHub didn't take; then they wait on the item. */
export const FOLLOW_UPS_RETRY_MS = 60 * 60_000;

/** What a merge records on the item: the verdict's follow-ups, and whether they wait to be filed. */
export function followUpsAtMerge(
  item: FactoryItem,
  at: string,
): Pick<FactoryItem, "followUps" | "nudges"> {
  const followUps =
    item.followUps.length > 0
      ? item.followUps
      : (item.review?.followUps ?? []).map((f): FactoryFollowUp => ({ ...f, issue: null }));
  const due = followUps.some((f) => !f.issue);
  return {
    followUps,
    nudges: due
      ? { ...item.nudges, [FOLLOW_UPS_DUE]: item.nudges[FOLLOW_UPS_DUE] ?? at }
      : item.nudges,
  };
}

/** The issue's text: the follow-up, the pull request it came from, and that it didn't block. */
function issueBody(item: FactoryItem, f: FactoryFollowUp): string {
  const pr = item.pr ? `#${item.pr.number} (${item.pr.url})` : "its pull request";
  const facts = [
    f.severity ? `Severity: ${f.severity}` : "",
    f.area ? `Area: ${f.area}` : "",
  ].filter(Boolean);
  return [
    f.title,
    "",
    `A follow-up from the independent review of ${pr}, "${item.title}". The reviewer approved the change; this didn't block the merge.`,
    ...(facts.length ? ["", facts.join(" · ")] : []),
    "",
    "_Filed by the Agent Rishi factory from a review follow-up._",
    `<!-- agent-rishi:factory follow-up item=${item.id} -->`,
  ].join("\n");
}

/**
 * File one follow-up: link it to an open issue with the same title (or one filed earlier in the
 * same pass, in `filed`), otherwise create the issue. Records the issue on the item.
 */
async function fileOne(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  index: number,
  filed: GitHubIssueRef[] = [],
): Promise<GitHubIssueRef> {
  const f = item.followUps[index] as FactoryFollowUp;
  if (f.issue) return f.issue;
  const issue =
    openIssueFor(ctx, project.id, f.title, filed) ??
    (await ctx.github.createIssue(project.id, {
      title: f.title,
      body: issueBody(item, f),
      labels: [FACTORY_LABEL, FOLLOW_UP_LABEL],
    }));
  filed.push({ ...issue, title: issue.title ?? f.title });
  setFollowUp(ctx, item.id, index, { issue, filedAt: ctx.now().toISOString() });
  return issue;
}

/**
 * The loop's step for merged work. In a dark factory: hold the follow-ups that wait for the
 * scout, or file them when they go straight through or the scout is off (retried on the next
 * ticks while GitHub doesn't take them, for up to `FOLLOW_UPS_RETRY_MS`), then keep the held list
 * current. In the software factory they wait on the item for a person's "File issue".
 */
export async function fileDueFollowUps(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
): Promise<void> {
  const dark = project.autonomyMode === "dark_factory";
  const hold = scoutHoldsFollowUps(project, loop);
  const pass: FollowUpPass = {
    filed: [],
    held: hold ? heldFollowUps(ctx, project.id).map((h) => h.title) : [],
  };
  for (const item of ctx.store.itemsWithFollowUpsDue(project.id)) {
    const since = Date.parse(item.nudges[FOLLOW_UPS_DUE] ?? "");
    let failed = false;
    if (dark) {
      for (const [index, f] of item.followUps.entries()) {
        if (f.issue || f.heldAt || f.dropped) continue;
        const current = ctx.store.item(item.id) ?? item;
        try {
          if (hold && !filedAtOnce(f)) holdFollowUp(ctx, project, current, index, pass);
          else await fileOne(ctx, project, current, index, pass.filed);
        } catch (error) {
          failed = true;
          ctx.log?.(`factory: filing a follow-up of ${item.id}: ${errorMessage(error)}`);
        }
      }
    }
    if (failed && ctx.now().getTime() - since < FOLLOW_UPS_RETRY_MS) continue;
    ctx.store.updateItem(
      item.id,
      (i) => {
        const { [FOLLOW_UPS_DUE]: _due, ...nudges } = i.nudges;
        return { ...i, nudges };
      },
      { touch: false },
    );
  }
  if (dark) maintainHeldFollowUps(ctx, project);
}

/** "File issue" on the item page, and "File now" on the scout's held list: file one follow-up of a merged item (once). */
export async function fileFollowUp(
  ctx: FactoryContext,
  project: Project,
  item: FactoryItem,
  index: number,
): Promise<FactoryItem> {
  if (!item.followUps[index]) {
    throw badRequest(
      item.followUps.length === 0
        ? "This item has no follow-ups to file: they are kept once its pull request merges"
        : `No follow-up ${index}: the item has ${item.followUps.length}`,
      "no_follow_up",
    );
  }
  await fileOne(ctx, project, item, index);
  return ctx.store.item(item.id) ?? item;
}
