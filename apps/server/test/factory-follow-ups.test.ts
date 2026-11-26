import { FOLLOW_UP_LABEL } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { factorySubmitReview } from "../src/mcp/tools/factory/builder";
import { FACTORY_LABEL } from "../src/services/factory/intake";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { APPROVE, factorySteps } from "./support/factory-steps";

/**
 * Non-blocking review follow-ups (#339). `security.concerns` blocks the merge, so an approval
 * can't carry one: the reviewer puts what can wait in `followUps`, which never start a revise
 * round. Once the pull request merges, the dark factory files them as issues; the software
 * factory lists them on the item to file with "File issue".
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

/** The reviewer's `factory_submit_review` call, through the MCP tool over the real factory. */
function submit(id: string, args: Record<string, unknown>) {
  const services = { sessionRepo: env.repo, factory: env.factory };
  const registry = new ToolRegistry([factorySubmitReview], services as never);
  return registry.call("factory_submit_review", args, {
    role: "agent",
    sessionId: s.item(id).reviewerSessionId as string,
    projectId: env.project.id,
    caller: "mcp",
    signal: new AbortController().signal,
  });
}

/** The non-blocking finding the reviewer of PR #331 approved with, three times. */
const NOTE = "Archiving deletes unpushed commits in a container; fix before phase 4b";
const FOLLOW_UPS = [
  { title: NOTE, severity: "medium", area: "runner" },
  { title: "Document the container backend's limits" },
];

const toBuilder = (builder: string) => env.messages.filter((m) => m.sessionId === builder);
const filedAs = (title: string) => env.gh.issues.filter((i) => i.title === title);

describe("review follow-ups (#339)", () => {
  it("merges an approval with follow-ups, then files each follow-up as an issue once", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory");
    const { id, pr, builder } = await s.verifying();
    const res = await submit(id, { ...APPROVE, followUps: FOLLOW_UPS });
    expect(res.isError, res.text).toBe(false);
    await s.tick();
    expect(s.item(id).checks.find((c) => c.name === "security")?.state).toBe("pass");
    expect(s.item(id).stage).toBe("watching");
    expect(env.gh.merges.map((m) => m.number)).toEqual([pr.ref.number]);
    // The builder was never asked to fix a follow-up.
    expect(toBuilder(builder)).toHaveLength(0);
    await s.tick();
    await s.tick();
    const [filed] = filedAs(NOTE);
    expect(filedAs(NOTE)).toHaveLength(1);
    expect(filed?.body).toContain(pr.ref.url);
    expect(filed?.body).toContain("Severity: medium · Area: runner");
    expect(filed?.labels).toEqual(expect.arrayContaining([FACTORY_LABEL, FOLLOW_UP_LABEL]));
    // Filed with the factory's label, the dark factory takes it on as new work.
    const workKeys = env.factory.data.items(env.project.id).map((i) => i.workKey);
    expect(workKeys).toContain(`issue:${filed?.number}`);
    expect(filedAs(FOLLOW_UPS[1]?.title as string)).toHaveLength(1);
    expect(s.item(id).followUps.map((f) => f.issue?.number)).toEqual(
      FOLLOW_UPS.map((f) => filedAs(f.title)[0]?.number),
    );
    expect(s.item(id).nudges).not.toHaveProperty("follow_ups_due");
    // Filed once: later ticks and a restart file nothing again.
    env.restart();
    await s.tick();
    expect(env.gh.issues.filter((i) => i.labels.includes(FOLLOW_UP_LABEL))).toHaveLength(2);
  });

  it("links a follow-up to the open issue with the same title instead of filing it again", async () => {
    env = createFactoryEnv();
    s.enable("dark_factory");
    const open = env.gh.openIssue({
      projectId: env.project.id,
      title: `  ${NOTE.toUpperCase()} `,
      author: "octocat",
    });
    const { id } = await s.verifying();
    await submit(id, { ...APPROVE, followUps: [FOLLOW_UPS[0]] });
    await s.tick();
    await s.tick();
    expect(s.item(id).followUps[0]?.issue?.number).toBe(open.number);
    expect(env.gh.issues.filter((i) => i.labels.includes(FOLLOW_UP_LABEL))).toHaveLength(0);
  });

  it("lists follow-ups in the software factory for a person to file with File issue", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id } = await s.verifying();
    await submit(id, { ...APPROVE, followUps: FOLLOW_UPS });
    await s.tick();
    await s.tick();
    expect(s.item(id).stage).not.toBe("verifying");
    expect(s.item(id).followUps.map((f) => [f.title, f.issue])).toEqual([
      [NOTE, null],
      [FOLLOW_UPS[1]?.title, null],
    ]);
    expect(filedAs(NOTE)).toHaveLength(0);
    const filed = await env.factory.fileFollowUp(env.project.id, id, 0);
    expect(filed.followUps[0]?.issue?.number).toBe(filedAs(NOTE)[0]?.number);
    expect(filed.followUps[1]?.issue).toBeNull();
    // Clicking again files nothing new.
    await env.factory.fileFollowUp(env.project.id, id, 0);
    expect(filedAs(NOTE)).toHaveLength(1);
    await expect(env.factory.fileFollowUp(env.project.id, id, 5)).rejects.toMatchObject({
      code: "no_follow_up",
    });
  });

  it("refuses an approval with security concerns: they block the merge", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id, builder } = await s.verifying();
    const res = await submit(id, { ...APPROVE, security: { concerns: [NOTE] } });
    expect.soft(res.isError, "factory_submit_review accepted it").toBe(true);
    expect.soft(res.text).toMatch(/request_changes/);
    expect.soft(res.text).toMatch(/followUps/);
    // Nothing was recorded, so the approval doesn't become a failed check and a revise round
    // in which the builder is asked to fix what the reviewer said doesn't block.
    await s.tick();
    expect.soft(s.item(id)).toMatchObject({ stage: "verifying", attempts: 0, review: null });
    expect(toBuilder(builder).map((m) => m.text)).toEqual([]);
    // The reviewer moves it to the follow-ups and approves: it merges.
    const again = await submit(id, { ...APPROVE, followUps: [{ title: NOTE }] });
    expect(again.isError, again.text).toBe(false);
    await s.tick();
    expect(s.item(id).stage).toBe("watching");
  });

  it("still sends request_changes with security concerns to a revise round", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id, builder } = await s.verifying();
    const res = await submit(id, {
      ...APPROVE,
      verdict: "request_changes",
      summary: "Builds the query from user input",
      security: { concerns: ["SQL injection in query()"] },
      followUps: [{ title: "Add a query builder" }],
    });
    expect(res.isError, res.text).toBe(false);
    await s.tick();
    expect(s.item(id)).toMatchObject({ stage: "building", attempts: 1 });
    const revise = s.lastMessageTo(builder);
    expect(revise).toContain("- security: Reviewer: SQL injection in query()");
    // Follow-ups are never part of a revise round.
    expect(revise).not.toContain("query builder");
  });

  it("caps the follow-ups of one verdict", async () => {
    env = createFactoryEnv();
    s.enable();
    const { id } = await s.verifying();
    const many = Array.from({ length: 6 }, (_, n) => ({ title: `Follow-up ${n}` }));
    const res = await submit(id, { ...APPROVE, followUps: many });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/followUps/);
  });
});
