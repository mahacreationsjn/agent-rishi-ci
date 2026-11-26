import {
  type FactoryItem,
  type FactoryLoop,
  type FactorySpecDecisionRequest,
  type Project,
  type Session,
  type SpecApproval,
  specHeld,
} from "@agent-rishi/contracts";
import { conflict, errorMessage, notFound } from "../errors";
import { type FactoryContext, raiseInbox } from "./context";
import { implementStep } from "./prompts";
import { specRevisionStep } from "./prompts-spec";
import { isBusy } from "./sessions";
import { claimSlot } from "./slots";
import { builderOpenPr, holdEarlyPr } from "./spec-early-pr";
import { buildsAhead, finishesOpenWork, wipOf, wipText } from "./wip";

/**
 * The optional spec approval (§10.1, `FactoryTuning.specApproval`, software factory only). A
 * feature's spec is the cheapest point to correct it, so with approval on the builder's analysis
 * waits for a person: they approve it, and the builder implements it, or ask for changes, and the
 * builder revises its analysis and submits it again. Nothing runs meanwhile: the builder is idle
 * (no agent slot), never nudged or failed, and its item takes no room under the PRs-open limit
 * and doesn't hold a drain. The decision reaches the builder through the loop, which waits for a
 * free agent like any turn it starts.
 */

const SPEC_INBOX = "inbox:factory-spec:";

/** The inbox item asking a person to approve an item's spec. */
export const specInboxId = (itemId: string) => `${SPEC_INBOX}${itemId}`;

const WAITING = "Waiting for you to approve the spec";

/** Whether specs wait for a person: approval is on and the project is a software factory. */
export function specGateOn(project: Project, loop: FactoryLoop): boolean {
  return project.autonomyMode === "software_factory" && loop.tuning.specApproval;
}

/** Whether the item's spec waits for a person's decision. */
export function specPending(item: FactoryItem): boolean {
  return item.specApproval?.state === "pending";
}

/**
 * Refuse `create_pull_request` from the builder of an item whose spec waits for a person or is
 * being revised at their request (in building, or failed and waiting to be put back): nothing is
 * built before the spec is approved, whatever a resumed or confused builder tries.
 */
export function assertSpecAllowsPr(ctx: FactoryContext, session: Session): void {
  if (!session.projectId) return;
  const item = ctx.store
    .items(session.projectId, ["building", "failed"])
    .find((i) => i.builderSessionId === session.id);
  if (!item || !specHeld(item)) return;
  throw conflict(
    specPending(item)
      ? "Your spec waits for a person's approval: a pull request is opened only after they approve it. End your turn now; Agent Rishi sends you the next step once they decide."
      : "A person asked for changes to your spec: submit the revised spec with `factory_submit_analysis` first. A pull request is opened only after they approve it.",
    "spec_not_approved",
  );
}

async function comment(ctx: FactoryContext, item: FactoryItem, body: string): Promise<void> {
  if (!item.issue) return;
  await ctx.github
    .comment(item.projectId, item.issue.number, body)
    .catch((error: unknown) => ctx.log?.(`factory: comment: ${errorMessage(error)}`));
}

/** The spec as the inbox and the issue show it: summary, spec and acceptance criteria. */
function specText(item: FactoryItem): string {
  const inv = item.investigation;
  return [
    inv?.summary ?? "",
    "",
    inv?.details ?? "",
    "",
    "Acceptance criteria:",
    ...item.acceptanceCriteria.map((c) => `- ${c}`),
  ]
    .join("\n")
    .trim();
}

/**
 * The approval record for a spec the builder just submitted: `pending` while specs wait for a
 * person. With approval off, a spec revised at a person's request counts as approved (the
 * builder's answer is the Implement step); otherwise there is none.
 */
export function approvalOnSubmit(
  ctx: FactoryContext,
  item: FactoryItem,
  gated: boolean,
): SpecApproval | null {
  const at = ctx.now().toISOString();
  const earlier = item.specApproval;
  if (gated) {
    return {
      state: "pending",
      requestedAt: at,
      decidedAt: null,
      by: null,
      feedback: earlier?.feedback ?? null,
      rounds: earlier?.rounds ?? 0,
      sentAt: null,
    };
  }
  if (!earlier) return null;
  return { ...earlier, state: "approved", decidedAt: at, by: "auto", sentAt: at };
}

/**
 * Ask a person to approve the spec the builder just submitted (an open `needs_you` item). Its
 * `updatedAt` is the spec's version (`requestedAt`), which a decision from the inbox carries.
 */
export function raiseSpecInbox(ctx: FactoryContext, item: FactoryItem): void {
  raiseInbox(ctx, {
    id: specInboxId(item.id),
    kind: "spec_approval",
    notify: "needs_you",
    projectId: item.projectId,
    sessionId: item.builderSessionId,
    issue: item.issue,
    title: `Approve the spec: ${item.title}`,
    body: specText(item),
    at: item.specApproval?.requestedAt,
  });
}

function closeSpecInbox(ctx: FactoryContext, itemId: string, note: string): void {
  const open = ctx.inbox.find(specInboxId(itemId));
  if (open?.status === "open") ctx.inbox.close(open, "resolved", { note });
}

/**
 * A person's decision on a spec that waits for one: approve it (the builder implements it) or ask
 * for changes (the builder revises its analysis). The loop sends the decision to the builder.
 */
export async function decideSpec(
  ctx: FactoryContext,
  projectId: string,
  itemId: string,
  req: FactorySpecDecisionRequest,
): Promise<FactoryItem> {
  const item = ctx.store.item(itemId);
  if (!item || item.projectId !== projectId) {
    throw notFound(`No factory item ${itemId}`, "item_not_found");
  }
  const spec = item.specApproval;
  if (item.stage !== "building" || spec?.state !== "pending") {
    throw conflict(`Item ${item.id} has no spec waiting for approval`, "spec_not_pending");
  }
  // Made on a version the builder has revised since (a page open from before): read it again.
  if (req.version && Date.parse(req.version) !== Date.parse(spec.requestedAt)) {
    throw conflict(
      "The spec changed since it was shown: read the revised spec, then decide again",
      "spec_changed",
    );
  }
  const at = ctx.now().toISOString();
  const decided = { ...spec, decidedAt: at, by: "user" as const, sentAt: null };
  if (req.decision === "approve") {
    const updated = ctx.store.updateItem(item.id, (i) => ({
      ...i,
      specApproval: { ...decided, state: "approved" },
      note: "Spec approved: the builder implements it next",
    }));
    closeSpecInbox(ctx, item.id, "Spec approved");
    await comment(
      ctx,
      item,
      "**Agent Rishi software factory**: spec approved.\n\nNext: Implement.",
    );
    return updated;
  }
  const updated = ctx.store.updateItem(item.id, (i) => ({
    ...i,
    specApproval: {
      ...decided,
      state: "changes_requested",
      feedback: req.feedback,
      rounds: spec.rounds + 1,
    },
    note: "Changes requested to the spec: the builder revises it",
  }));
  closeSpecInbox(ctx, item.id, "Changes requested");
  const quoted = req.feedback
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  await comment(
    ctx,
    item,
    `**Agent Rishi software factory**: changes requested to the spec before it is built:\n\n${quoted}\n\nNext: the agent revises its analysis.`,
  );
  return updated;
}

/**
 * The spec's part of the building step (`advanceBuilding`): the loop when it owns this tick (the
 * spec waits for a person, or their decision waits to reach the builder), or null when building
 * goes on as usual. A builder that is gone takes the usual path (an infrastructure failure, then
 * a fresh builder whose brief carries the decision).
 */
export async function advanceSpec(
  ctx: FactoryContext,
  project: Project,
  loop: FactoryLoop,
  item: FactoryItem,
  builder: Session | undefined,
): Promise<FactoryLoop | null> {
  let spec = item.specApproval;
  if (!spec) return null;
  if (spec.state === "pending") {
    if (specGateOn(project, loop)) {
      // A PR on the builder's branch (`gh pr create`, or a person's) waits too (`spec-early-pr.ts`).
      const early = builder ? builderOpenPr(ctx, project.id, builder) : null;
      if (early) await holdEarlyPr(ctx, item, early);
      else note(ctx, item, WAITING);
      return loop;
    }
    // Approval was turned off (or the project became a dark factory) while it waited.
    spec = { ...spec, state: "approved", decidedAt: ctx.now().toISOString(), by: "auto" };
    item = ctx.store.updateItem(item.id, (i) => ({ ...i, specApproval: spec }));
    closeSpecInbox(ctx, item.id, "Spec approval is off: approved automatically");
    // The issue's last word was that the spec awaits approval (once: it is approved now).
    const why = !loop.tuning.specApproval
      ? "spec approval turned off"
      : project.autonomyMode === "dark_factory"
        ? "the project now runs as a dark factory"
        : "the project no longer runs as a software factory";
    await comment(
      ctx,
      item,
      `**Agent Rishi software factory**: Spec approved automatically (${why}).\n\nNext: Implement.`,
    );
  }
  if (!builder) return null;
  if (spec.sentAt) {
    // Wait until the builder has taken a turn since it was sent the decision.
    const unseen =
      builder.status === "idle" && Date.parse(builder.updatedAt) <= Date.parse(spec.sentAt);
    return unseen ? loop : null;
  }
  // A builder started after the decision had it in its brief.
  if (spec.decidedAt && Date.parse(builder.createdAt) > Date.parse(spec.decidedAt)) {
    markSent(ctx, item, builder.createdAt);
    return null;
  }
  if (isBusy(builder)) return loop;
  // A paused loop (budget, failures in a row) starts no agent turns.
  if (loop.state === "paused") {
    note(ctx, item, "Spec decided: the builder carries on once the loop resumes");
    return loop;
  }
  const approved = spec.state === "approved";
  // An approved spec becomes a build that will open a PR: it needs room under the limit, after
  // the builds ahead of it (approved specs go oldest first and never count against each other).
  if (approved && !finishesOpenWork(ctx, item)) {
    const wip = wipOf(ctx, project, loop);
    const ahead = buildsAhead(ctx, project.id, item);
    if (wip.openPrs + ahead >= wip.limit) {
      note(ctx, item, `Spec approved; waiting: ${wipText(wip, ahead).replace(/^F/, "f")}`);
      return loop;
    }
  }
  // After the reviews, fixes and rebases waiting for an agent, before new builds (`slots.ts`).
  if (!claimSlot(ctx, project, "resume", `spec:${item.id}`, { wake: builder.id })) {
    note(ctx, item, "Spec decided: the builder carries on when an agent is free");
    return loop;
  }
  try {
    await ctx.sessions.startTurn(
      builder.id,
      approved ? implementStep(item) : specRevisionStep(item),
    );
  } catch (error) {
    note(ctx, item, `Could not send the spec decision to its builder: ${errorMessage(error)}`);
    return loop;
  }
  markSent(ctx, item, ctx.now().toISOString());
  return loop;
}

/** The builder has the decision: building goes on, and a revision gets the Analyze reminder afresh. */
function markSent(ctx: FactoryContext, item: FactoryItem, at: string): void {
  ctx.store.updateItem(item.id, (i) => {
    if (!i.specApproval) return i;
    const { builder_investigate: _asked, ...nudges } = i.nudges;
    return {
      ...i,
      specApproval: { ...i.specApproval, sentAt: at },
      note: null,
      nudges: i.specApproval.state === "changes_requested" ? nudges : i.nudges,
    };
  });
}

function note(ctx: FactoryContext, item: FactoryItem, text: string): void {
  if (item.note !== text)
    ctx.store.updateItem(item.id, (i) => ({ ...i, note: text }), { touch: false });
}

/**
 * Resolve spec inbox items that wait for nothing any more: their item left building, was retried
 * or retyped, or its spec was decided some other way. Each tick, for the project's open items.
 */
export function settleSpecInbox(ctx: FactoryContext, projectId: string): void {
  for (const open of ctx.inbox.list({ projectId })) {
    if (!open.id.startsWith(SPEC_INBOX)) continue;
    const item = ctx.store.item(open.id.slice(SPEC_INBOX.length));
    if (item?.stage === "building" && specPending(item)) continue;
    ctx.inbox.close(open, "resolved", { note: "The spec no longer waits for approval" });
  }
}
