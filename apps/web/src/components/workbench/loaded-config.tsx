import type { AgentConfigFile, AgentSkill, Session } from "@agent-rishi/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, FileText, Plug, Sparkles, Webhook } from "lucide-react";
import type { ReactNode } from "react";
import { skillStateLabel, skillStateTitle } from "@/components/agents/skill-state";
import { useClient } from "@/lib/api";
import {
  type McpRow,
  mcpRows,
  mcpRowTitle,
  mcpStateDot,
  mcpStateLabel,
  mcpStatusSupported,
} from "@/lib/mcp-status";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { hookNotices, hookRows, type LoadedRow } from "./loaded-hooks";

const fileRow = (f: AgentConfigFile): LoadedRow => ({
  key: f.absolutePath,
  label: f.kind === "skill" || f.kind === "subagent" ? f.name : f.path,
  detail: `${f.scope}${f.onDemand ? " · on demand" : ""}`,
  title: f.absolutePath,
});

/** A skill, dimmed and labelled "off" when its provider's setting switches it off. */
const skillRow = (s: AgentSkill): LoadedRow => {
  const state = skillStateLabel(s);
  return {
    ...fileRow(s.file),
    label: s.name,
    detail: state ? `${s.scope} · ${state}` : s.scope,
    title: `${s.file.absolutePath}\n${skillStateTitle(s)}`,
    dim: !s.enabled,
  };
};

/** An MCP server with its live state, when its provider reported one; the error is the tooltip. */
function mcpRow(m: McpRow): LoadedRow {
  const title = mcpRowTitle(m);
  return {
    key: m.key,
    label: m.name,
    ...(m.scope ? { detail: m.scope } : {}),
    ...(title ? { title } : {}),
    ...(m.live
      ? { state: { label: mcpStateLabel[m.live.state], dot: mcpStateDot[m.live.state] } }
      : {}),
  };
}

/**
 * What the session's provider loads into its context from its working directory (§12.4), with
 * each MCP server's live state where the provider reports it (`capabilities.mcpStatus`).
 */
export function LoadedConfig({ session }: { session: Session }) {
  const client = useClient();
  const sessionId = session.id;
  const loaded = useQuery({
    queryKey: ["agent-config-loaded", sessionId],
    queryFn: () => client.agentConfig.loaded(sessionId),
  });
  const provider = useSnapshotData(
    (s) => s.runner.providers.find((p) => p.id === session.provider),
    undefined,
  );
  const live = mcpStatusSupported(provider) ? session.mcpServers : null;
  const d = loaded.data;
  const project = session.projectId ?? "global";
  // The provider reports the hooks that ran, so each run shows in the transcript.
  const hookRuns = provider?.capabilities.hookRuns === true;
  return (
    <section className="space-y-2" data-testid="loaded-config">
      <div className="flex items-baseline justify-between">
        <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">
          What's loaded
        </h3>
        <Link
          to="/agents"
          search={{ tab: "memory", project }}
          className="text-3xs text-muted-foreground hover:text-foreground"
        >
          Edit configuration
        </Link>
      </div>
      {loaded.error && (
        <p className="text-2xs text-status-failed">{(loaded.error as Error).message}</p>
      )}
      {d && (
        <p className="truncate font-mono text-3xs text-muted-foreground" title={d.cwd}>
          {d.provider} · from {d.cwd}
        </p>
      )}
      <LoadedList
        icon={<FileText />}
        title="Memory"
        loading={loaded.isLoading}
        rows={(d?.memory ?? []).map(fileRow)}
      />
      <LoadedList
        icon={<Sparkles />}
        title="Skills"
        loading={loaded.isLoading}
        rows={(d?.skills ?? []).map(skillRow)}
        testId="loaded-skills"
        action={
          <Link
            to="/agents"
            search={{ tab: "skills", project }}
            className="text-3xs hover:text-foreground"
          >
            Switch skills
          </Link>
        }
      />
      <LoadedList
        icon={<Bot />}
        title="Subagents"
        loading={loaded.isLoading}
        rows={(d?.subagents ?? []).map(fileRow)}
      />
      <LoadedList
        icon={<Plug />}
        title="MCP servers"
        loading={loaded.isLoading}
        rows={mcpRows(d?.mcpServers ?? [], live).map(mcpRow)}
        testId="loaded-mcp"
      />
      {/* Only for providers whose native config has hooks (null otherwise). */}
      {d?.hooks && (
        <LoadedList
          icon={<Webhook />}
          title="Hooks"
          loading={false}
          rows={hookRows(d.hooks)}
          notices={hookNotices(d.hooks)}
          hint={hookRuns ? "Each run shows in the transcript, with its outcome." : undefined}
          testId="loaded-hooks"
          action={
            <Link
              to="/agents"
              search={{ tab: "hooks", project }}
              className="text-3xs hover:text-foreground"
            >
              Edit hooks
            </Link>
          }
        />
      )}
    </section>
  );
}

function LoadedList({
  icon,
  title,
  rows,
  loading,
  notices,
  hint,
  action,
  testId,
}: {
  icon: ReactNode;
  title: string;
  rows: LoadedRow[];
  loading: boolean;
  /** Warnings shown above the rows. */
  notices?: ReactNode;
  /** A quiet line below the rows. */
  hint?: string;
  /** A link in the header, before the count. */
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-border" data-testid={testId}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-2xs text-muted-foreground [&_svg]:size-3.5">
        {icon} {title}
        <span className="ml-auto flex items-baseline gap-2">
          {action}
          <span className="tabular-nums">{loading ? "…" : rows.length}</span>
        </span>
      </div>
      {notices}
      <div className="px-3 py-1.5">
        {!loading && rows.length === 0 && (
          <div className="py-0.5 text-[11.5px] text-muted-foreground">None</div>
        )}
        {rows.map((r) => (
          <div key={r.key} className={cn("py-0.5", r.dim && "opacity-50")} title={r.title}>
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/80">
                {r.label}
              </span>
              {r.detail && (
                <span className="shrink-0 text-3xs text-muted-foreground">{r.detail}</span>
              )}
              {r.state && (
                <span
                  className="inline-flex shrink-0 items-center gap-1 text-3xs text-muted-foreground"
                  data-testid="mcp-state"
                >
                  <span className={cn("size-1.5 rounded-full", r.state.dot)} />
                  {r.state.label}
                </span>
              )}
            </div>
            {r.sub && (
              <div className="truncate font-mono text-3xs text-muted-foreground">{r.sub}</div>
            )}
          </div>
        ))}
      </div>
      {hint && (
        <div className="border-t border-border px-3 py-1 text-3xs text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  );
}
