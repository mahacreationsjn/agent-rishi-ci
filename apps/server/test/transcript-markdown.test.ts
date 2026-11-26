import type { Item, ItemRecord, Session, SessionUsage, Thread, Turn } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { fenced, inlineCode, slug } from "../src/services/sessions/transcript-format";
import {
  costFact,
  sessionTranscriptMarkdown,
  type TranscriptSource,
  transcriptFileName,
} from "../src/services/sessions/transcript-markdown";
import { sampleSession } from "./helpers";

const WT = "C:\\Users\\dev\\.agent-rishi\\wt\\app\\s1ab";
const AT = "2026-11-14T10:02:00.000Z";
const EXPORTED = new Date("2026-11-14T12:00:00.000Z");

const session: Session = {
  ...sampleSession,
  projectId: "p1",
  title: "Fix the login redirect",
  purpose: "Fix the login redirect",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  status: "completed",
  cwd: WT,
  worktreePath: WT,
  branch: "agent-rishi/fix-login-s1ab",
  baseBranch: "main",
  issue: {
    number: 7,
    title: "Login [redirect] loops",
    url: "https://github.com/acme/app/issues/7",
  },
  pr: { number: 9, state: "open", url: "https://github.com/acme/app/pull/9" },
  rootThreadId: "t1",
  createdAt: AT,
  updatedAt: AT,
};

const thread = (id: string, parent: string | null = null): Thread => ({
  id,
  sessionId: session.id,
  parentThreadId: parent,
  parentItemId: parent ? "sub1" : null,
  title: null,
  agentType: null,
  createdAt: AT,
});

const turn = (id: string, patch: Partial<Turn> = {}): Turn => ({
  id,
  threadId: "t1",
  sessionId: session.id,
  status: "completed",
  startedAt: AT,
  completedAt: AT,
  error: null,
  ...patch,
});

let position = 0;
const rec = (item: Item, turnId = "u1", threadId = "t1"): ItemRecord => ({
  sessionId: session.id,
  threadId,
  turnId,
  position: position++,
  item,
  createdAt: AT,
  updatedAt: AT,
});

const usage = (patch: Partial<SessionUsage["totals"]> = {}, billing = "api"): SessionUsage => ({
  sessionId: session.id,
  billing: billing as SessionUsage["billing"],
  totals: {
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 5_000,
    reasoningTokens: 0,
    costUsd: 1.23,
    estimatedCostUsd: 0,
    unpricedTurns: 0,
    turns: 2,
    sessions: 1,
    cacheHitRate: 0.8,
    ...patch,
  },
  turns: [
    {
      turnId: "u1",
      inputTokens: 500,
      outputTokens: 1_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 2_500,
      reasoningTokens: 0,
      costUsd: 0.6,
      costSource: "reported",
    },
  ],
  subagents: [{ itemId: "sub1", costUsd: 0.042, costSource: "estimated", models: [] }],
});

function source(patch: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    session,
    projectName: "acme-app",
    providerName: "Claude Code",
    forkedFromTitle: null,
    threads: [thread("t1")],
    turns: [turn("u1")],
    items: [],
    usage: usage(),
    exportedAt: EXPORTED,
    version: "1.2.3",
    ...patch,
  };
}

describe("transcript export: header", () => {
  it("starts with the title and the session's facts", () => {
    const md = sessionTranscriptMarkdown(source());
    expect(md.startsWith("# Fix the login redirect\n\n")).toBe(true);
    expect(md).toContain("- **Project:** acme-app");
    expect(md).toContain("- **Provider:** Claude Code · claude-opus-5-5 · high effort");
    expect(md).toContain("- **Branch:** `agent-rishi/fix-login-s1ab` from `main`");
    // Brackets in a title can't end the link text early.
    expect(md).toContain(
      "- **Issue:** [#7 Login \\[redirect\\] loops](https://github.com/acme/app/issues/7)",
    );
    expect(md).toContain("- **Pull request:** [#9](https://github.com/acme/app/pull/9) (open)");
    expect(md).toContain("- **Status:** Done");
    expect(md).toContain("_Exported from Agent Rishi 1.2.3 on 2026-11-14 12:00 UTC.");
    expect(md).not.toContain("**Role:**");
  });

  it("names the role, the source of a handoff and the recorded result", () => {
    const md = sessionTranscriptMarkdown(
      source({
        session: {
          ...session,
          role: "pm",
          archivedAt: AT,
          forkedFrom: { sessionId: "s0", checkpoint: null, kind: "handoff" },
          result: { outcome: "success", summary: "Fixed it.\nTests pass.", at: AT },
        },
        forkedFromTitle: "First try",
      }),
    );
    expect(md.startsWith("# Project manager · acme-app\n")).toBe(true);
    expect(md).toContain("- **Role:** Project manager");
    expect(md).toContain("- **Handed off from:** First try");
    expect(md).toContain("- **Status:** Done (archived)");
    expect(md).toContain("- **Result:** success. Fixed it. Tests pass.");
  });

  it("names the session a review reviewed (#356)", () => {
    const md = sessionTranscriptMarkdown(
      source({
        session: { ...session, forkedFrom: { sessionId: "s0", checkpoint: 2, kind: "review" } },
        forkedFromTitle: "Fix login",
      }),
    );
    expect(md).toContain("- **Review of:** Fix login");
  });

  it("labels the cost as the ledger does (§12.6)", () => {
    expect(costFact(usage())).toBe("$1.23 · 48k tokens · 2 turns");
    expect(costFact(usage({ estimatedCostUsd: 0.5 }, "subscription"))).toBe(
      "≈ $1.23 API-equivalent (estimated from list prices) · 48k tokens · 2 turns",
    );
    expect(costFact(usage({ unpricedTurns: 1 }))).toBe(
      "$1.23 · 1 not priced · 48k tokens · 2 turns",
    );
    expect(costFact(usage({ unpricedTurns: 2, costUsd: 0 }))).toMatch(/^Not priced \(/);
    expect(costFact(usage({ turns: 0 }))).toBe("no usage recorded yet");
    expect(costFact(null)).toBeNull();
    expect(sessionTranscriptMarkdown(source({ usage: null }))).not.toContain("**Cost:**");
  });
});

describe("transcript export: turns", () => {
  it("renders each turn's messages under who sent them, with the turn's cost", () => {
    const md = sessionTranscriptMarkdown(
      source({
        turns: [turn("u1"), turn("u2", { status: "failed", error: { message: "Overloaded" } })],
        items: [
          rec({
            id: "m1",
            status: "completed",
            kind: "user_message",
            input: {
              text: "Fix the redirect",
              attachments: [
                { type: "file", path: `${WT}\\notes\\spec.md` },
                {
                  type: "image",
                  mediaType: "image/png",
                  source: { type: "path", path: "C:\\tmp\\shot.png" },
                },
              ],
            },
          }),
          rec({ id: "r0", status: "completed", kind: "reasoning", text: "SECRET THOUGHTS" }),
          rec({ id: "r1", status: "completed", kind: "assistant_message", text: "Done **now**." }),
          rec(
            {
              id: "m2",
              status: "completed",
              kind: "user_message",
              input: { text: "Message from your project manager:\nShip it", attachments: [] },
            },
            "u2",
          ),
          rec(
            {
              id: "f1",
              status: "completed",
              kind: "followups",
              source: "agent",
              suggestions: [{ prompt: "FOLLOWUP CHIP" }],
            },
            "u2",
          ),
        ],
      }),
    );
    expect(md).toContain("## Turn 1 · 2026-11-14 10:02 UTC · $0.60 · 24k tokens");
    expect(md).toContain("**User**\n\nFix the redirect\n\n_Attached:_ `spec.md`, `shot.png`");
    expect(md).toContain("**Agent**\n\nDone **now**.");
    expect(md).toContain("## Turn 2 · 2026-11-14 10:02 UTC · failed");
    // A PM's message is the PM's, not the user's, and loses its sender line.
    expect(md).toContain("**Project manager**\n\nShip it");
    expect(md).not.toContain("Message from your project manager:");
    expect(md).toContain("> **Turn failed:** Overloaded");
    expect(md).not.toContain("SECRET THOUGHTS");
    expect(md).not.toContain("FOLLOWUP CHIP");
    expect(md).not.toContain("C:\\tmp");
    expect(md.indexOf("## Turn 1")).toBeLessThan(md.indexOf("## Turn 2"));
  });

  it("lists tool calls one per line, paths relative to the worktree, without output", () => {
    const md = sessionTranscriptMarkdown(
      source({
        items: [
          rec({
            id: "c1",
            status: "completed",
            kind: "tool_call",
            toolKind: "command",
            toolName: "Bash",
            command: "pnpm test",
            exitCode: 1,
            output: { text: "TOOL OUTPUT HERE", truncated: false },
          }),
          rec({
            id: "e1",
            status: "completed",
            kind: "tool_call",
            toolKind: "file_edit",
            toolName: "Edit",
            changes: [
              {
                path: `${WT}\\src\\login.ts`,
                change: "modify",
                additions: 3,
                deletions: 1,
                diff: "DIFF BODY",
              },
              { path: `${WT}\\src\\new.ts`, change: "add", additions: 5, deletions: 0 },
            ],
          }),
          rec({
            id: "rd",
            status: "completed",
            kind: "tool_call",
            toolKind: "file_read",
            toolName: "Read",
            path: `${WT}\\README.md`,
            startLine: 1,
            endLine: 40,
          }),
          rec({
            id: "s1",
            status: "completed",
            kind: "tool_call",
            toolKind: "search",
            toolName: "Grep",
            query: "redirect",
            path: `${WT}\\src`,
            matchCount: 1,
          }),
          rec({
            id: "w1",
            status: "completed",
            kind: "tool_call",
            toolKind: "web",
            toolName: "WebFetch",
            url: "https://example.com/docs",
          }),
          rec({
            id: "mc",
            status: "failed",
            kind: "tool_call",
            toolKind: "mcp",
            toolName: "mcp__agent-rishi__finish",
            server: "agent-rishi",
            tool: "finish",
            error: { message: "Server\nunreachable" },
          }),
          rec({
            id: "b1",
            status: "completed",
            kind: "tool_call",
            toolKind: "browser",
            toolName: "browser_navigate",
            action: "navigate",
            url: "http://localhost:5173/",
          }),
          rec({
            id: "o1",
            status: "declined",
            kind: "tool_call",
            toolKind: "other",
            toolName: "Skill",
            title: "Run the deploy skill",
          }),
        ],
      }),
    );
    expect(md).toContain(
      [
        "* Ran `pnpm test` (exit 1)",
        "* Edited `src/login.ts` (+3 −1), `src/new.ts` (new +5 −0)",
        "* Read `README.md` (lines 1–40)",
        "* Searched for `redirect` in `src` (1 match)",
        "* Fetched <https://example.com/docs>",
        "* Called `agent-rishi/finish` — failed: Server unreachable",
        "* Browser navigate <http://localhost:5173/>",
        "* Used `Skill`: Run the deploy skill — declined",
      ].join("\n"),
    );
    expect(md).not.toContain("TOOL OUTPUT HERE");
    expect(md).not.toContain("DIFF BODY");
    expect(md).not.toContain("C:\\Users\\dev");
  });

  it("lists hook runs in the tool list, with the reason a run failed or blocked", () => {
    const md = sessionTranscriptMarkdown(
      source({
        items: [
          rec({
            id: "hk1",
            status: "declined",
            kind: "hook_run",
            event: "PreToolUse",
            label: "Bash",
            outcome: "blocked",
            exitCode: 2,
            output: "rm -rf is\nnot allowed",
          }),
          rec({
            id: "c3",
            status: "completed",
            kind: "tool_call",
            toolKind: "command",
            toolName: "Bash",
            command: "ls",
            exitCode: 0,
          }),
          rec({
            id: "hk2",
            status: "completed",
            kind: "hook_run",
            event: "PostToolUse",
            label: "",
            outcome: "succeeded",
            output: "HOOK OUTPUT HERE",
          }),
        ],
      }),
    );
    expect(md).toContain(
      [
        "* Hook PreToolUse `Bash` — blocked (exit 2): rm -rf is not allowed",
        "* Ran `ls`",
        "* Hook PostToolUse — ran",
      ].join("\n"),
    );
    expect(md).not.toContain("HOOK OUTPUT HERE");
  });

  it("puts a multi-line command in a fence its backticks can't close", () => {
    const md = sessionTranscriptMarkdown(
      source({
        items: [
          rec({
            id: "c2",
            status: "completed",
            kind: "tool_call",
            toolKind: "command",
            toolName: "Bash",
            command: "cat <<'EOF'\n```\nhi\nEOF",
            exitCode: 0,
          }),
        ],
      }),
    );
    expect(md).toContain("* Ran:\n  ````sh\n  cat <<'EOF'\n  ```\n  hi\n  EOF\n  ````");
  });

  it("keeps a tool list from merging into the todo list before it", () => {
    const md = sessionTranscriptMarkdown(
      source({
        items: [
          rec({
            id: "td2",
            status: "completed",
            kind: "todo_list",
            todos: [{ text: "Run the checks", status: "completed" }],
          }),
          rec({
            id: "c3",
            status: "completed",
            kind: "tool_call",
            toolKind: "command",
            toolName: "Bash",
            command: "echo hello",
          }),
        ],
      }),
    );
    // Markdown merges two `-` lists split only by a blank line; a different marker starts anew.
    expect(md).toContain("- [x] Run the checks\n\n* Ran `echo hello`");
  });

  it("renders plans, todos, questions, approvals, notices and errors", () => {
    const md = sessionTranscriptMarkdown(
      source({
        items: [
          rec({ id: "p1", status: "completed", kind: "plan", text: "1. Read\n2. Fix" }),
          rec({
            id: "td",
            status: "completed",
            kind: "todo_list",
            todos: [
              { text: "Read the code", status: "completed" },
              { text: "Fix it", status: "in_progress" },
              { text: "Test", status: "pending" },
            ],
          }),
          rec({
            id: "q1",
            status: "completed",
            kind: "user_question",
            requestId: "rq1",
            questions: [
              {
                id: "a",
                header: "Scope",
                question: "Which page?",
                options: [],
                multiSelect: false,
                allowFreeText: true,
              },
              {
                id: "b",
                question: "Anything else?",
                options: [],
                multiSelect: false,
                allowFreeText: true,
              },
            ],
            answers: { a: ["Login", "Signup"] },
            decidedBy: "pm",
          }),
          rec({
            id: "ap",
            status: "completed",
            kind: "approval_request",
            requestId: "rq2",
            action: "git_destructive",
            title: "Force push",
            reason: "Rewrites history",
            command: "git push --force",
            options: ["allow_once", "allow_session", "deny"],
            decision: "deny",
            decidedBy: "user",
          }),
          rec({
            id: "n1",
            status: "completed",
            kind: "notice",
            level: "warning",
            message: "Context compacted",
          }),
          rec({
            id: "x1",
            status: "completed",
            kind: "error",
            error: { message: "Rate limited\nRetrying" },
          }),
        ],
      }),
    );
    expect(md).toContain("**Plan**\n\n1. Read\n2. Fix");
    expect(md).toContain(
      "**Todo list**\n\n- [x] Read the code\n- [ ] Fix it _(in progress)_\n- [ ] Test",
    );
    expect(md).toContain(
      [
        "**Agent asked**",
        "",
        "- **Scope:** Which page?",
        "  - Answer: Login, Signup",
        "- Anything else?",
        "  - Answer: _not answered_",
        "",
        "_Answered by the project manager._",
      ].join("\n"),
    );
    expect(md).toContain(
      [
        "**Approval requested:** Force push",
        "",
        "- Why: Rewrites history",
        "- Command: `git push --force`",
        "- Decision: Denied, by the user",
      ].join("\n"),
    );
    expect(md).toContain("> **Warning:** Context compacted");
    expect(md).toContain("> **Error:** Rate limited\n> Retrying");
  });

  it("folds each subagent's thread into details, nested for subagents of subagents", () => {
    const md = sessionTranscriptMarkdown(
      source({
        threads: [thread("t1"), thread("t2", "t1"), thread("t3", "t2")],
        items: [
          rec({
            id: "sub1",
            status: "completed",
            kind: "subagent",
            childThreadId: "t2",
            agentType: "code-reviewer",
            description: "Review the diff",
            prompt: "Review it carefully",
            summary: "Looks good.",
            stats: { totalTokens: 12_000, toolUses: 3, durationMs: 80_000 },
          }),
          rec(
            {
              id: "c9",
              status: "completed",
              kind: "tool_call",
              toolKind: "command",
              toolName: "Bash",
              command: "git diff",
            },
            "u1",
            "t2",
          ),
          rec(
            {
              id: "sub2",
              status: "completed",
              kind: "subagent",
              childThreadId: "t3",
              description: "Check types",
            },
            "u1",
            "t2",
          ),
          rec(
            { id: "r9", status: "completed", kind: "assistant_message", text: "Types are fine" },
            "u1",
            "t3",
          ),
          rec(
            { id: "r8", status: "completed", kind: "assistant_message", text: "Reviewed" },
            "u1",
            "t2",
          ),
        ],
      }),
    );
    expect(md).toContain(
      "**Subagent `code-reviewer`**: Review the diff · ≈ $0.042 · 12k tokens · 3 tool calls · 1m 20s\n\n> Looks good.",
    );
    const outer = md.indexOf("<details>\n<summary>Its thread (3 steps)</summary>\n\n**Task**");
    const inner = md.indexOf("<details>\n<summary>Its thread (1 step)</summary>");
    expect(outer).toBeGreaterThan(-1);
    expect(inner).toBeGreaterThan(outer);
    expect(md).toContain("* Ran `git diff`");
    expect(md).toContain(
      "**Subagent**\n\nTypes are fine\n\n</details>\n\n**Subagent**\n\nReviewed",
    );
    // Child threads aren't turns of their own.
    expect(md.match(/## Turn /g)).toHaveLength(1);
    expect(md.match(/<details>/g)).toHaveLength(2);
    expect(md.match(/<\/details>/g)).toHaveLength(2);
  });

  it("says so when there is nothing yet", () => {
    const md = sessionTranscriptMarkdown(source({ threads: [], turns: [], items: [] }));
    expect(md.trimEnd().endsWith("_No messages yet._")).toBe(true);
  });
});

describe("transcript export: helpers", () => {
  it("never lets backticks close inline code or a fence", () => {
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("`x`")).toBe("`` `x` ``");
    expect(inlineCode("line one\nline two")).toBe("`line one line two`");
    expect(fenced("plain")).toBe("```\nplain\n```");
    expect(fenced("has ``` inside\n`````", "md")).toBe("``````md\nhas ``` inside\n`````\n``````");
  });

  it("names the file after the title and the export date", () => {
    expect(transcriptFileName(session, EXPORTED)).toBe("fix-the-login-redirect-2026-11-14.md");
    const long = { ...session, title: `Ünïcode ${"word ".repeat(30)}` };
    const name = transcriptFileName(long, EXPORTED);
    expect(name.startsWith("unicode-word-word")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60 + "-2026-11-14.md".length);
    expect(name).not.toContain("--");
    expect(
      transcriptFileName({ ...session, id: "AbCd1234EfGh", title: "修复登录" }, EXPORTED),
    ).toBe("session-abcd1234-2026-11-14.md");
    expect(transcriptFileName({ ...session, role: "pm" }, EXPORTED, "acme-app")).toBe(
      "project-manager-acme-app-2026-11-14.md",
    );
    expect(slug("  --Hello, World!--  ")).toBe("hello-world");
  });
});
