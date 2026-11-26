import type { GithubIssue, InboxItem, RawEventEnvelope } from "@agent-rishi/contracts";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";

/**
 * Triage decisions settle when their issue closes (§11.1): an open "Should I take this on?"
 * item resolves, with a note, once GitHub sync sees its issue closed. It stays in the inbox's
 * history. A reopened issue doesn't bring it back; the next triage run raises it again.
 *
 * The pass runs at startup, which also settles items left from before this rule, and shortly
 * after GitHub sync changes issues or a triage item is raised.
 */
export interface TriageSettlerDeps {
  store: EventStore;
  inbox: InboxService;
  /** The synced issue, if GitHub sync knows it. */
  issue: (projectId: string, number: number) => Pick<GithubIssue, "number" | "state"> | undefined;
  /** How long after a change the pass runs, so a burst of events runs it once (default 1 s). */
  debounceMs?: number;
  log?: (message: string) => void;
}

/** Events after which an open triage item's issue may have closed. */
const RELEVANT = new Set([
  "github.synced",
  "issue.opened",
  "issue.labeled",
  "issue.updated",
  "issue.commented",
]);

/** A triage item raised or raised again: its issue may already be closed. */
function isOpenTriage(item: InboxItem | undefined): boolean {
  return item?.kind === "triage" && item.status === "open";
}

export class TriageSettler {
  private unsubscribe: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly deps: TriageSettlerDeps) {}

  start(): void {
    this.stopped = false;
    this.unsubscribe = this.deps.store.subscribe((events) => this.onEvents(events));
    setImmediate(() => {
      if (!this.stopped) this.sweepSafely();
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolve every open triage item whose issue is closed; returns the resolved items. */
  sweep(): InboxItem[] {
    const settled: InboxItem[] = [];
    for (const item of this.deps.inbox.list()) {
      if (item.kind !== "triage" || !item.projectId || !item.issue) continue;
      const issue = this.deps.issue(item.projectId, item.issue.number);
      if (issue?.state !== "closed") continue;
      settled.push(
        this.deps.inbox.settle(item, {
          by: "agent-rishi",
          note: `Issue #${issue.number} was closed on GitHub`,
        }),
      );
    }
    if (settled.length) {
      this.deps.log?.(`inbox: resolved ${settled.length} triage decision(s) whose issue closed`);
    }
    return settled;
  }

  private onEvents(events: RawEventEnvelope[]): void {
    if (this.stopped || this.timer) return;
    const relevant = events.some(
      (e) =>
        RELEVANT.has(e.type) ||
        ((e.type === "inbox.created" || e.type === "inbox.updated") &&
          isOpenTriage((e.payload as { item?: InboxItem }).item)),
    );
    if (!relevant) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.sweepSafely();
    }, this.deps.debounceMs ?? 1000);
    this.timer.unref?.();
  }

  private sweepSafely(): void {
    try {
      this.sweep();
    } catch (error) {
      this.deps.log?.(`inbox: settling triage decisions failed: ${errorMessage(error)}`);
    }
  }
}
