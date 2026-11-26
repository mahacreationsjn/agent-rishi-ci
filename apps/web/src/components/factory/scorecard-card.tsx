import type { FactoryScorecardRow, ScorecardAgent, ScorecardDays } from "@agent-rishi/contracts";
import { BarChart3 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Segmented } from "@/components/automations/form-bits";
import { ProviderMark } from "@/components/common/bits";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PROVIDER_NAMES } from "@/components/usage/format";
import { useFactoryScorecard } from "@/lib/factory";
import { useSnapshotData } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  agentLabel,
  costPerMerge,
  costPerMergeTitle,
  firstPassRate,
  medianMerge,
  mergeRate,
  type ProviderNames,
  reviseAverage,
  type ScorecardView,
  spotChecks,
  spotChecksTitle,
} from "./scorecard";

const VIEWS: Array<{ id: ScorecardView; label: string }> = [
  { id: "builders", label: "Builder" },
  { id: "reviewers", label: "Reviewer" },
  { id: "pairs", label: "Pair" },
];

const WINDOWS: Array<{ id: `${ScorecardDays}`; label: string }> = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

/** Column headings, each with what it counts on hover. */
const COLUMNS: Array<{ label: string; title: string }> = [
  { label: "Finished", title: "Work that merged or failed (from its own work) in the window" },
  { label: "Merged", title: "Merges in the window, and the share of the finished work" },
  {
    label: "First pass",
    title: "Merges that needed no revise round (no failed review or check, no revert)",
  },
  { label: "Revise rounds", title: "Revise rounds per finished item" },
  {
    label: "Reverted",
    title: "Merges reverted because CI on the default branch failed after them",
  },
  {
    label: "Spot-checks",
    title: "Merges a person spot-checked, and the problems they found",
  },
  { label: "Cost / merge", title: "What the finished work cost, failures included, per merge" },
  { label: "To merge", title: "Median time from intake to merge" },
];

/**
 * The factory scorecard (§10.1): how each builder and reviewer, by provider and model, did on
 * the work that finished in the window, so who builds and who reviews (the Agents settings) can
 * be chosen on evidence. Fetched only while open.
 */
export function ScorecardCard({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ScorecardView>("builders");
  const [days, setDays] = useState<ScorecardDays>(30);
  const { data, error } = useFactoryScorecard(projectId, days, open);
  const providers = useSnapshotData((s) => s.runner.providers, []);
  const names: ProviderNames = (id) =>
    providers.find((p) => p.id === id)?.displayName ?? PROVIDER_NAMES[id] ?? id;
  const rows = data?.[view] ?? [];

  return (
    <details
      className="group rounded-lg border border-border bg-surface text-2xs"
      data-testid="factory-scorecard"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-medium text-muted-foreground">
        <BarChart3 className="size-3.5" aria-hidden />
        Scorecard
        <span className="min-w-0 truncate font-normal text-muted-foreground/80">
          · first-pass merges, revise rounds, reverts and cost by builder and reviewer
        </span>
      </summary>
      {open && (
        <div className="space-y-2 border-t border-border p-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Group by" value={view} options={VIEWS} onChange={setView} />
            <Segmented
              label="Window"
              value={`${days}` as const}
              options={WINDOWS}
              onChange={(v) => setDays(Number(v) as ScorecardDays)}
            />
          </div>
          {error ? (
            <p className="py-4 text-center text-3xs text-status-failed">
              Couldn't load the scorecard: {error.message}
            </p>
          ) : !data || data.days !== days ? (
            <Skeleton className="h-24 w-full rounded-md" />
          ) : rows.length === 0 ? (
            <p className="py-4 text-center text-3xs text-muted-foreground/70">
              No finished factory work in the last {days} days.
            </p>
          ) : (
            <ScorecardTable rows={rows} view={view} names={names} />
          )}
          <p className="px-1 text-3xs text-muted-foreground/80">
            Each item counts for the builder and reviewer of its last attempt. Infrastructure
            failures, rejected and escalated work and the factory's own reverts don't count.
          </p>
        </div>
      )}
    </details>
  );
}

function ScorecardTable(props: {
  rows: FactoryScorecardRow[];
  view: ScorecardView;
  names: ProviderNames;
}) {
  const { rows, view, names } = props;
  const heading = VIEWS.find((v) => v.id === view)?.label ?? "";
  return (
    <Table className="text-xs" data-testid="factory-scorecard-table">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 text-2xs">
            {view === "pairs" ? "Builder → reviewer" : heading}
          </TableHead>
          {COLUMNS.map((c) => (
            <TableHead key={c.label} className="h-8 text-right text-2xs" title={c.title}>
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key} data-testid="factory-scorecard-row">
            <TableCell className="max-w-80 py-1.5">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                {view !== "reviewers" && <Agent agent={r.builder} names={names} />}
                {view === "pairs" && <span className="text-muted-foreground/60">→</span>}
                {view !== "builders" && <Agent agent={r.reviewer} names={names} />}
              </span>
            </TableCell>
            <Num>{r.finished}</Num>
            <Num>
              {r.merged} <Muted>{mergeRate(r)}</Muted>
            </Num>
            <Num title={`${r.firstPass} of ${r.merged} merges`}>{firstPassRate(r)}</Num>
            <Num title={`${r.reviseRounds} rounds over ${r.finished} items`}>
              {reviseAverage(r)}
            </Num>
            <Num className={cn(r.reverted > 0 && "text-status-failed")}>{r.reverted}</Num>
            <Num
              className={cn(r.spotProblems > 0 && "text-status-failed")}
              title={spotChecksTitle(r)}
            >
              {spotChecks(r)}
            </Num>
            <Num className="font-mono" title={costPerMergeTitle(r)}>
              {costPerMerge(r)}
            </Num>
            <Num>{medianMerge(r)}</Num>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Agent({ agent, names }: { agent: ScorecardAgent | null; names: ProviderNames }) {
  if (!agent) return <span className="text-muted-foreground">No review</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={agentLabel(agent, names)}>
      <ProviderMark provider={agent.provider} className="size-3.5 text-[8px]" />
      <span className="font-medium">{names(agent.provider)}</span>
      <span className="truncate font-mono text-2xs text-muted-foreground">
        {agent.model ?? "default model"}
      </span>
    </span>
  );
}

function Num(props: { children: ReactNode; className?: string; title?: string }) {
  return (
    <TableCell
      className={cn("py-1.5 text-right whitespace-nowrap tabular-nums", props.className)}
      title={props.title}
    >
      {props.children}
    </TableCell>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-2xs text-muted-foreground">{children}</span>;
}
