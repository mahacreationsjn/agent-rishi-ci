import { describe, expect, it } from "vitest";
import {
  AGENT_RISHI_CREDENTIAL_FILES,
  AGENT_RISHI_MCP_CONFIG_DIR,
  AutonomyLevel,
  INVALID_COPY_SUFFIX,
  ProviderCapabilities,
  SessionOptions,
} from "../src";

describe("permission levels (§11.2)", () => {
  it("adds read_only below the existing levels, keeping the old ones valid", () => {
    expect(AutonomyLevel.options).toEqual(["read_only", "supervised", "auto", "full"]);
    for (const level of AutonomyLevel.options) {
      expect(AutonomyLevel.parse(JSON.parse(JSON.stringify(level)))).toBe(level);
    }
    expect(AutonomyLevel.safeParse("readonly").success).toBe(false);
  });

  it("round-trips session options at read_only", () => {
    const opts = SessionOptions.parse({
      sessionId: "s1",
      role: "agent",
      cwd: "/repo",
      autonomy: "read_only",
    });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
  });

  it("round-trips the session's own branch, and leaves it out by default", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "auto" } as const;
    expect(SessionOptions.parse(base).ownBranch).toBeUndefined();
    const opts = SessionOptions.parse({ ...base, ownBranch: "agent-rishi/fix-login-ab12" });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
    expect(opts.ownBranch).toBe("agent-rishi/fix-login-ab12");
    expect(SessionOptions.safeParse({ ...base, ownBranch: "" }).success).toBe(false);
  });

  it("round-trips Agent Rishi's home for the credential-file rule, and leaves it out by default", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "full" } as const;
    expect(SessionOptions.parse(base).agentRishiHome).toBeUndefined();
    const opts = SessionOptions.parse({ ...base, agentRishiHome: "/home/me/.agent-rishi" });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
    expect(opts.agentRishiHome).toBe("/home/me/.agent-rishi");
    expect(SessionOptions.safeParse({ ...base, agentRishiHome: "" }).success).toBe(false);
    expect(AGENT_RISHI_CREDENTIAL_FILES).toEqual([
      "install-token",
      "runner/runner.json",
      "remote-access.json",
    ]);
    // Copies of a damaged file are named with it; the policy guards credential copies by it.
    expect(INVALID_COPY_SUFFIX).toBe(".invalid-");
    // Sessions' MCP configs (bearer tokens) sit in the runner's own folder, guarded as a whole.
    expect(AGENT_RISHI_MCP_CONFIG_DIR).toBe("runner/mcp");
  });

  it("round-trips the session's own artifacts folder, and leaves it out by default", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/repo", autonomy: "auto" } as const;
    expect(SessionOptions.parse(base).artifactsDir).toBeUndefined();
    const opts = SessionOptions.parse({
      ...base,
      artifactsDir: "/home/me/.agent-rishi/artifacts/s1",
    });
    expect(SessionOptions.parse(JSON.parse(JSON.stringify(opts)))).toEqual(opts);
    expect(opts.artifactsDir).toBe("/home/me/.agent-rishi/artifacts/s1");
    expect(SessionOptions.safeParse({ ...base, artifactsDir: "" }).success).toBe(false);
  });

  it("treats the readOnly capability as optional", () => {
    const caps = {
      resume: true,
      steer: false,
      interrupt: true,
      approvals: true,
      userQuestions: false,
      subagents: false,
      rollback: false,
      fork: false,
      images: false,
      planMode: false,
      reasoningEffort: false,
      mcp: true,
      skills: false,
    };
    expect(ProviderCapabilities.parse(caps).readOnly).toBeUndefined();
    const withFlag = ProviderCapabilities.parse({ ...caps, readOnly: true });
    expect(ProviderCapabilities.parse(JSON.parse(JSON.stringify(withFlag)))).toEqual(withFlag);
  });
});
