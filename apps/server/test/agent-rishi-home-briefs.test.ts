import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentPrompt, type PromptSession } from "../src/mcp/prompt";
import { builderPrompt, reviewerPrompt } from "../src/services/factory/prompts";
import { lensPrompt, scoutPlanPrompt } from "../src/services/factory/prompts-scout";
import { rolePrompt } from "../src/services/orchestration/prompts";
import { UNSET_ADVICE } from "./support/unset-advice";

/**
 * Agents are told plainly to keep out of Agent Rishi's own home and database (#320): Agent Rishi state
 * reaches them through the Agent Rishi MCP tools. The classifier asks when they try anyway
 * (`packages/providers/test/agent-rishi-home-reads.test.ts`). No brief names the home's path.
 */
const RULE =
  "Never read or list Agent Rishi's own home or database; use the Agent Rishi MCP tools for Agent Rishi state.";

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: "i1",
    source: "issue",
    area: null,
    type: "bug",
    title: "Crash on save",
    summary: "Saving an empty task crashes.",
    acceptanceCriteria: ["Saving an empty task works"],
    issue: { number: 7, url: "https://github.com/acme/app/issues/7", title: "Crash on save" },
    investigation: null,
    pr: { number: 9, url: "https://github.com/acme/app/pull/9", state: "open" },
    ...over,
  }) as never;

const agent: PromptSession = {
  role: "agent",
  startedBy: { kind: "pm", id: "pm-1" },
  worktreePath: "/home/me/.agent-rishi/wt/shop/abcd1234",
  autonomy: "auto",
};

/** Every brief a factory role, a PM, the orchestrator or an agent session starts from. */
function briefs(): Record<string, string> {
  return {
    "builder (bug)": builderPrompt(item(), "v"),
    "builder (feature)": builderPrompt(item({ type: "feature" }), "v"),
    "builder (docs)": builderPrompt(item({ type: "docs" }), "v"),
    reviewer: reviewerPrompt(item(), "v", null, null, false),
    "reviewer (local)": reviewerPrompt(item(), "v", null, "main", true),
    scout: scoutPlanPrompt({
      round: 1,
      vision: "v",
      defaultBranch: "main",
      areas: ["performance"],
      maxLenses: 1,
      maxIssues: 3,
      known: [],
      firstRound: true,
    }),
    "area reviewer": lensPrompt({
      area: "performance",
      focus: "the event log",
      vision: "v",
      defaultBranch: "main",
      known: [],
      firstRun: true,
    }),
    pm: rolePrompt("pm"),
    orchestrator: rolePrompt("orchestrator"),
    agent: agentPrompt(agent, { kind: "github" }),
  };
}

describe("Agent Rishi's internal variables in the briefs (#422)", () => {
  it("no brief tells agents to unset them", () => {
    const fix = builderPrompt(
      item({ investigation: { kind: "reproduction", outcome: "reproduced", summary: "s" } }),
      "v",
    );
    for (const [role, text] of Object.entries({ ...briefs(), "builder (fix)": fix })) {
      expect(text, role).not.toMatch(UNSET_ADVICE);
    }
  });

  it("nor does the repository's agent guide", () => {
    const guide = readFileSync(
      fileURLToPath(new URL("../../../AGENTS.md", import.meta.url)),
      "utf8",
    );
    expect(guide).not.toMatch(UNSET_ADVICE);
  });
});

describe("Agent Rishi's home in the briefs (#320)", () => {
  it("every role's brief states the rule", () => {
    for (const [role, text] of Object.entries(briefs())) {
      expect(text, role).toContain(RULE);
    }
  });

  it("no brief names the home's path or its variable", () => {
    for (const [role, text] of Object.entries(briefs())) {
      expect(text, role).not.toContain("AGENT_RISHI_HOME");
      expect(text, role).not.toMatch(/[~/\\]\.agent-rishi\b/);
    }
  });
});
