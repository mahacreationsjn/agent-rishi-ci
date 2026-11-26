import { z } from "zod";
import { redactSecrets } from "./redact";
import { oneLineDescription } from "./slash-commands";

/**
 * Where an MCP server of a live session stands, as its provider reports it (§12.4, providers
 * with `capabilities.mcpStatus`):
 * - `connected`: its tools are available to the agent;
 * - `starting`: still connecting;
 * - `failed`: it didn't start or lost its connection, so the agent lacks its tools;
 * - `needs_sign_in`: it wants the user to sign in (OAuth) before it connects;
 * - `disabled`: switched off or cancelled, on purpose.
 */
export const McpServerLiveState = z.enum([
  "connected",
  "starting",
  "failed",
  "needs_sign_in",
  "disabled",
]);
export type McpServerLiveState = z.infer<typeof McpServerLiveState>;

/**
 * Where an MCP server of a live session comes from, as its provider reports it:
 * - `config`: a config file or the session's launch config (user, project, local, managed, a
 *   subagent's), so it was set up for this kind of work;
 * - `account`: a connector of the user's account with the provider (e.g. a claude.ai connector),
 *   offered to every session whether the work needs it or not;
 * - `plugin`: shipped by a plugin the user installed, likewise offered to every session;
 * - `host`: registered in-process by the program that runs the agent.
 */
export const McpServerOrigin = z.enum(["config", "account", "plugin", "host"]);
export type McpServerOrigin = z.infer<typeof McpServerOrigin>;

/** Longest provider error kept for an MCP server: one line, secrets masked. */
export const MCP_SERVER_ERROR_MAX = 300;

/**
 * One MCP server of a session and its live state (`session.updated.mcpServers`,
 * `Session.mcpServers`). Only its name, state, origin and the provider's short error: never
 * its command, URL, headers or environment.
 */
export const McpServerState = z.object({
  /** The server's name as the provider reports it, e.g. `agent-rishi` or `github`. */
  name: z.string().min(1).max(200),
  state: McpServerLiveState,
  /** Where it comes from; absent when the provider doesn't say. */
  origin: McpServerOrigin.optional(),
  /** The provider's error, first line only, secrets masked, at most `MCP_SERVER_ERROR_MAX`. */
  error: z.string().min(1).max(MCP_SERVER_ERROR_MAX).optional(),
});
export type McpServerState = z.infer<typeof McpServerState>;

/**
 * A provider's MCP error text as kept on the session: its first line with every secret-looking
 * part masked, cut to `MCP_SERVER_ERROR_MAX`. Undefined for empty text.
 */
export function mcpServerError(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = oneLineDescription(redactSecrets(text), MCP_SERVER_ERROR_MAX);
  return line || undefined;
}

/**
 * True for a server the user should hear about: the agent lacks its tools because it failed,
 * or because it waits for a sign-in to a server set up in config. An account connector or a
 * plugin's server that only needs sign-in is left out: the provider offers those to every
 * session, and one never signed into is not a problem with this work.
 */
export const mcpServerNeedsAttention = (s: Pick<McpServerState, "state" | "origin">): boolean =>
  s.state === "failed" ||
  (s.state === "needs_sign_in" && s.origin !== "account" && s.origin !== "plugin");

/** Two lists of server states that say the same (order included). */
export function sameMcpServers(
  a: readonly McpServerState[] | null | undefined,
  b: readonly McpServerState[] | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.length === b.length &&
    a.every(
      (s, i) =>
        s.name === b[i]?.name &&
        s.state === b[i]?.state &&
        s.origin === b[i]?.origin &&
        s.error === b[i]?.error,
    )
  );
}
