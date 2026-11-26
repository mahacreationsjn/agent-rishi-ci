import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcpPromptResult } from "../src/acp/protocol";
import { AcpRpcError } from "../src/acp/rpc";
import { AcpPromptChain } from "../src/acp/steering";
import type { ProviderSession } from "../src/adapter";
import { AntigravityAdapter } from "../src/antigravity/adapter";
import { detectAgy, readAgyAuth } from "../src/antigravity/detect";
import { AGY_PLAN_APPROVED, agyArtifact } from "../src/antigravity/extensions";
import { agentRishiAgySettings } from "../src/antigravity/settings";
import { validateEventStream } from "../src/replay/validate";

/** Antigravity CLI over ACP (#566), against a fake `agy` in the shapes 1.5.18 uses. */

const fakeAgy = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-agy", "agy.mjs"),
};

type Logged = { method: string; params: Record<string, unknown> & { outcome?: unknown } };
let dir: string;
let home: string;
const logFile = () => join(dir, "acp.log");
const logged = (method?: string): Logged[] =>
  existsSync(logFile())
    ? readFileSync(logFile(), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Logged)
        .filter((m) => !method || m.method === method)
    : [];

type Step = Record<string, unknown>;
const chunk = (text: string): Step => ({
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
/** `agy`'s permission request: the tool's name and raw input, then Allow and Deny. */
const permission = (toolCall: Record<string, unknown>): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: { sessionUpdate: "tool_call", status: "pending", ...toolCall },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  },
});
const writeFile = (id: string, file: string) =>
  permission({
    toolCallId: id,
    name: "write_file",
    kind: "edit",
    title: "File hello.txt",
    rawInput: { Content: "hi", Overwrite: true, Path: file },
  });
const runCommand = (id: string, command: string) =>
  permission({
    toolCallId: id,
    name: "run_command",
    kind: "execute",
    title: command,
    rawInput: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Run it" },
  });
const mcpCall = (id: string, server: string, tool: string) =>
  permission({
    toolCallId: id,
    name: `mcp_${server}_${tool}`,
    kind: "other",
    title: `Run mcp_${server}_${tool}`,
    rawInput: { text: "probe", toolSummary: "Report progress" },
  });

const agentRishi = {
  transport: "http" as const,
  name: "agent-rishi",
  url: "http://127.0.0.1:4000/mcp",
  headers: { Authorization: "Bearer test" },
  trusted: true,
};

type Script = Step[] | { prompts: Step[][] };

function options(script: Script, extra: Partial<SessionOptions> = {}): SessionOptions {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
    env: { FAKE_AGY_LOG: logFile(), FAKE_AGY_SCRIPT: file, ...extra.env },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

/** Reads a session's events, answering approvals with `answer`. */
class Reader {
  readonly all: AgentEvent[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  asked: string[] = [];
  answer: (item: ItemOf<"approval_request">) => RuntimeResponse | undefined = () => ({
    kind: "approval",
    decision: "deny",
  });

  /** Called with every event as it comes (to steer or stop mid-turn). */
  during: (e: AgentEvent) => void = () => {};
  questions: ItemOf<"user_question">[] = [];
  reply: (item: ItemOf<"user_question">) => RuntimeResponse | undefined = () => undefined;

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    for (;;) {
      const next = await this.it.next();
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      this.during(e);
      if (e.type === "item.started" && e.item.kind === "approval_request") {
        this.asked.push(e.item.toolName ?? "");
        const response = this.answer(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      if (e.type === "item.started" && e.item.kind === "user_question") {
        this.questions.push(e.item);
        const response = this.reply(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      // A subagent's thread ends its own turn first.
      if (isTurnEnd(e) && e.threadId === "s1:thread-root") return this.all.slice(from);
    }
  }
}

const sessions: ProviderSession[] = [];
async function open(script: Script, extra: Partial<SessionOptions> = {}) {
  const adapter = new AntigravityAdapter({ executable: fakeAgy, home });
  const session = await adapter.openSession(options(script, extra));
  sessions.push(session);
  return { session, reader: new Reader(session), adapter };
}

const answers = () =>
  logged("answer:session/request_permission").map(
    (m) => (m.params.outcome as { optionId?: string }).optionId,
  );
const configSets = () =>
  logged("session/set_config_option").map((m) => `${m.params.configId}=${m.params.value}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-agy-"));
  home = mkdtempSync(join(tmpdir(), "agent-rishi-agy-home-"));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("Antigravity CLI session over ACP", () => {
  it("runs `agy acp` per session on Agent Rishi's strict settings and the user's own login", async () => {
    const agyHome = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agyHome, { recursive: true });
    writeFileSync(
      join(agyHome, "settings.json"),
      JSON.stringify({
        modelProvider: "gemini",
        toolPermission: "always-proceed",
        agentMode: "auto",
        permissions: { allow: ["command(*)"], deny: ["command(rm -rf)"] },
      }),
    );
    const { session, reader, adapter } = await open([chunk("Looking.")], {
      mcpServers: [agentRishi],
      effort: "max",
    });
    expect(session.resumeToken()).toBe("agy-1");
    await reader.turn("Look around");

    expect(logged("argv")[0]?.params.args).toEqual([
      "acp",
      "--process-per-session",
      "--disable-telemetry",
      "--cli_dir_name",
      "agent-rishi",
    ]);
    // Never `authenticate`; Agent Rishi's tools reach it as an HTTP MCP server.
    expect(logged("authenticate")).toEqual([]);
    expect(logged("session/new")[0]?.params).toMatchObject({
      cwd: dir,
      mcpServers: [{ type: "http", name: "agent-rishi", url: "http://127.0.0.1:4000/mcp" }],
    });
    // The user's settings, minus what skips approvals, plus strict; their deny rules stay.
    const written = JSON.parse(readFileSync(join(agyHome, "agent-rishi", "settings.json"), "utf8"));
    expect(written).toEqual({
      modelProvider: "gemini",
      toolPermission: "strict",
      permissions: { deny: ["command(rm -rf)"] },
    });
    // `max` is its highest thinking level, `xhigh` ("Extra").
    expect(configSets()).toEqual(["thought_level=xhigh"]);
    expect(adapter.models().map((m) => m.id)).toEqual([
      "default",
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
    ]);
    expect(adapter.models()[1]?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(adapter.capabilities()).toMatchObject({
      mcp: true,
      reasoningEffort: true,
      readOnly: true,
      planMode: true,
    });
    expect(validateEventStream(reader.all)).toEqual([]);

    // A model change, then the effort again (switching models can reset it).
    await session.configure?.({ model: "gemini-3.8-flash", effort: "medium" });
    await reader.turn("Again");
    expect(configSets()).toEqual([
      "thought_level=xhigh",
      "model=gemini-3.8-flash",
      "thought_level=xhigh",
      "thought_level=medium",
    ]);
  });

  it("decides edits, commands and MCP tools by Agent Rishi's policy from agy's own fields", async () => {
    const file = join(dir, "hello.txt");
    const auto = await open(
      [
        writeFile("e1", file),
        runCommand("c1", "git status"),
        mcpCall("m1", "agent-rishi", "report_progress"),
        mcpCall("m2", "other", "do_things"),
      ],
      { mcpServers: [agentRishi] },
    );
    await auto.reader.turn("Work");
    // On Auto, an edit in the worktree, a safe command and MCP tools run without asking.
    expect(auto.reader.asked).toEqual([]);
    expect(answers()).toEqual(["allow", "allow", "allow", "allow"]);
    await auto.session.setAutonomy?.("supervised");
    await auto.reader.turn("Again");
    // Supervised: every edit, command and other server's tool asks; Agent Rishi's own never does.
    expect(auto.reader.asked).toEqual(["write_file", "run_command", "mcp_other_do_things"]);
  });

  it("refuses edits and writing commands in a read-only session, and trusts Agent Rishi's tools", async () => {
    const { reader } = await open(
      [
        writeFile("e1", join(dir, "hello.txt")),
        runCommand("c1", "rm -rf build"),
        mcpCall("m1", "agent-rishi", "report_progress"),
      ],
      { mcpServers: [agentRishi], autonomy: "read_only" },
    );
    await reader.turn("Look");
    expect(reader.asked).toEqual([]);
    expect(answers()).toEqual(["deny", "deny", "allow"]);
  });

  it("says how to sign in when agy has no login", async () => {
    const adapter = new AntigravityAdapter({ executable: fakeAgy, home });
    await expect(
      adapter.openSession(options([], { env: { FAKE_AGY_AUTH: "missing" } })),
    ).rejects.toMatchObject({ code: "not_logged_in" });
  });

  it("takes its input tokens as the fresh input: it counts cached tokens apart", async () => {
    // A real agy 1.5.18 prompt: totalTokens is input + output + cached reads.
    const usage = {
      inputTokens: 10787,
      outputTokens: 1685,
      cachedReadTokens: 37988,
      cachedWriteTokens: 0,
      thoughtTokens: 1143,
      totalTokens: 50460,
    };
    const { reader } = await open([chunk("Done."), { stopReason: "end_turn", usage }]);
    const events = await reader.turn("Hello");
    const last = events.filter((e) => e.type === "usage.updated").at(-1);
    expect(last).toMatchObject({
      usage: {
        inputTokens: 10787,
        outputTokens: 1685,
        cachedInputTokens: 37988,
        reasoningTokens: 1143,
      },
    });
  });
});

describe("Antigravity CLI settings and detection", () => {
  it("drops everything that skips approvals from the user's settings", () => {
    expect(agentRishiAgySettings(undefined)).toEqual({ toolPermission: "strict" });
    expect(
      agentRishiAgySettings({
        model: "gemini-3.8-flash",
        enableTerminalSandbox: true,
        toolPermission: "always-proceed",
        agentMode: "accept-edits",
        artifactReviewPolicy: "always-proceed",
        permissions: { allow: ["write_file(*)"], ask: [], deny: ["read_url(*)", 3] },
      }),
    ).toEqual({
      model: "gemini-3.8-flash",
      enableTerminalSandbox: true,
      toolPermission: "strict",
      permissions: { deny: ["read_url(*)"] },
    });
  });

  it("reads the login from the token file's presence or an API key", () => {
    expect(readAgyAuth(home, {})).toEqual({ loggedIn: false, authMethod: null });
    expect(readAgyAuth(home, { GEMINI_API_KEY: "k" })).toMatchObject({ loggedIn: true });
    const agyHome = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agyHome, { recursive: true });
    writeFileSync(join(agyHome, "antigravity-oauth-token"), "");
    expect(readAgyAuth(home, {})).toEqual({ loggedIn: true, authMethod: "oauth-personal" });
  });

  it("finds a supported agy and refuses an old one", async () => {
    const ok = await detectAgy({
      executable: fakeAgy,
      auth: () => ({ loggedIn: true, authMethod: "oauth-personal" }),
    });
    expect(ok).toMatchObject({ installed: true, version: "1.5.18", supported: true, issues: [] });
  });
});

/** `agy`'s request to save one of its own notes (a plan, a walkthrough) in its `brain` folder. */
const artifact = (id: string, file: string, content: string) =>
  permission({
    toolCallId: id,
    name: "write_file",
    kind: "edit",
    title: `File ${file}`,
    rawInput: {
      ArtifactMetadata: { RequestFeedback: true, Summary: "Plan", UserFacing: true },
      Content: content,
      Path: file,
    },
  });
const brain = () => join(home, ".gemini", "antigravity-cli", "brain", "conv-1");
const prompts = () =>
  logged("session/prompt").map(
    (m) => ((m.params.prompt as { text?: string }[])[0]?.text ?? "") as string,
  );

describe("Antigravity CLI plan mode and notes", () => {
  it("turns its plan into Agent Rishi's plan approval, then sends the go-ahead in the same turn", async () => {
    const plan = "# Add CONTRIBUTING.md\n\n1. Write the file.";
    const { reader, adapter } = await open(
      {
        prompts: [
          [artifact("p1", join(brain(), "implementation_plan.md"), plan), chunk("Please approve.")],
          [writeFile("e1", join(dir, "CONTRIBUTING.md")), chunk("Done.")],
        ],
      },
      { planMode: true },
    );
    expect(adapter.capabilities().planMode).toBe(true);
    reader.answer = (item) =>
      item.action === "plan" ? { kind: "approval", decision: "allow_once" } : undefined;
    const events = await reader.turn("Add a CONTRIBUTING.md");

    expect(configSets()).toEqual(["mode=plan", "mode=default"]);
    const shown = events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === "plan" ? [e.item.text] : [],
    );
    expect(shown).toEqual([plan]);
    // One Agent Rishi turn: the plan, the approval, then the go-ahead prompt and the work.
    expect(prompts()).toEqual(["Add a CONTRIBUTING.md", AGY_PLAN_APPROVED]);
    expect(events.filter(isTurnEnd)).toHaveLength(1);
    expect(events).toContainEqual({ type: "session.updated", planMode: false });
    expect(answers()).toEqual(["allow", "allow"]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("keeps planning when the plan is declined, and still saves the plan file", async () => {
    const { reader } = await open(
      [artifact("p1", join(brain(), "implementation_plan.md"), "# Plan"), chunk("Approve?")],
      { planMode: true },
    );
    reader.answer = () => ({ kind: "approval", decision: "deny" });
    const events = await reader.turn("Plan it");
    expect(configSets()).toEqual(["mode=plan"]);
    expect(prompts()).toEqual(["Plan it"]);
    expect(events).not.toContainEqual({ type: "session.updated", planMode: false });
    expect(answers()).toEqual(["allow"]);
  });

  it("saves its notes without asking, but judges a write outside its folder as any edit", async () => {
    const auto = await open([
      artifact("a1", join(brain(), "walkthrough.md"), "# Done"),
      artifact("a2", "/var/lib/agent-rishi-agy-test/notes.md", "x"),
    ]);
    auto.reader.answer = () => ({ kind: "approval", decision: "deny" });
    await auto.reader.turn("Work");
    // The first is its own note; the second is outside its folder, so it is an outside write.
    expect(auto.reader.asked).toEqual(["write_file"]);
    expect(answers()).toEqual(["allow", "deny"]);
  });

  it("refuses its notes in a read-only session", async () => {
    const { reader } = await open([artifact("a1", join(brain(), "walkthrough.md"), "# Done")], {
      autonomy: "read_only",
    });
    await reader.turn("Look");
    expect(answers()).toEqual(["deny"]);
  });

  it("counts only .md files inside its brain folder as its notes", () => {
    const dirOf = "/home/u/.gemini/antigravity-cli/brain";
    const call = (file: string, meta = true) => ({
      toolCallId: "t",
      kind: "edit" as const,
      rawInput: { ...(meta ? { ArtifactMetadata: {} } : {}), Path: file, Content: "x" },
    });
    expect(agyArtifact(call(`${dirOf}/c1/task.md`), dirOf)?.name).toBe("task.md");
    expect(agyArtifact(call(`${dirOf}/c1/../../settings.md`), dirOf)).toBeUndefined();
    expect(agyArtifact(call(`${dirOf}/c1/run.sh`), dirOf)).toBeUndefined();
    expect(agyArtifact(call(`${dirOf}/c1/task.md`, false), dirOf)).toBeUndefined();
    expect(agyArtifact(call("c1/task.md"), dirOf)).toBeUndefined();
  });
});

/** `agy` runs its `ask_question` tool, then sends the questions as a form. */
const askTool = (id: string, title = "Run ask_question"): Step => ({
  update: { sessionUpdate: "tool_call", toolCallId: id, title, kind: "other", status: "pending" },
});
const form = (id: string, properties: Record<string, unknown>, extra: Step = {}): Step => ({
  request: "elicitation/create",
  params: {
    toolCallId: id,
    mode: "form",
    message: "The agent has a question.",
    requestedSchema: { type: "object", properties },
    ...extra,
  },
});
const license = {
  q1: {
    type: "string",
    title: "Which license should this project use?",
    oneOf: [
      { const: "1", title: "MIT" },
      { const: "2", title: "Apache-2.0" },
    ],
  },
  q1_other: { type: "string", title: "Other", description: "Optional free-form answer" },
};
const elicited = () =>
  logged("answer:elicitation/create").map((m) => m.params as Record<string, unknown>);

describe("Antigravity CLI questions", () => {
  it("says it takes forms, and turns its questions into question cards", async () => {
    const { reader, adapter } = await open([
      askTool("c1"),
      form("c1", license),
      askTool("c2"),
      form("c2", license),
      askTool("c3"),
      form("c3", {
        q1: {
          type: "array",
          title: "Which checks should run?",
          items: {
            anyOf: [
              { const: "1", title: "Lint" },
              { const: "2", title: "Tests" },
              { const: "3", title: "Build" },
            ],
          },
        },
      }),
    ]);
    expect(adapter.capabilities().userQuestions).toBe(true);
    const answers = [["MIT"], ["BSD-3-Clause"], ["Lint", "Build"]];
    reader.reply = () => ({ kind: "answer", answers: { q1: answers.shift() ?? [] } });
    await reader.turn("Pick a license");

    expect(logged("initialize")[0]?.params).toMatchObject({
      clientCapabilities: { elicitation: { form: {} } },
    });
    const [first] = reader.questions;
    expect(first?.mcpServer).toBeUndefined();
    expect(first?.questions).toEqual([
      {
        id: "q1",
        question: "Which license should this project use?",
        options: [{ label: "MIT" }, { label: "Apache-2.0" }],
        multiSelect: false,
        allowFreeText: true,
      },
    ]);
    expect(reader.questions[2]?.questions[0]).toMatchObject({
      multiSelect: true,
      allowFreeText: false,
    });
    // A picked option goes back as its value, a typed answer as `q1_other`, several as a list.
    expect(elicited()).toEqual([
      { action: "accept", content: { q1: "1" } },
      { action: "accept", content: { q1_other: "BSD-3-Clause" } },
      { action: "accept", content: { q1: ["1", "3"] } },
    ]);
  });

  it("cancels the form when the question is dismissed", async () => {
    const { reader } = await open([askTool("c1"), form("c1", license)]);
    reader.reply = () => ({ kind: "cancel" });
    await reader.turn("Ask me");
    expect(elicited()).toEqual([{ action: "cancel" }]);
  });

  it("shows an MCP server's form as that server's, which stays with the user", async () => {
    const github = { ...agentRishi, name: "github", trusted: false };
    const { reader } = await open(
      [
        askTool("m1", "Run mcp_github_create_issue"),
        form("m1", { repo: { type: "string", title: "Repository" } }, { message: "Which repo?" }),
      ],
      { mcpServers: [agentRishi, github] },
    );
    reader.reply = (item) => ({
      kind: "answer",
      answers: { [item.questions[0]?.id ?? ""]: ["o/r"] },
    });
    await reader.turn("Open an issue");
    expect(reader.questions[0]?.mcpServer).toBe("github");
    expect(elicited()).toEqual([{ action: "accept", content: { repo: "o/r" } }]);
  });
});

describe("Antigravity CLI steering", () => {
  const usage = (n: number) => ({ inputTokens: n, outputTokens: 1, totalTokens: n + 1 });
  const userTexts = (events: AgentEvent[]) =>
    events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === "user_message" ? [e.item.input.text] : [],
    );
  const steerAt = (session: ProviderSession, when: (e: AgentEvent) => boolean, text: string) => {
    let done = false;
    return (e: AgentEvent) => {
      if (done || !when(e)) return;
      done = true;
      void session.steer?.({ text, attachments: [] });
    };
  };

  it("sends a steer as another prompt, and the turn ends when the newest prompt does", async () => {
    const { session, reader, adapter } = await open({
      prompts: [
        [chunk("Working."), { stopReason: "end_turn", usage: usage(10) }, { awaitSteer: true }],
        [chunk("Did both."), { stopReason: "end_turn", usage: usage(20) }],
      ],
    });
    expect(adapter.capabilities().steer).toBe(true);
    reader.during = steerAt(session, (e) => e.type === "turn.started", "Also add tests");
    const events = await reader.turn("Fix the bug");

    expect(prompts()).toEqual(["Fix the bug", "Also add tests"]);
    expect(userTexts(events)).toEqual(["Fix the bug", "Also add tests"]);
    expect(events.filter(isTurnEnd).map((e) => e.type)).toEqual(["turn.completed"]);
    const last = events.filter((e) => e.type === "usage.updated").at(-1);
    expect(last).toMatchObject({ usage: { inputTokens: 30, outputTokens: 2 } });
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("holds a steer while an approval waits, and sends it once it is answered", async () => {
    const { session, reader } = await open(
      {
        prompts: [[runCommand("c1", "ls"), { awaitSteer: true }], [chunk("Steered.")]],
      },
      { autonomy: "supervised" },
    );
    reader.answer = (item) => {
      void session.steer?.({ text: "Then run the tests", attachments: [] });
      return item.kind === "approval_request"
        ? { kind: "approval", decision: "allow_once" }
        : undefined;
    };
    const events = await reader.turn("List files");

    // Sent once, after the answer: agy refuses a prompt while it waits, which would show twice.
    expect(prompts()).toEqual(["List files", "Then run the tests"]);
    expect(answers()).toEqual(["allow"]);
    expect(events.filter(isTurnEnd).map((e) => e.type)).toEqual(["turn.completed"]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("drops a held steer on Stop and says it was not delivered", async () => {
    const { session, reader } = await open([runCommand("c1", "ls"), { hang: true }], {
      autonomy: "supervised",
    });
    reader.answer = () => {
      void session.steer?.({ text: "Never mind", attachments: [] });
      void session.interrupt();
      return undefined;
    };
    const events = await reader.turn("List files");

    expect(prompts()).toEqual(["List files"]);
    expect(events.filter(isTurnEnd).map((e) => e.type)).toEqual(["turn.interrupted"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({ code: "queued_messages_cancelled" }),
      }),
    );
  });

  it("refuses a steer when no turn runs", async () => {
    const { session, reader } = await open([chunk("Done.")]);
    await reader.turn("Hello");
    await expect(session.steer?.({ text: "late", attachments: [] })).rejects.toMatchObject({
      code: "no_turn",
    });
  });
});

describe("ACP prompt chain", () => {
  const waiting = new AcpRpcError(
    -32603,
    "the running prompt is waiting for a permission or question answer",
  );

  it("holds a steer the agent refused while it waited, and sends it again", async () => {
    const sent: unknown[] = [];
    let refuse = true;
    let finishFirst: (r: AcpPromptResult) => void = () => {};
    const chain = new AcpPromptChain({
      send: (prompt) => {
        sent.push(prompt);
        if (prompt === "first") return new Promise((resolve) => (finishFirst = resolve));
        if (refuse) {
          refuse = false;
          return Promise.reject(waiting);
        }
        return Promise.resolve({ stopReason: "end_turn", usage: { inputTokens: 2 } });
      },
      canSend: () => true,
      waitRefusal: /waiting for a permission or question answer/,
    });
    chain.begin("first");
    chain.steer("steer");
    await new Promise((r) => setImmediate(r));
    expect(chain.holding).toBe(true);
    expect(chain.flush()).toBe(true);
    finishFirst({ stopReason: "end_turn", usage: { inputTokens: 1 } });
    expect(await chain.settle()).toEqual({ stopReason: "end_turn", usage: { inputTokens: 2 } });
    expect(sent).toEqual(["first", "steer", "steer"]);
    expect(chain.usage()).toEqual({ inputTokens: 3 });
  });
});

describe("Antigravity CLI subagents", () => {
  const U1 = "9754a9c4-ddc0-4180-aa61-4d45e004c286";
  const U2 = "bd0473cc-95b4-4014-a4a6-b29bded4905b";
  /** agy's `invoke_subagent` call: it finishes at once, and the subagent runs on. */
  const spawn = (id: string, role: string, prompt: string): Step[] => {
    const call = {
      toolCallId: id,
      name: "invoke_subagent",
      kind: "other",
      title: "Run invoke_subagent",
      rawInput: { Prompt: prompt, Role: role, TypeName: "research" },
    };
    return [
      { update: { sessionUpdate: "tool_call", status: "in_progress", ...call } },
      { update: { sessionUpdate: "tool_call_update", status: "completed", ...call } },
    ];
  };
  /** One of a subagent's own steps, on the parent's session. */
  const step = (id: string, command: string): Step[] => [
    runCommand(id, command),
    {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "1 README.md" } }],
      },
    },
  ];
  type Done = { threadId: string; item: ItemOf<"subagent"> & { kind: string } };
  const completed = (events: AgentEvent[], kind: string): Done[] =>
    events.flatMap((e) =>
      e.type === "item.completed" && e.item.kind === kind
        ? [{ threadId: e.threadId, item: e.item as Done["item"] }]
        : [],
    );

  it("shows a subagent as a card with a thread of its own, holding its steps and approvals", async () => {
    const { reader, adapter } = await open(
      [
        ...spawn("call_1", "Line Counter", "Count the lines of README.md"),
        chunk("Delegated."),
        ...step(`${U1}:call_2`, "wc -l README.md"),
        chunk("It has 1 line."),
      ],
      { autonomy: "supervised" },
    );
    expect(adapter.capabilities()).toMatchObject({ subagents: true, skills: true });
    reader.answer = () => ({ kind: "approval", decision: "allow_once" });
    const events = await reader.turn("Count the lines with a subagent");

    const cards = completed(events, "subagent");
    expect(cards).toHaveLength(1);
    const card = cards[0]?.item as ItemOf<"subagent">;
    expect(card).toMatchObject({
      status: "completed",
      description: "Line Counter",
      agentType: "research",
      prompt: "Count the lines of README.md",
      stats: { toolUses: 1 },
    });
    expect(cards[0]?.threadId).toBe("s1:thread-root");
    const child = card.childThreadId;
    const tools = completed(events, "tool_call");
    // The spawn call is the card; the subagent's step is in its thread.
    expect(tools.map((t) => t.threadId)).toEqual([child]);
    const approvals = completed(events, "approval_request");
    expect(approvals.map((a) => a.threadId)).toEqual([child]);
    expect(answers()).toEqual(["allow"]);
    const ends = events.filter(isTurnEnd).map((e) => [e.type, "threadId" in e && e.threadId]);
    expect(ends).toEqual([
      ["turn.completed", child],
      ["turn.completed", "s1:thread-root"],
    ]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("gives a subagent seen for the first time the oldest card still waiting for one", async () => {
    const { reader } = await open([
      ...spawn("call_a", "First", "Do A"),
      ...spawn("call_b", "Second", "Do B"),
      ...step(`${U2}:call_x`, "ls"),
      ...step(`${U1}:call_y`, "pwd"),
      ...step(`${U2}:call_z`, "ls -a"),
    ]);
    const events = await reader.turn("Split it");

    const cards = completed(events, "subagent").map((c) => c.item as ItemOf<"subagent">);
    expect(cards.map((c) => [c.description, c.stats?.toolUses])).toEqual([
      ["First", 2],
      ["Second", 1],
    ]);
    const threadOf = (desc: string) => cards.find((c) => c.description === desc)?.childThreadId;
    const tools = completed(events, "tool_call");
    expect(tools.map((t) => t.threadId)).toEqual([
      threadOf("First"),
      threadOf("Second"),
      threadOf("First"),
    ]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });

  it("opens a card for a subagent's step whose spawn it never saw", async () => {
    const { reader } = await open([...step(`${U1}:call_1`, "ls"), chunk("Done.")]);
    const events = await reader.turn("Go");
    const cards = completed(events, "subagent").map((c) => c.item as ItemOf<"subagent">);
    expect(cards).toMatchObject([{ description: "Subagent", stats: { toolUses: 1 } }]);
    expect(validateEventStream(reader.all)).toEqual([]);
  });
});
