import type {
  FactoryLoop,
  FactoryTuningPatch,
  ModelInfo,
  Session,
  WorkType,
} from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { modelMatches } from "../src/services/factory/agent-choice";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Model routing (#384): docs builds and the scout with its area reviewers run on a provider and
 * model of their own, so simple work can go to a cheaper model than feature and bug builds.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, backlogItem } = factorySteps(() => env);

const loop = () => env.factory.data.loopOrNew(env.project.id);
const session = (id: string | null | undefined): Session => env.repo.get(id as string);
const builderOf = (id: string) => session(item(id).builderSessionId);
const minutesAgo = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** Let the background provider detection the first tick started finish. */
const settle = () => new Promise((r) => setImmediate(r));

/** An item of `type` (null: not classified, as items from before 0.6), waiting for an agent. */
const queued = (type: WorkType | null, title: string, issue: number) =>
  env.factory.data.createItem({
    projectId: env.project.id,
    workKey: `issue:${issue}`,
    title,
    summary: `${title}, as users asked`,
    source: "issue",
    stage: "backlog",
    type,
    score: null,
    acceptanceCriteria: [`${title} is done`],
    issue: { number: issue, url: `https://github.com/acme/app/issues/${issue}`, title },
  });
const docsItem = (title = "Document the counter", issue = 4) => queued("docs", title, issue);

const BUILDERS = { builderProvider: "claude", builderModel: "claude-opus-5-5" } as const;

describe("factory model routing: docs builds (#384)", () => {
  it("builds docs on the docs builder's provider and model, features and bugs on the builder's", async () => {
    env = createFactoryEnv({
      providers: ["claude", "codex"],
      limits: { maxConcurrentSessions: 4 },
    });
    await enable("software_factory", {
      tuning: { ...BUILDERS, docsBuilderProvider: "codex", docsBuilderModel: "gpt-5.5-mini" },
    });
    const feature = backlogItem("Add a counter", 3);
    const docs = docsItem();
    const bug = queued("bug", "Fix the timer", 5);
    const untyped = queued(null, "Add a stopwatch", 6);
    await tick();
    expect(item(docs.id).stage).toBe("building");
    expect(builderOf(docs.id)).toMatchObject({ provider: "codex", model: "gpt-5.5-mini" });
    expect(item(docs.id).builderProvider).toBe("codex");
    for (const id of [feature.id, bug.id, untyped.id]) {
      expect(item(id).stage).toBe("building");
      expect(builderOf(id)).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    }
  });

  it("builds docs like everything else until a docs builder is chosen", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable("software_factory", { tuning: BUILDERS });
    const docs = docsItem();
    await tick();
    expect(builderOf(docs.id)).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
  });

  it("starts docs on another available provider when the docs builder's isn't, or waits", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    env.detected.codex = { loggedIn: false };
    await enable("software_factory", {
      tuning: { ...BUILDERS, docsBuilderProvider: "codex", docsBuilderModel: "gpt-5.5-mini" },
    });
    await tick();
    await settle();
    const docs = docsItem();
    await tick();
    // The fallback runs on its provider's default model, never the docs model of another provider.
    expect(builderOf(docs.id)).toMatchObject({ provider: "claude", model: null });

    env.detected.claude = { loggedIn: false };
    env.factory.ctx.sessions.recheckProviders();
    await settle();
    const later = docsItem("Document the timer", 7);
    await tick();
    expect(item(later.id).stage).toBe("backlog");
    expect(item(later.id).note).toMatch(/^Waiting: no build provider available/);
  });
});

/** The dark factory with its scout's own provider and model (the scout starts on the first tick). */
async function darkFactory(tuning: FactoryTuningPatch) {
  env = createFactoryEnv({ providers: ["claude", "codex"], limits: { maxConcurrentSessions: 3 } });
  await env.factory.setMode(env.project.id, {
    mode: "dark_factory",
    limits: { ...env.project.factoryLimits, maxConcurrentSessions: 3 },
    tuning: { discoveryPerRound: 2, maxIssuesPerRound: 1, ...BUILDERS, ...tuning },
  });
}

/** Run the current round to its end with a `ux` area reviewer; returns the scout and reviewer. */
async function roundWithUxReviewer(): Promise<{ scout: Session; lens: Session }> {
  await tick();
  const scout = session(loop().scout.sessionId);
  await env.factory.planRound(scout, { lenses: [{ area: "ux", focus: "forms" }] });
  await tick();
  const lens = session(loop().scout.lensSessions.ux);
  await env.factory.reportFindings(lens, []);
  await env.setStatus(lens.id, "idle");
  await tick();
  await env.setStatus(scout.id, "idle");
  await tick();
  expect(loop().scout.round).toBeNull();
  return { scout, lens };
}

/** Change the loop record (tuning, the scout's state), as saving settings or time would. */
function saveLoop(change: (l: FactoryLoop) => Partial<FactoryLoop>): void {
  const l = loop();
  env.factory.data.saveLoop({ ...l, ...change(l) });
}

describe("factory model routing: the scout and its area reviewers (#384)", () => {
  it("starts the scout and its area reviewers on the scout's provider and model", async () => {
    await darkFactory({ scoutProvider: "codex", scoutModel: "gpt-5.5-mini" });
    const { scout, lens } = await roundWithUxReviewer();
    for (const s of [scout, lens]) {
      expect(s).toMatchObject({ provider: "codex", model: "gpt-5.5-mini" });
    }
    const starts = env.starts.filter((s) => s.workKey?.startsWith("factory:"));
    expect(starts.map((s) => [s.workKey, s.provider, s.model])).toEqual([
      ["factory:scout", "codex", "gpt-5.5-mini"],
      ["factory:lens:ux", "codex", "gpt-5.5-mini"],
    ]);
  });

  it("replaces long-lived sessions on another provider or model at their next round", async () => {
    await darkFactory({});
    const first = await roundWithUxReviewer();
    // Automatic: the scout runs where the session service puts it, and is reused as before.
    expect(first.scout.provider).toBe("claude");

    saveLoop((l) => ({
      tuning: { ...l.tuning, scoutProvider: "codex", scoutModel: "gpt-5.5-mini" },
      scout: { ...l.scout, lastRoundAt: minutesAgo(7 * 60) },
    }));
    const second = await roundWithUxReviewer();
    expect(second.scout.id).not.toBe(first.scout.id);
    expect(second.lens.id).not.toBe(first.lens.id);
    for (const s of [second.scout, second.lens]) {
      expect(s).toMatchObject({ provider: "codex", model: "gpt-5.5-mini" });
    }
    // The replaced sessions are archived (their worktrees go); the new ones get the first brief.
    expect(env.archived).toEqual(expect.arrayContaining([first.scout.id, first.lens.id]));
    expect(session(first.scout.id).archivedAt).not.toBeNull();
    expect(
      env.starts.find((s) => s.workKey === "factory:scout" && s.provider === "codex"),
    ).toBeTruthy();

    // Sessions that match are reused round after round.
    saveLoop((l) => ({ scout: { ...l.scout, lastRoundAt: minutesAgo(7 * 60) } }));
    const third = await roundWithUxReviewer();
    expect(third.scout.id).toBe(second.scout.id);
    expect(third.lens.id).toBe(second.lens.id);
  });

  it("keeps reusing the scout's sessions on Automatic", async () => {
    await darkFactory({});
    const first = await roundWithUxReviewer();
    saveLoop((l) => ({ scout: { ...l.scout, lastRoundAt: minutesAgo(7 * 60) } }));
    const second = await roundWithUxReviewer();
    expect(second.scout.id).toBe(first.scout.id);
    expect(second.lens.id).toBe(first.lens.id);
    expect(env.archived).toEqual([]);
  });

  it.each([
    ["with the full id it runs", { id: "haiku", label: "Haiku", resolvedId: "claude-haiku-5-5" }],
    ["before the model list says what it runs", { id: "haiku", label: "Haiku" }],
  ])("reuses sessions on an alias once they report its full id (%s)", async (_, haiku) => {
    // Claude Code lists `haiku`; a session started on it reports `claude-haiku-5-5` once the CLI
    // starts, and the session's model becomes that.
    await darkFactory({ scoutProvider: "claude", scoutModel: "haiku" });
    env.models.claude = [
      { id: "default", label: "Default", isDefault: true, efforts: [] },
      { id: "opus", label: "Opus", resolvedId: "claude-opus-5-5", efforts: [] },
      { ...haiku, efforts: [] },
    ];
    const first = await roundWithUxReviewer();
    for (const s of [first.scout, first.lens]) {
      expect(s.model).toBe("haiku");
      env.repo.update(s.id, (cur) => ({ ...cur, model: "claude-haiku-5-5" }));
    }
    saveLoop((l) => ({ scout: { ...l.scout, lastRoundAt: minutesAgo(7 * 60) } }));
    const second = await roundWithUxReviewer();
    expect(second.scout.id).toBe(first.scout.id);
    expect(second.lens.id).toBe(first.lens.id);
    expect(env.archived).toEqual([]);
  });

  it("uses a busy session once more instead of leaving it running unarchived", async () => {
    await darkFactory({});
    const first = await roundWithUxReviewer();
    saveLoop((l) => ({
      tuning: { ...l.tuning, scoutProvider: "codex", scoutModel: "gpt-5.5-mini" },
      scout: { ...l.scout, lastRoundAt: minutesAgo(7 * 60) },
    }));
    // A person messaged the scout: it is in a turn when the round starts.
    await env.setStatus(first.scout.id, "running");
    await tick();
    expect(loop().scout.sessionId).toBe(first.scout.id);
    expect(env.archived).toEqual([]);
  });
});

describe("modelMatches (#384)", () => {
  const claude: ModelInfo[] = [
    { id: "default", label: "Default", isDefault: true, efforts: [] },
    { id: "opus", label: "Opus", resolvedId: "claude-opus-5-5", efforts: [] },
    { id: "sonnet", label: "Sonnet 4.6", efforts: [] },
    { id: "haiku", label: "Haiku", efforts: [] },
  ];

  it("matches the chosen id, the full id an alias runs, and the provider's default", () => {
    expect(modelMatches([], "gpt-5.5-mini", "gpt-5.5-mini")).toBe(true);
    expect(modelMatches(claude, "opus", "claude-opus-5-5")).toBe(true);
    // A versioned label the full id ends with, as the model picker matches it.
    expect(modelMatches(claude, "sonnet", "claude-sonnet-4-6")).toBe(true);
    // An alias without a version, named as a word of the full id.
    expect(modelMatches(claude, "haiku", "claude-haiku-5-5")).toBe(true);
    expect(modelMatches(claude, "default", "claude-opus-5-5")).toBe(true);
  });

  it("tells another model apart", () => {
    expect(modelMatches(claude, "opus", "claude-haiku-5-5")).toBe(false);
    // The alias now runs a newer model than the session.
    expect(modelMatches(claude, "opus", "claude-opus-4-1")).toBe(false);
    expect(modelMatches(claude, "haiku", "claude-sonnet-4-6")).toBe(false);
    expect(modelMatches(claude, "haiku", null)).toBe(false);
    // A versioned id is never matched by its words: `gpt-5.5` is not `gpt-5.5-mini`.
    expect(modelMatches([], "gpt-5.5", "gpt-5.5-mini")).toBe(false);
  });
});
