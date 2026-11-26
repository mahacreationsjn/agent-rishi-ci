import type { FactoryStatus, Session, WorkSummary } from "@agent-rishi/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { isActive } from "@/lib/format";

export function projectActivity(
  factory: FactoryStatus,
  work: readonly WorkSummary[],
  sessions: readonly Session[],
) {
  const owned = new Set<string>();
  const ownedPrs = new Set<string>();
  for (const item of [
    ...factory.backlog,
    ...factory.inProgress,
    ...factory.recent,
    ...factory.viewRecent,
  ]) {
    for (const id of [item.activeSessionId, item.sessionId, item.reviewerSessionId]) {
      if (id) owned.add(id);
    }
    if (item.ownedPr) ownedPrs.add(item.ownedPr.url);
  }
  if (factory.scout?.sessionId) owned.add(factory.scout.sessionId);
  for (const lens of factory.scout?.lenses ?? []) owned.add(lens.sessionId);

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const active = work.filter((entry) => {
    if (entry.projectId !== factory.projectId) return false;
    if (!entry.sessionId) return true;
    const status = byId.get(entry.sessionId)?.status;
    return !status || isActive(status);
  });
  const replaced = new Set(
    sessions
      .filter((s) => s.projectId === factory.projectId && s.forkedFrom?.kind === "handoff")
      .flatMap((s) => (s.forkedFrom ? [s.forkedFrom.sessionId] : [])),
  );
  const activity = new Map<
    string,
    {
      work: WorkSummary;
      session?: Session;
      issue: Session["issue"];
      pr: Session["pr"];
      review: boolean;
    }
  >();
  for (const entry of active) {
    if (entry.sessionId && (owned.has(entry.sessionId) || replaced.has(entry.sessionId))) continue;
    const session = entry.sessionId ? byId.get(entry.sessionId) : undefined;
    const origin = session?.forkedFrom;
    const parent =
      origin?.kind === "review" || origin?.kind === "handoff"
        ? byId.get(origin.sessionId)
        : undefined;
    const issue = session?.issue ?? parent?.issue ?? null;
    const pr = session?.pr ?? parent?.pr ?? null;
    if (pr && ownedPrs.has(pr.url)) continue;
    const review = origin?.kind === "review";
    const key = pr?.url ?? issue?.url ?? entry.id;
    const previous = activity.get(key);
    if (
      previous &&
      ((previous.review && !review) ||
        (previous.review === review && previous.work.startedAt >= entry.startedAt))
    )
      continue;
    activity.set(key, { work: entry, session, issue, pr, review });
  }
  return [...activity.values()];
}

export function ProjectActivity({
  factory,
  work,
  sessions,
  loaded,
  refreshing,
}: {
  factory: FactoryStatus;
  work: readonly WorkSummary[];
  sessions: readonly Session[];
  loaded: boolean;
  refreshing: boolean;
}) {
  const outside = useMemo(
    () => projectActivity(factory, work, sessions),
    [factory, work, sessions],
  );
  const factoryWorking =
    factory.inProgress.length > 0 || Boolean(factory.scout && factory.scout.phase !== "idle");
  if (outside.length === 0 && factoryWorking) return null;
  const title = factoryWorking
    ? "Other project activity"
    : outside.length
      ? "No factory-owned work in progress"
      : !loaded || refreshing
        ? "Checking project activity…"
        : factory.backlog.length
          ? "No active project work · Factory work is queued"
          : "No active project work";
  return (
    <section aria-label="Project activity" className="border-b border-border px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span role="status" className="font-medium">
          {title}
        </span>
        {outside.length > 0 && (
          <Link
            to="/projects/$projectId"
            params={{ projectId: factory.projectId }}
            hash="project-now"
            className="text-primary hover:underline"
          >
            View project activity
          </Link>
        )}
      </div>
      {outside.length > 0 && (
        <ul className="mt-1 flex max-h-24 flex-wrap gap-x-4 gap-y-1 overflow-y-auto text-muted-foreground">
          {outside.map(({ work: entry, session, issue, pr, review }) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-1">
              {issue && (
                <a className="hover:underline" href={issue.url}>
                  Issue #{issue.number}
                </a>
              )}
              {pr && (
                <a className="hover:underline" href={pr.url}>
                  PR #{pr.number}
                </a>
              )}
              {entry.sessionId ? (
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: entry.sessionId }}
                  className="hover:underline"
                >
                  {review ? "Reviewer: " : issue || pr ? "Work session: " : ""}
                  {session?.title ?? entry.purpose}
                </Link>
              ) : (
                entry.purpose
              )}
              {entry.status === "queued" && <span>Queued</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
