import type { InboxItem } from "@agent-rishi/contracts";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCheck, Inbox } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, SectionLabel } from "@/components/common/bits";
import { DismissView, useBulkDismiss } from "@/components/inbox/bulk-dismiss";
import { FOCUSED_ENTRY, InboxEntry, inboxEntryId } from "@/components/inbox/inbox-entry";
import { ConflictCard } from "@/components/project/conflict-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useClient } from "@/lib/api";
import { groupInbox, type InboxFilter, inboxCounts, splitForDismiss } from "@/lib/inbox";
import { useSnapshot } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { PageHeader } from "./page-header";

const NO_ITEMS: InboxItem[] = [];

/** The filters conflicts are listed and counted under (`inboxCounts`). */
const conflictFilters: ReadonlySet<InboxFilter> = new Set(["all", "asks"]);

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "asks", label: "Needs an answer" },
  { id: "reviews", label: "Reviews" },
  { id: "problems", label: "Problems" },
];

const failedRuns = (n: number) => `${n} failed run${n === 1 ? "" : "s"}`;

/**
 * Bulk clean-up of the failed runs group (§11.1): dismiss the ones that don't wait on you at
 * once, with Undo. Shown while at least two would go.
 */
function DismissFailedRuns({ items }: { items: InboxItem[] }) {
  const dismiss = useBulkDismiss(failedRuns);
  const notices = splitForDismiss(items).dismiss;
  if (notices.length < 2) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-auto h-6 px-2 text-2xs text-muted-foreground"
      onClick={() => dismiss.mutate(notices)}
      disabled={dismiss.isPending}
    >
      Dismiss all
    </Button>
  );
}

/** Placeholder rows while the inbox loads: never a count or "all caught up" before it has. */
function InboxLoading() {
  return (
    <div role="status" aria-label="Loading the inbox" aria-busy className="space-y-5">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

/**
 * Inbox (§11.1): everything waiting on you, answerable in place. `focusItemId` (a toast's Open)
 * scrolls that item into view and highlights it.
 */
export function InboxPage({ focusItemId }: { focusItemId?: string }) {
  const client = useClient();
  // Not `useSnapshotData`: its empty fallback would read as "nothing waiting" until the snapshot
  // arrives (a direct load, a deep link, a slow connection), so loading is told apart (#400).
  const { data: snapshot } = useSnapshot();
  const loaded = snapshot !== undefined;
  const items = snapshot?.inbox ?? NO_ITEMS;
  const [filter, setFilter] = useState<InboxFilter>("all");
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: () => client.listConflicts() });
  const conflictList = conflicts.data ?? [];
  const groups = groupInbox(items, filter);
  const counts = inboxCounts(items, conflictList.length);
  const resolved = items.filter((i) => i.status !== "open").slice(0, 5);
  // Conflicts count under All and Needs an answer: there, nothing is listed and no count shown
  // until they're known, so the header, the tabs and the list agree.
  const countKnown = (f: InboxFilter) => loaded && !(conflictFilters.has(f) && conflicts.isPending);
  const conflictsShown = conflictFilters.has(filter);
  const showConflicts = conflictsShown && conflictList.length > 0;
  const nothingListed = groups.length === 0 && !showConflicts;
  const body =
    !loaded || (nothingListed && conflictsShown && conflicts.isPending)
      ? "loading"
      : !nothingListed
        ? "list"
        : conflictsShown && conflicts.isError
          ? "conflicts-error"
          : "empty";

  // A toast's Open: show every item, then scroll once the target has actually rendered, from
  // the snapshot or (a conflict, whose record id is its inbox item id) the conflicts query.
  // Conflicts and groups are on screen only in the list body: conflicts that load before the
  // snapshot sit behind the loading rows, and count once the list replaces them.
  useEffect(() => {
    if (focusItemId) setFilter("all");
  }, [focusItemId]);
  const focusRendered =
    focusItemId !== undefined &&
    [
      ...(body === "list" && showConflicts ? conflictList.map((c) => c.id) : []),
      ...(body === "list" ? groups.flatMap((g) => g.items.map((i) => i.id)) : []),
      ...resolved.map((i) => i.id),
    ].includes(focusItemId);
  useEffect(() => {
    if (!focusItemId || !focusRendered) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById(inboxEntryId(focusItemId))
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusItemId, focusRendered]);

  // "Dismiss N" acts on what the view lists: the active tab's groups. Its conflicts stay.
  const viewItems = body === "list" ? groups.flatMap((g) => g.items) : NO_ITEMS;
  const viewConflicts =
    body === "list" && showConflicts
      ? conflictList.map((c) => ({ id: c.id, title: `Already running: ${c.request.purpose}` }))
      : [];

  return (
    <>
      <PageHeader
        icon={<Inbox />}
        title="Inbox"
        meta={countKnown("all") ? `${counts.all} waiting on you` : "Loading…"}
        actions={<DismissView items={viewItems} alsoStaying={viewConflicts} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-6">
          <div className="mb-6 flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-card/50 p-0.5 text-xs">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground pointer-coarse:h-10",
                  filter === f.id && "bg-accent text-foreground",
                )}
              >
                {f.label}
                {countKnown(f.id) && (
                  <span className="text-3xs tabular-nums opacity-70">{counts[f.id]}</span>
                )}
              </button>
            ))}
          </div>

          {body === "loading" ? (
            <InboxLoading />
          ) : body === "conflicts-error" ? (
            <EmptyState
              icon={<AlertTriangle />}
              title="Couldn't check for merge conflicts"
              className="py-24"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void conflicts.refetch()}
                  disabled={conflicts.isFetching}
                >
                  Try again
                </Button>
              }
            >
              {conflicts.error?.message}
            </EmptyState>
          ) : body === "empty" ? (
            <EmptyState icon={<CheckCheck />} title="You're all caught up" className="py-24">
              Questions, approvals, PRs ready for review and failed runs show up here.
            </EmptyState>
          ) : (
            <div className="space-y-9">
              {showConflicts && (
                <section>
                  <SectionLabel className="mb-3">Conflicts · {conflictList.length}</SectionLabel>
                  <div className="space-y-4">
                    {conflictList.map((c) => (
                      <div
                        key={c.id}
                        id={inboxEntryId(c.id)}
                        className={cn(c.id === focusItemId && FOCUSED_ENTRY)}
                        data-focused={c.id === focusItemId || undefined}
                      >
                        <ConflictCard conflict={c} />
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {groups.map((g) => (
                <section key={g.id}>
                  <div className="mb-3 flex items-center gap-2">
                    <SectionLabel>
                      {g.title} · {g.items.length}
                    </SectionLabel>
                    {g.id === "run_failed" && <DismissFailedRuns items={g.items} />}
                  </div>
                  <div className="space-y-5">
                    {g.items.map((item) => (
                      <InboxEntry key={item.id} item={item} focused={item.id === focusItemId} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {resolved.length > 0 && (
            <section className="mt-12">
              <SectionLabel className="mb-3">Recently resolved</SectionLabel>
              <div className="space-y-3">
                {resolved.map((item) => (
                  <InboxEntry key={item.id} item={item} focused={item.id === focusItemId} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
