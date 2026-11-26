import type { ItemOf, RuntimeResponse, UserQuestion } from "@agent-rishi/contracts";
import type { AcpExtensionHost } from "../acp/extensions";
import { mcpOf } from "../acp/items";
import type { AnswerReview } from "../approvals";
import type { McpElicitationSchema } from "../codex/protocol/v2";
import {
  ACCEPT,
  CONFIRM_ID,
  DECLINE,
  type FormField,
  formContent,
  formFields,
  formQuestions,
} from "../util/elicitation-form";
import { shorten } from "../util/text";

/**
 * Antigravity CLI's questions (§7.2). Told the client takes forms (`clientCapabilities
 * .elicitation.form`), it sends its `ask_question` tool's questions as an ACP `elicitation/create`
 * form: one field per question (`q1`: a string with `oneOf` choices, or an array for several),
 * plus `q1_other` for a typed answer. Those become one Agent Rishi question each, with its choices
 * and free text, and the answers go back as the form's content. Any other form (an MCP server's)
 * is shown field by field as that server's and stays with the user (`mcpServer`).
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** The `elicitation/create` params Antigravity CLI sends. */
export interface AgyElicitation {
  sessionId?: string;
  toolCallId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: { properties?: Record<string, unknown>; required?: string[] };
}
export type AgyElicitationResult =
  | { action: "accept"; content: Record<string, Json> }
  | { action: "decline" }
  | { action: "cancel" };

const CANCEL: AgyElicitationResult = { action: "cancel" };
const DECLINED: AgyElicitationResult = { action: "decline" };
const QUESTION = /^q(\d+)$/;

/** One of its questions: the field, its typed-answer field and its choices. */
export interface AgyQuestion {
  id: string;
  other?: string;
  question: string;
  multi: boolean;
  choices: { value: string; label: string }[];
}

type Choice = { const?: unknown; title?: unknown };
const choicesOf = (list: unknown): { value: string; label: string }[] =>
  (Array.isArray(list) ? (list as Choice[]) : []).flatMap((c) =>
    typeof c?.const === "string"
      ? [{ value: c.const, label: typeof c.title === "string" && c.title ? c.title : c.const }]
      : [],
  );

/**
 * Its questions, when every field of the form is one (`qN`) or a typed answer to one
 * (`qN_other`); undefined for any other form. Pure.
 */
export function agyQuestions(schema: AgyElicitation["requestedSchema"]): AgyQuestion[] | undefined {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return undefined;
  const names = Object.keys(props);
  const questions: AgyQuestion[] = [];
  for (const name of names) {
    if (!QUESTION.test(name)) {
      const base = /^(q\d+)_other$/.exec(name)?.[1];
      if (base && base in props) continue;
      return undefined;
    }
    const p = props[name] as { type?: unknown; title?: unknown; oneOf?: unknown; items?: unknown };
    const multi = p.type === "array";
    const items = (p.items ?? {}) as { anyOf?: unknown; oneOf?: unknown };
    const choices = choicesOf(multi ? (items.anyOf ?? items.oneOf) : p.oneOf);
    const title = typeof p.title === "string" ? p.title.trim() : "";
    if (!title || (p.type !== "string" && !multi)) return undefined;
    questions.push({
      id: name,
      ...(`${name}_other` in props ? { other: `${name}_other` } : {}),
      question: title,
      multi,
      choices,
    });
  }
  return questions.length ? questions : undefined;
}

/** Its questions as Agent Rishi's: choices as options, a typed answer where it takes one. */
export function agyUserQuestions(questions: readonly AgyQuestion[]): UserQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.choices.map((c) => ({ label: c.label })),
    multiSelect: q.multi,
    allowFreeText: !!q.other || q.choices.length === 0,
  }));
}

/**
 * The form's content from Agent Rishi's answers (keyed by question id): a picked option as its
 * value (several, as a list, for a multi-select), anything else typed as the question's
 * `qN_other` answer (or its own value, when it has no choices). Pure.
 */
export function agyAnswerContent(
  questions: readonly AgyQuestion[],
  answers: Record<string, string[]>,
): Record<string, Json> {
  const content: Record<string, Json> = {};
  for (const q of questions) {
    const given = (answers[q.id] ?? []).map((a) => a.trim()).filter(Boolean);
    const picked: string[] = [];
    const typed: string[] = [];
    for (const a of given) {
      const choice = q.choices.find((c) => c.label === a) ?? q.choices.find((c) => c.value === a);
      if (choice) picked.push(choice.value);
      else typed.push(a);
    }
    if (q.multi) {
      if (picked.length) content[q.id] = picked;
    } else if (picked[0] !== undefined) {
      content[q.id] = picked[0];
    }
    if (typed.length) {
      if (q.other) content[q.other] = typed.join("\n");
      else if (!q.choices.length && !q.multi) content[q.id] = typed.join("\n");
    }
  }
  return content;
}

/** Answer `elicitation/create`: a question card for its questions, else a form card. */
export async function answerAgyElicitation(
  params: AgyElicitation,
  host: AcpExtensionHost,
): Promise<AgyElicitationResult> {
  const ctx = host.ctx();
  if (!ctx || params.mode !== "form" || !params.requestedSchema) return CANCEL;
  const call = params.toolCallId ? host.mapper.tool({ toolCallId: params.toolCallId }) : undefined;
  const own = agyQuestions(params.requestedSchema);
  const requestId = `question-${params.toolCallId || "agy"}-${Math.random().toString(36).slice(2, 8)}`;
  if (own && !isMcpCall(call, host)) {
    const item: ItemOf<"user_question"> = {
      id: `question-${requestId}`,
      kind: "user_question",
      status: "in_progress",
      requestId,
      questions: agyUserQuestions(own) as [UserQuestion, ...UserQuestion[]],
    };
    const response = await host.broker.request(ctx, item);
    if (response.kind !== "answer") return CANCEL;
    return { action: "accept", content: agyAnswerContent(own, response.answers) };
  }
  return fillForm(params, call, requestId, host);
}

/** The call behind the form is one of an MCP server's tools (named `mcp_<server>_<tool>`). */
function isMcpCall(
  call: ReturnType<AcpExtensionHost["mapper"]["tool"]> | undefined,
  host: AcpExtensionHost,
) {
  return !!call && !!serverOf(call, host);
}

function serverOf(
  call: ReturnType<AcpExtensionHost["mapper"]["tool"]>,
  host: AcpExtensionHost,
): string | undefined {
  // Its titles read "Run <tool>"; the tool's own name says which server it belongs to.
  const named = /^Run\s+(\S+)$/.exec(call.title ?? "")?.[1];
  const state = { ...call, ...(named && !call.name ? { name: named } : {}) };
  const found = mcpOf(state, host.mcpServers);
  if (found) return found.server;
  const name = state.name ?? "";
  return /^mcp_/i.test(name) ? shorten(name.replace(/^mcp_/i, ""), 60) : undefined;
}

/**
 * Any other form, field by field (`../util/elicitation-form`), as the MCP server's that asks:
 * like an approval it stays with the user. A form without fields is a confirmation.
 */
async function fillForm(
  params: AgyElicitation,
  call: ReturnType<AcpExtensionHost["mapper"]["tool"]> | undefined,
  requestId: string,
  host: AcpExtensionHost,
): Promise<AgyElicitationResult> {
  const ctx = host.ctx();
  if (!ctx) return CANCEL;
  const server = (call && serverOf(call, host)) || "Antigravity CLI";
  const fields = formFields(params.requestedSchema as unknown as McpElicitationSchema);
  const confirmed = (answers: Record<string, string[]>) =>
    answers[CONFIRM_ID]?.includes(ACCEPT) === true;
  const review: AnswerReview =
    fields.length === 0
      ? {
          problem: (r) =>
            r.kind === "answer" && !isConfirmation(r.answers[CONFIRM_ID])
              ? `Answer ${ACCEPT} or ${DECLINE}.`
              : undefined,
          declines: (r) => r.kind === "answer" && !confirmed(r.answers),
        }
      : { problem: (r) => (r.kind === "answer" ? problemsOf(fields, r.answers) : undefined) };
  const response: RuntimeResponse = await host.broker.request(
    ctx,
    {
      id: `question-${requestId}`,
      kind: "user_question",
      status: "in_progress",
      requestId,
      mcpServer: server,
      questions: formQuestions(server, params.message ?? "", fields) as [
        UserQuestion,
        ...UserQuestion[],
      ],
    },
    undefined,
    review,
  );
  if (response.kind !== "answer") return CANCEL;
  if (fields.length === 0)
    return confirmed(response.answers) ? { action: "accept", content: {} } : DECLINED;
  const result = formContent(fields, response.answers);
  return "content" in result
    ? { action: "accept", content: result.content as Record<string, Json> }
    : CANCEL;
}

const isConfirmation = (answer: string[] | undefined) =>
  answer?.length === 1 && (answer[0] === ACCEPT || answer[0] === DECLINE);

function problemsOf(fields: FormField[], answers: Record<string, string[]>): string | undefined {
  const result = formContent(fields, answers);
  return "problems" in result ? result.problems.join("\n") : undefined;
}
