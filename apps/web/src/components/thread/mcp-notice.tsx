import type { McpServerState, Session } from "@agent-rishi/contracts";
import { Link } from "@tanstack/react-router";
import { PlugZap, X } from "lucide-react";
import { dismissMcpProblems, useUndismissedMcpProblems } from "@/lib/mcp-dismissals";
import {
  AGENT_RISHI_MCP_SERVER,
  mcpProblems,
  mcpStateLabel,
  mcpStatusSupported,
} from "@/lib/mcp-status";
import { useSnapshotData } from "@/lib/queries";

/** "db (failed)", with the provider's error as the tooltip. */
function ServerName({ server }: { server: McpServerState }) {
  return (
    <span title={server.error} className="whitespace-nowrap">
      <span className="font-mono">{server.name}</span>{" "}
      <span className="opacity-80">({mcpStateLabel[server.state]})</span>
    </span>
  );
}

/**
 * Below the thread header: the session's MCP servers whose tools the agent lacks (failed, or
 * a configured server waiting for sign-in), as its provider reports them
 * (`capabilities.mcpStatus`), and how to fix them. Goes away once they connect. Dismiss is
 * remembered in this browser for the project (for Agent Rishi's own server, the session): only a
 * server newly in trouble brings the notice back.
 */
export function McpNotice({ session }: { session: Session }) {
  const provider = useSnapshotData(
    (s) => s.runner.providers.find((p) => p.id === session.provider),
    undefined,
  );
  const problems = useUndismissedMcpProblems(
    session,
    mcpProblems(session, mcpStatusSupported(provider)),
  );
  if (problems.length === 0) return null;

  const signIn = problems.some((s) => s.state === "needs_sign_in");
  const failed = problems.some((s) => s.state === "failed");
  const ownTools = problems.some((s) => s.name === AGENT_RISHI_MCP_SERVER);
  const providerName = provider?.displayName ?? "the agent";
  const count = problems.length;
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-status-waiting/30 bg-status-waiting/[0.06] px-4 py-2 text-2xs text-status-waiting"
      data-testid="mcp-notice"
    >
      <PlugZap className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-foreground/90">
          {count === 1 ? "An MCP server isn't" : `${count} MCP servers aren't`} available to the
          agent, so it can't use {count === 1 ? "its" : "their"} tools:{" "}
          {problems.map((s, i) => (
            <span key={s.name}>
              {i > 0 && ", "}
              <ServerName server={s} />
            </span>
          ))}
          .
        </p>
        <p className="text-muted-foreground">
          {failed && (
            <>
              Check {count === 1 ? "it" : "them"} in{" "}
              <Link
                to="/agents"
                search={{ tab: "mcp", project: session.projectId ?? "global" }}
                className="underline underline-offset-2 hover:text-foreground"
              >
                Agents › MCP servers
              </Link>
              {signIn ? ". " : " (hover a server for its error)."}
            </>
          )}
          {signIn && <>Sign in through {providerName}'s own login for that server.</>}
          {ownTools && (
            <>
              {" "}
              Without Agent Rishi's own server (agent-rishi) the agent can't ask you questions or
              report back here; fork the session to carry on with a fresh agent.
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={() => dismissMcpProblems(session, problems)}
        className="-m-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Dismiss"
        title={
          ownTools && count === 1
            ? "Hide for this session"
            : "Hide for these servers in this project"
        }
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
