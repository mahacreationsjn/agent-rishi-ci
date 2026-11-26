import type { FactorySpotChecks, SpotCheckEntry } from "@agent-rishi/contracts";
import { Link } from "@tanstack/react-router";
import { Check, Eye, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ago } from "@/lib/format";
import { platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { FileSpotCheckIssueButton, OpenPrButton, SpotCheckDecision } from "./spot-check-actions";
import {
  SPOT_CHECK_REASON,
  SPOT_CHECKS_ANCHOR,
  showSpotChecks,
  spotCheckProblemText,
  spotCheckShareText,
} from "./spot-checks";

/**
 * The factory panel's Spot-checks list (§10.1): the merges set aside for a person's quick look,
 * each with its item, its PR view and the reviewer's verdict, and **Looks good** / **Found a
 * problem**; below them the checks recorded lately. Nothing in the factory waits on them. Open
 * while something waits; hidden while spot-checks are off and there is nothing to show. Its id is
 * `SPOT_CHECKS_ANCHOR`; with `focus` (the page was opened at that anchor) it opens and scrolls
 * into view, so the first merge waiting for a look is on screen.
 */
export function SpotChecksCard({
  projectId,
  spotChecks,
  focus = false,
}: {
  projectId: string;
  spotChecks: FactorySpotChecks;
  focus?: boolean;
}) {
  const [open, setOpen] = useState(focus || spotChecks.outstanding > 0);
  const ref = useRef<HTMLDetailsElement>(null);
  // The card renders once the factory status is in, after the router's own scroll to the
  // anchor ran, so it scrolls itself there.
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    const frame = requestAnimationFrame(() =>
      ref.current?.scrollIntoView?.({ block: "start", behavior: "auto" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  if (!showSpotChecks(spotChecks)) return null;
  const { pending, recent, outstanding } = spotChecks;
  return (
    <details
      ref={ref}
      id={SPOT_CHECKS_ANCHOR}
      className="group scroll-mt-3 rounded-lg border border-border bg-surface text-2xs"
      data-testid="factory-spot-checks"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-medium text-muted-foreground">
        <Eye className="size-3.5" aria-hidden />
        Spot-checks
        <span className="min-w-0 truncate font-normal text-muted-foreground/80">
          · {spotCheckShareText(spotChecks.percent)}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded-full px-1.5 tabular-nums",
            outstanding > 0 && "bg-status-waiting/12 text-status-waiting",
          )}
          title="Merges waiting for a look"
        >
          {outstanding} to check
        </span>
      </summary>
      <div className="space-y-2 border-t border-border p-2">
        <p className="px-1 text-3xs text-muted-foreground" data-testid="spot-check-share">
          {spotCheckProblemText(spotChecks)}. Read the change in the PR view, then record what you
          found; nothing in the factory waits on it.
        </p>
        {pending.length === 0 ? (
          <p className="py-2 text-center text-3xs text-muted-foreground/70">
            Nothing to spot-check right now.
          </p>
        ) : (
          <ul className="space-y-1">
            {pending.map((e) => (
              <PendingRow key={e.itemId} projectId={projectId} entry={e} />
            ))}
            {outstanding > pending.length && (
              <li className="px-2 text-3xs text-muted-foreground">
                and {outstanding - pending.length} older merge
                {outstanding - pending.length === 1 ? "" : "s"}
              </li>
            )}
          </ul>
        )}
        {recent.length > 0 && (
          <div>
            <p className="px-1 pt-1 pb-0.5 text-3xs font-medium text-muted-foreground">
              Checked lately
            </p>
            <ul className="space-y-0.5">
              {recent.map((e) => (
                <CheckedRow key={e.itemId} projectId={projectId} entry={e} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}

function ItemTitle({ projectId, entry }: { projectId: string; entry: SpotCheckEntry }) {
  return (
    <Link
      to="/projects/$projectId/factory/$itemId"
      params={{ projectId, itemId: entry.itemId }}
      className="truncate text-[12.5px] font-medium text-foreground/90 hover:underline"
    >
      {entry.title}
    </Link>
  );
}

function PendingRow({ projectId, entry }: { projectId: string; entry: SpotCheckEntry }) {
  const reason = SPOT_CHECK_REASON[entry.check.reason];
  return (
    <li
      className="space-y-1 rounded-md border border-border/60 bg-card px-2 py-1.5"
      data-testid="spot-check-pending"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ItemTitle projectId={projectId} entry={entry} />
        <span
          className="shrink-0 rounded-full bg-muted px-1.5 text-3xs text-muted-foreground"
          title={reason.title}
        >
          {reason.label}
        </span>
        <span className="ml-auto shrink-0 text-3xs text-muted-foreground">
          {entry.pr && `#${entry.pr.number} · `}merged{" "}
          {ago(entry.mergedAt ?? entry.check.sampledAt)}
        </span>
      </div>
      <p className="line-clamp-2 text-3xs text-muted-foreground" title={entry.verdict?.summary}>
        {entry.verdict ? (
          <>
            <span className="font-medium text-foreground/80">
              Reviewer: {entry.verdict.verdict.replace("_", " ")}
            </span>{" "}
            · {entry.verdict.summary}
          </>
        ) : (
          "No agent review (a docs-only change)"
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1">
        {entry.pr && (
          <OpenPrButton
            projectId={projectId}
            pr={entry.pr}
            itemId={entry.itemId}
            title={entry.title}
          />
        )}
        <SpotCheckDecision projectId={projectId} itemId={entry.itemId} title={entry.title} />
      </div>
    </li>
  );
}

function CheckedRow({ projectId, entry }: { projectId: string; entry: SpotCheckEntry }) {
  const { check } = entry;
  const problem = check.state === "problem";
  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1 hover:bg-accent/40"
      data-testid="spot-check-recent"
    >
      {problem ? (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-failed" aria-hidden />
      ) : (
        <Check className="mt-0.5 size-3.5 shrink-0 text-status-done" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <ItemTitle projectId={projectId} entry={entry} />
          <span className="shrink-0 text-3xs text-muted-foreground">
            {problem ? "found a problem" : "looks good"}
            {check.checkedAt && ` · ${ago(check.checkedAt)}`}
          </span>
        </span>
        {check.note && (
          <span className="block truncate text-3xs text-muted-foreground" title={check.note}>
            {check.note}
          </span>
        )}
      </span>
      {problem &&
        (check.issue ? (
          <button
            type="button"
            className="shrink-0 text-3xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => check.issue && platform.openExternal(check.issue.url)}
          >
            #{check.issue.number}
          </button>
        ) : (
          <FileSpotCheckIssueButton projectId={projectId} itemId={entry.itemId} />
        ))}
    </li>
  );
}
