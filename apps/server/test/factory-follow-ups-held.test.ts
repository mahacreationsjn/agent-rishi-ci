import {
  type FactoryFollowUp,
  FOLLOW_UP_LABEL,
  type ReviewFollowUp,
  type Session,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceError } from "../src/services/errors";
import { FOLLOW_UPS_HELD } from "../src/services/factory/store";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Review follow-ups in a dark factory whose scout runs rounds (#435). Filing every follow-up as
 * its own issue the moment a PR merges bypassed the scout's "Issues per round" and snowballed
 * minor work, so low and medium ones are held as scout findings that compete for a round's slots;
 * high-severity and security ones are still filed at once.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

const FOLLOW_UPS: ReviewFollowUp[] = [
  { title: "Rename the counter's reset helper", severity: "low", area: "maintainability" },
  { title: "Debounce the counter's save", severity: "medium", area: "performance" },
  { title: "Document the counter shortcut", severity: "low", area: "docs" },
];

const DAY = 24 * 3_600_000;
const followUpIssues = () => env.gh.issues.filter((i) => i.labels.includes(FOLLOW_UP_LABEL));
const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined) => env.repo.get(id as string) as Session;
const held = async () => (await env.factory.status(env.project.id)).scout?.heldFollowUps ?? [];
const code = (run: () => Promise<unknown>) =>
  run().then(
    () => "ok",
    (error: ServiceError) => error.code,
  );

/** A dark factory with scheduled scout rounds on, filing at most 2 issues a round. */
function darkFactory(minBacklog = 2) {
  env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
  s.enable("dark_factory", { tuning: { minBacklog, maxIssuesPerRound: 2, discoveryPerRound: 1 } });
}

/** Build an item, approve it with `followUps` and let the loop merge it and take its follow-ups. */
async function mergeWith(followUps: ReviewFollowUp[], title?: string, issue?: number) {
  const { id, pr } = await s.verifying("success", title, issue);
  await s.review(id, { ...APPROVE, followUps });
  await s.tick();
  expect(env.gh.merges.map((m) => m.number)).toContain(pr.ref.number);
  await s.tick();
  await s.tick();
  return { id, pr };
}

/** A merged item whose follow-ups were held at `heldAt` (as a merge long ago left them). */
function heldItem(n: number, followUps: Array<Partial<FactoryFollowUp> & { heldAt: string }>) {
  return env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${100 + n}`,
    title: `Merged work ${n}`,
    summary: "Done",
    source: "issue",
    stage: "merged",
    followUps: followUps.map((f, i) => ({ title: `Follow-up ${n}.${i}`, issue: null, ...f })),
    nudges: { [FOLLOW_UPS_HELD]: followUps[0]?.heldAt ?? new Date().toISOString() },
  });
}

describe("held review follow-ups (#435)", () => {
  it("holds a merged PR's low and medium follow-ups for the scout instead of filing them", async () => {
    darkFactory();
    const { id, pr } = await mergeWith(FOLLOW_UPS);
    // They wait for the scout's next round instead of becoming three builds at once.
    expect(followUpIssues().map((i) => i.title)).toEqual([]);
    expect(s.item(id).followUps.map((f) => f.issue)).toEqual([null, null, null]);
    expect(s.item(id).followUps.every((f) => f.heldAt)).toBe(true);
    // The scout card's held list: medium first, then oldest first, each with its source PR.
    const list = await held();
    expect(list.map((h) => [h.title, h.severity, h.area])).toEqual([
      ["Debounce the counter's save", "medium", "performance"],
      ["Rename the counter's reset helper", "low", "maintainability"],
      ["Document the counter shortcut", "low", "docs"],
    ]);
    expect(list[0]).toMatchObject({ itemId: id, index: 1, pr: { number: pr.ref.number } });
    // Held once: later ticks and a restart hold nothing twice and file nothing.
    env.restart();
    await s.tick();
    expect(await held()).toHaveLength(3);
    expect(followUpIssues()).toHaveLength(0);
  });

  it("files at most Issues per round in total across held follow-ups and lens findings", async () => {
    darkFactory();
    await mergeWith(FOLLOW_UPS);
    const [debounce, rename] = await held();
    // The round started while the queue ran low; its area reviewer reports one finding.
    expect(loop().scout.round?.phase).toBe("planning");
    const scout = session(loop().scout.sessionId);
    await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "the counter" }] });
    await s.tick();
    const lens = session(loop().scout.lensSessions.ux);
    await env.factory.reportFindings(lens, [
      {
        title: "Counter loses focus",
        summary: "Focus jumps away after a click",
        type: "bug",
        severity: "medium",
        acceptanceCriteria: ["Focus stays"],
      },
    ]);
    await s.tick();
    expect(loop().scout.round?.phase).toBe("filing");
    // The scout sees the held follow-ups beside its area reviewer's findings, with their ids.
    const brief = s.lastMessageTo(scout.id);
    expect(brief).toContain("[ux-1]");
    expect(brief).toContain(`[${debounce?.id}]`);
    expect(brief).toContain("Held review follow-ups (3)");
    const file = (title: string, findingIds: string[]) =>
      env.factory.fileIssue(scout, {
        title,
        summary: `${title}.`,
        type: "bug",
        acceptanceCriteria: [`${title} done`],
        priority: "normal",
        findingIds,
      });
    await file("Debounce the counter's save", [debounce?.id as string]);
    await file("Counter loses focus", ["ux-1"]);
    expect(await code(() => file("Rename the reset helper", [rename?.id as string]))).toBe(
      "round_limit",
    );
    // Two issues in total; the one covering a follow-up is labelled and linked on its item.
    const scoutIssues = env.gh.issues.filter((i) => i.author === "agent-rishi");
    expect(scoutIssues.map((i) => i.title)).toEqual([
      "Debounce the counter's save",
      "Counter loses focus",
    ]);
    expect(scoutIssues[0]?.labels).toContain(FOLLOW_UP_LABEL);
    expect(scoutIssues[0]?.body).toContain(`Covers review follow-ups of #${debounce?.pr?.number}`);
    expect(s.item(debounce?.itemId as string).followUps[1]?.issue?.number).toBe(
      scoutIssues[0]?.number,
    );
    // The rest stay held for later rounds.
    expect((await held()).map((h) => h.id)).toEqual([rename?.id, expect.any(String)]);
  });

  it("lets the scout file from held follow-ups alone, without area reviewers", async () => {
    darkFactory();
    await mergeWith(FOLLOW_UPS);
    const scout = session(loop().scout.sessionId);
    const plan = await env.factory.planRound(scout, { lenses: [] });
    expect(plan.next).toContain("the 3 held review follow-ups in your brief included");
    expect(loop().scout.round?.phase).toBe("filing");
    const [first] = await held();
    await env.factory.fileIssue(scout, {
      title: first?.title as string,
      summary: "Debounce it.",
      type: "bug",
      acceptanceCriteria: ["Saves once"],
      priority: "low",
    });
    // Matched by its title even without its id.
    expect((await held()).map((h) => h.title)).not.toContain(first?.title);
  });

  it("files high-severity and security follow-ups at once, outside the round's cap", async () => {
    darkFactory();
    const { id } = await mergeWith([
      { title: "Archiving deletes unpushed commits", severity: "high", area: "runner" },
      { title: "Token appears in the setup log", severity: "low", area: "Security" },
      { title: "Rename the reset helper", severity: "low" },
    ]);
    expect(followUpIssues().map((i) => i.title)).toEqual([
      "Archiving deletes unpushed commits",
      "Token appears in the setup log",
    ]);
    expect(s.item(id).followUps.map((f) => Boolean(f.issue))).toEqual([true, true, false]);
    expect((await held()).map((h) => h.title)).toEqual(["Rename the reset helper"]);
    // The scout's round has filed nothing: they don't count toward its cap.
    expect(loop().scout.round?.filed ?? 0).toBe(0);
  });

  it("links a follow-up that matches an open issue and drops a repeat of a held one", async () => {
    darkFactory();
    const open = env.gh.openIssue({
      projectId: env.project.id,
      title: "  DEBOUNCE the counter's save ",
      author: "octocat",
    });
    const { id } = await mergeWith([
      ...FOLLOW_UPS,
      { title: "rename the counter's  reset helper", severity: "medium" },
    ]);
    const followUps = s.item(id).followUps;
    expect(followUps[1]?.issue?.number).toBe(open.number);
    expect(followUps[3]?.dropped?.reason).toBe("duplicate");
    expect((await held()).map((h) => h.title)).toEqual([
      "Rename the counter's reset helper",
      "Document the counter shortcut",
    ]);
    expect(followUpIssues()).toHaveLength(0);
    // An issue opened later with a held one's title takes it off the list on the next tick.
    env.gh.openIssue({
      projectId: env.project.id,
      title: "Document the counter shortcut",
      author: "octocat",
    });
    await s.tick();
    expect((await held()).map((h) => h.title)).toEqual(["Rename the counter's reset helper"]);
  });

  it("drops held follow-ups after 14 days and past the cap, oldest low ones first", async () => {
    darkFactory(0);
    const now = Date.now();
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    // 52 held within 14 days (the oldest two low), and one held 15 days ago.
    const lows = heldItem(1, [
      { heldAt: ago(13), severity: "low" },
      { heldAt: ago(12), severity: "low" },
      { heldAt: ago(11), severity: "low" },
    ]);
    const old = heldItem(2, [{ heldAt: ago(15), severity: "medium" }]);
    const mediums = heldItem(
      3,
      Array.from({ length: 49 }, (_, n) => ({ heldAt: ago(13.5 - n / 10), severity: "medium" })),
    );
    await s.tick();
    expect(s.item(old.id).followUps[0]?.dropped?.reason).toBe("expired");
    expect(s.item(lows.id).followUps.map((f) => f.dropped?.reason ?? null)).toEqual([
      "capped",
      "capped",
      null,
    ]);
    expect(s.item(mediums.id).followUps.every((f) => !f.dropped)).toBe(true);
    expect(await held()).toHaveLength(50);
    // The daily digest says how many were dropped.
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.followUps).toMatchObject({ dropped: 3, waiting: 50 });
    expect(digest.text).toContain("3 dropped");
    expect(digest.text).toContain("50 held now");
  });

  it("files a held follow-up with File now and drops one with Dismiss", async () => {
    darkFactory();
    const { id } = await mergeWith(FOLLOW_UPS);
    const filed = await env.factory.fileFollowUp(env.project.id, id, 0);
    expect(filed.followUps[0]?.issue?.number).toBe(followUpIssues()[0]?.number);
    const dismissed = await env.factory.dismissFollowUp(env.project.id, id, 2);
    expect(dismissed.followUps[2]?.dropped?.reason).toBe("dismissed");
    expect(dismissed.followUps[2]?.issue).toBeNull();
    expect((await held()).map((h) => h.title)).toEqual(["Debounce the counter's save"]);
    expect(
      await code(() => env.factory.dismissFollowUp(env.project.id, id, 0)),
      "a filed follow-up can't be dismissed",
    ).toBe("follow_up_filed");
    expect(await code(() => env.factory.dismissFollowUp(env.project.id, id, 9))).toBe(
      "no_follow_up",
    );
    // The digest counts what the day held, filed and dismissed.
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.followUps).toMatchObject({ held: 3, filed: 1, dismissed: 1, waiting: 1 });
  });

  it("leaves a software factory's follow-ups on the item for File issue", async () => {
    env = createFactoryEnv({ limits: { maxConcurrentSessions: 4 } });
    s.enable("software_factory", { tuning: { minBacklog: 2 } });
    const { id } = await mergeWith(FOLLOW_UPS);
    expect(s.item(id).followUps.map((f) => [f.issue, f.heldAt])).toEqual([
      [null, undefined],
      [null, undefined],
      [null, undefined],
    ]);
    expect(followUpIssues()).toHaveLength(0);
    const filed = await env.factory.fileFollowUp(env.project.id, id, 1);
    expect(filed.followUps[1]?.issue?.number).toBe(followUpIssues()[0]?.number);
    // The digest counts the filed one; nothing is held for a scout in a software factory (#485).
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.followUps).toMatchObject({ held: 0, filed: 1, waiting: 0 });
    expect(digest.text).toContain("Review follow-ups: 1 filed.");
    expect(digest.text).not.toContain("held");
  });

  it("files each follow-up at once in a dark factory whose scout runs no rounds", async () => {
    darkFactory(0);
    const { id } = await mergeWith(FOLLOW_UPS);
    expect(followUpIssues().map((i) => i.title)).toEqual(FOLLOW_UPS.map((f) => f.title));
    expect(s.item(id).followUps.every((f) => f.issue && !f.heldAt)).toBe(true);
    expect(await held()).toEqual([]);
    // Nothing waits for the scout, so the digest doesn't mention holding (#485).
    const digest = await env.factory.digestNow(env.project.id);
    expect(digest.text).toContain("Review follow-ups: 3 filed.");
    expect(digest.text).not.toContain("held");
  });
});
