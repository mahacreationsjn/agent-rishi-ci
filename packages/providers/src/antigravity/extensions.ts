import path from "node:path";
import type { ItemOf, RuntimeResponse } from "@agent-rishi/contracts";
import { select } from "../acp/approvals";
import type { AcpExtensionHost, AcpExtensions } from "../acp/extensions";
import type { AcpToolState } from "../acp/items";
import type { AcpPermissionRequest, AcpPermissionResult } from "../acp/protocol";
import { type AgyElicitation, answerAgyElicitation } from "./questions";

/** The file Antigravity CLI writes its plan to, in plan mode, for the user's review. */
export const AGY_PLAN_FILE = "implementation_plan.md";
/** What Agent Rishi sends once the user approves the plan: Antigravity CLI waits for a go-ahead. */
export const AGY_PLAN_APPROVED = "The plan is approved. Carry it out now.";
const MAX_PLAN_CHARS = 256 * 1024;
const CANCELLED: AcpPermissionResult = { outcome: { outcome: "cancelled" } };

/** One of Antigravity CLI's own notes (plan, task list, walkthrough) it asks to write. */
export interface AgyArtifact {
  file: string;
  name: string;
  content: string;
}

/**
 * The artifact a `write_file` request saves, or undefined when it isn't one: its raw input
 * carries `ArtifactMetadata`, and the file is a `.md` file inside Antigravity CLI's own
 * `brain` folder (`brainDir`), so a write anywhere else is judged as any other edit. Pure.
 */
export function agyArtifact(call: AcpToolState, brainDir: string): AgyArtifact | undefined {
  const input = call.rawInput as Record<string, unknown> | undefined;
  if (!input || typeof input !== "object" || !input.ArtifactMetadata) return undefined;
  if (call.kind !== "edit") return undefined;
  const target = typeof input.Path === "string" ? input.Path : undefined;
  if (!target || !path.isAbsolute(target)) return undefined;
  const file = path.resolve(target);
  const rel = path.relative(path.resolve(brainDir), file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  if (!/\.md$/i.test(file)) return undefined;
  const content = typeof input.Content === "string" ? input.Content : "";
  return { file, name: path.basename(file), content };
}

/**
 * How Agent Rishi reads Antigravity CLI beyond ACP itself (`permission`):
 * - Its own notes (an implementation plan, a task list, a walkthrough), written to its `brain`
 *   folder outside the worktree, are saved without asking: they are the agent's working notes,
 *   not project changes. A read-only session still refuses them.
 * - In plan mode, its plan (`implementation_plan.md`) becomes Agent Rishi's plan approval, with the
 *   plan shown. Antigravity CLI then waits for a go-ahead, so approving leaves plan mode and
 *   sends one as the next prompt of the same turn (`continueWith`).
 * - Its questions: Agent Rishi says it takes forms (`elicitation.form`), so Antigravity CLI sends
 *   them as `elicitation/create`, which become question cards (`./questions`).
 */
export function agyExtensions(brainDir: string): AcpExtensions {
  return {
    clientCapabilities: { elicitation: { form: {} } },
    request(method, params, host) {
      if (method !== "elicitation/create") return undefined;
      return answerAgyElicitation((params ?? {}) as AgyElicitation, host);
    },
    permission(req, call, host) {
      const artifact = agyArtifact(call, brainDir);
      if (!artifact) return undefined;
      if (host.readOnly && !host.planning) return undefined;
      if (host.planning && artifact.name === AGY_PLAN_FILE) {
        return approvePlan(req, call, artifact, host);
      }
      return Promise.resolve(select(req.options, "allow"));
    },
  };
}

/**
 * The finished plan: shown as a plan, then Agent Rishi's plan approval while Antigravity CLI waits to
 * save it. The plan file is saved either way. Approving leaves plan mode for the session's level
 * and sends the go-ahead once this prompt ends; declining keeps it planning, and the user sends
 * what to change as the next message (ACP can't carry the note).
 */
async function approvePlan(
  req: AcpPermissionRequest,
  call: AcpToolState,
  artifact: AgyArtifact,
  host: AcpExtensionHost,
): Promise<AcpPermissionResult> {
  const ctx = host.ctx();
  if (!ctx) return CANCELLED;
  const planId = host.mapper.toolItemId(`plan-${call.toolCallId || "agy"}`);
  const text = artifact.content.trim().slice(0, MAX_PLAN_CHARS);
  const item: ItemOf<"plan"> = {
    id: planId,
    kind: "plan",
    status: "completed",
    text: text || `Antigravity CLI's plan is in \`${artifact.file}\`.`,
  };
  host.mapper.emitItem(item);
  const requestId = `plan-${call.toolCallId || "agy"}-${Math.random().toString(36).slice(2, 8)}`;
  const response: RuntimeResponse = await host.broker.request(ctx, {
    id: `approval-${requestId}`,
    kind: "approval_request",
    status: "in_progress",
    requestId,
    action: "plan",
    title: "Implement the plan",
    reason:
      "Antigravity CLI finished planning. Declining keeps it planning: send what to change as your next message.",
    toolName: "implementation_plan",
    toolCallItemId: planId,
    options: ["allow_once", "deny"],
  });
  if (response.kind !== "approval") return CANCELLED;
  if (response.decision !== "deny") {
    await host.exitPlanMode();
    host.continueWith(AGY_PLAN_APPROVED);
  }
  return select(req.options, "allow");
}
