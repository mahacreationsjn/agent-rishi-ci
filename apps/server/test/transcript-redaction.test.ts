import type { Item, ItemRecord, Session, Thread, Turn } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import {
  sessionTranscriptMarkdown,
  type TranscriptSource,
  transcriptFileName,
} from "../src/services/sessions/transcript-markdown";
import { sampleSession } from "./helpers";

/**
 * Issue #315: the Markdown export is shared outside Agent Rishi, so secrets an agent typed or
 * printed must not reach it. Tokens are assembled at runtime so the source holds no token
 * shapes of its own.
 */

const AT = "2026-11-14T10:02:00.000Z";
const rep = (s: string, n: number) => s.repeat(n);

const SECRETS = {
  github: `ghp_${rep("A1b2C3d4", 5)}`,
  githubFine: `github_pat_${rep("11AbC0dEf", 6)}`,
  openai: `sk-proj-${rep("Xy9Zq8Wv", 6)}`,
  anthropic: `sk-ant-api03-${rep("Qa1Ws2Ed", 6)}`,
  awsKey: `AKIA${rep("Z7Q2", 4)}`,
  slack: `xoxb-${rep("1234", 3)}-${rep("AbCd", 6)}`,
  jwt: `eyJ${rep("hbGciOiJ", 3)}.eyJ${rep("zdWIiOiJ", 3)}.${rep("dozjgNry", 4)}`,
  bearer: rep("b3ar3rT0k", 4),
  password: "hunter2-correct-horse",
  mcp: `cdm_${rep("q1W2e3R4t5", 4)}`,
} as const;

const session: Session = {
  ...sampleSession,
  title: "Deploy the app",
  purpose: "Deploy the app",
  status: "completed",
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

const turn: Turn = {
  id: "u1",
  threadId: "t1",
  sessionId: session.id,
  status: "completed",
  startedAt: AT,
  completedAt: AT,
  error: null,
};

let position = 0;
const rec = (item: Item, threadId = "t1"): ItemRecord => ({
  sessionId: session.id,
  threadId,
  turnId: "u1",
  position: position++,
  item,
  createdAt: AT,
  updatedAt: AT,
});

const command = (id: string, cmd: string): Item => ({
  id,
  status: "completed",
  kind: "tool_call",
  toolKind: "command",
  toolName: "Bash",
  command: cmd,
  exitCode: 0,
});

function source(items: ItemRecord[], threads: Thread[] = [thread("t1")]): TranscriptSource {
  return {
    session,
    projectName: null,
    providerName: "Fake",
    forkedFromTitle: null,
    threads,
    turns: [turn],
    items,
    usage: null,
    exportedAt: new Date(AT),
    version: "1.2.3",
  };
}

describe("transcript export: secrets (#315)", () => {
  it("redacts planted tokens and counts them in the header", () => {
    const md = sessionTranscriptMarkdown(
      source([
        rec({
          id: "m1",
          status: "completed",
          kind: "user_message",
          input: { text: `Use ${SECRETS.anthropic} for the API`, attachments: [] },
        }),
        rec(command("c1", `export GITHUB_TOKEN=${SECRETS.github}`)),
        rec(
          command(
            "c2",
            `curl -H "Authorization: Bearer ${SECRETS.bearer}" https://api.example.com`,
          ),
        ),
        rec(command("c3", `gh auth login --with-token <<< ${SECRETS.githubFine}`)),
        rec(command("c4", `cat > .env <<'EOF'\nDB_PASSWORD=${SECRETS.password}\nEOF`)),
        rec({
          id: "r1",
          status: "completed",
          kind: "assistant_message",
          text: [
            "Your `.env` holds:",
            "",
            `OPENAI_API_KEY=${SECRETS.openai}`,
            `AWS_ACCESS_KEY_ID=${SECRETS.awsKey}`,
            `SLACK_BOT=${SECRETS.slack}`,
            `The session token is ${SECRETS.jwt} and the MCP token ${SECRETS.mcp}.`,
          ].join("\n"),
        }),
        rec({
          id: "ap",
          status: "completed",
          kind: "approval_request",
          requestId: "rq",
          action: "network",
          title: "Push with a token",
          command: `git push https://x-access-token:${SECRETS.github}@github.com/acme/app.git`,
          options: ["allow_once", "deny"],
          decision: "allow_once",
          decidedBy: "user",
        }),
        rec({
          id: "x1",
          status: "completed",
          kind: "error",
          error: { message: `401 for key ${SECRETS.openai}` },
        }),
      ]),
    );
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(md, name).not.toContain(secret);
    }
    const count = md.match(/\[redacted\]/g)?.length ?? 0;
    expect(count).toBeGreaterThanOrEqual(Object.keys(SECRETS).length);
    // The header says how many values were replaced.
    expect(md.split("---")[0]).toContain(`${count} values redacted`);
    // What isn't a secret stays readable.
    expect(md).toContain("https://api.example.com");
    expect(md).toContain("GITHUB_TOKEN=[redacted]");
  });

  it("hides a secret before cutting a long command, so no piece of it is left", () => {
    const long = `curl ${"x".repeat(270)} -H "Authorization: Bearer ${SECRETS.bearer}"`;
    const md = sessionTranscriptMarkdown(source([rec(command("c5", long))]));
    expect(md).toContain('-H "Authorization: Bear…`');
    expect(md).not.toContain(SECRETS.bearer.slice(0, 6));
    expect(md).toContain("_1 value redacted:");
  });

  it("hides the exact values it is given, such as the install token", () => {
    const install = "f00d".repeat(16);
    const md = sessionTranscriptMarkdown({
      ...source([
        rec({ id: "r3", status: "completed", kind: "assistant_message", text: `Using ${install}` }),
      ]),
      knownSecrets: [install],
    });
    expect(md).toContain("**Agent**\n\nUsing [redacted]");
  });

  it("hides a password glued into a variable's name, as agents run psql and mysql", () => {
    const md = sessionTranscriptMarkdown(
      source([
        rec(command("c6", "PGPASSWORD=hunter2-correct psql -h db -c 'select 1'")),
        rec(command("c7", "MYSQL_PWD=hunter22 mysql -u app")),
        rec(command("c8", "wp core install --admin_password=hunter22 --url=x.dev")),
      ]),
    );
    expect(md).toContain("* Ran `PGPASSWORD=[redacted] psql -h db -c 'select 1'`");
    expect(md).toContain("* Ran `MYSQL_PWD=[redacted] mysql -u app`");
    expect(md).toContain("* Ran `wp core install --admin_password=[redacted] --url=x.dev`");
    expect(md).not.toContain("hunter2");
  });

  it("names the file after the redacted title", () => {
    const install = "f00d".repeat(16);
    const titled = { ...session, title: `Rotate ${install}` };
    expect(transcriptFileName(titled, new Date(AT), null, [install])).toBe(
      "rotate-redacted-2026-11-14.md",
    );
  });

  it("exports a huge transcript quickly (the redaction stays linear)", () => {
    const blob = "a-".repeat(100_000);
    const started = performance.now();
    sessionTranscriptMarkdown(
      source([rec({ id: "r6", status: "completed", kind: "assistant_message", text: blob })]),
    );
    // Seconds to a minute before the redactor's rules were bounded; milliseconds now.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("adds no note when there is nothing to hide", () => {
    const md = sessionTranscriptMarkdown(
      source([rec({ id: "r4", status: "completed", kind: "assistant_message", text: "All good" })]),
    );
    expect(md).not.toContain("redacted");
  });

  it("escapes fold tags in prose but leaves them in code", () => {
    const md = sessionTranscriptMarkdown(
      source([
        rec({
          id: "r5",
          status: "completed",
          kind: "assistant_message",
          text: "Use `<details>` like so:\n\n```html\n<details><summary>x</summary></details>\n```\n\nNot </details> or <DETAILS open> here.",
        }),
      ]),
    );
    expect(md).toContain("Use `<details>` like so:");
    expect(md).toContain("```html\n<details><summary>x</summary></details>\n```");
    expect(md).toContain("Not &lt;/details> or &lt;DETAILS open> here.");
  });

  it("keeps a literal </details> in a subagent's message from closing its fold early", () => {
    const md = sessionTranscriptMarkdown(
      source(
        [
          rec({
            id: "sub1",
            status: "completed",
            kind: "subagent",
            childThreadId: "t2",
            description: "Write the HTML",
          }),
          rec(
            {
              id: "r2",
              status: "completed",
              kind: "assistant_message",
              text: "Wrap it like this:\n\n</details>\n\nand you're done.",
            },
            "t2",
          ),
        ],
        [thread("t1"), thread("t2", "t1")],
      ),
    );
    // One fold, closed once: the message's own tag is escaped.
    expect(md.match(/<details>/g)).toHaveLength(1);
    expect(md.match(/^<\/details>/gm)).toHaveLength(1);
    expect(md.trimEnd().endsWith("</details>")).toBe(true);
  });
});
