import { FACTORY_FAILURE_INBOX_PREFIX, type InboxItem } from "@agent-rishi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Factory, FileCheck, Newspaper, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { FactoryFailureActions } from "@/components/factory/failure-actions";
import { SpecDecision } from "@/components/factory/spec-approval";
import { Markdown } from "@/components/thread/markdown";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { InboxActions, PrReviewStatus } from "./inbox-actions";

const DIGEST = "inbox:factory-digest:";
const ESCALATED = "inbox:factory-escalated:";
const SPEC = "inbox:factory-spec:";

/** Which factory inbox item this is (§10.1), from the ids the factory gives them. */
export function factoryInboxKind(
  item: InboxItem,
): "digest" | "escalated" | "spec" | "failure" | null {
  if (item.id.startsWith(DIGEST)) return "digest";
  if (item.id.startsWith(ESCALATED)) return "escalated";
  if (item.id.startsWith(FACTORY_FAILURE_INBOX_PREFIX)) return "failure";
  if (item.id.startsWith(SPEC)) return "spec";
  return null;
}

function Header({ icon, label, tone }: { icon: React.ReactNode; label: string; tone: string }) {
  return (
    <div className={`flex items-center gap-2 border-b px-4 py-2 text-2xs ${tone}`}>
      {icon}
      <span className="font-semibold tracking-wider uppercase">{label}</span>
    </div>
  );
}

/** The daily factory digest: shipped, rejected, spend against budget and what waits on you. */
function DigestCard({ item }: { item: InboxItem }) {
  const client = useClient();
  const open = item.status === "open";
  const done = useMutation({
    mutationFn: () => client.resolveInbox(item.id, { status: "resolved" }),
    onSuccess: () => toast.success("Digest read"),
  });
  return (
    <div className="rounded-xl border border-border bg-card" data-testid="factory-digest">
      <Header
        icon={<Newspaper className="size-3.5" />}
        label="Factory digest"
        tone="border-border text-muted-foreground"
      />
      <div className="space-y-3 px-4 py-3">
        <h3 className="text-[14px] font-medium">{item.title.replace(/^Factory digest: /, "")}</h3>
        {item.body && (
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-[13px] scroll-thin">
            <Markdown>{item.body}</Markdown>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {item.projectId && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/projects/$projectId" params={{ projectId: item.projectId }}>
                <Factory /> Factory panel
              </Link>
            </Button>
          )}
          {open && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => done.mutate()}
              disabled={done.isPending}
            >
              Mark read
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A factory PR that touches a protected area: the factory never merges it; you decide. */
function EscalationCard({ item }: { item: InboxItem }) {
  const itemId = item.id.slice(ESCALATED.length);
  const open = item.status === "open";
  return (
    <div
      className="rounded-xl border border-status-waiting/35 bg-card"
      data-testid="factory-escalation"
    >
      <Header
        icon={<ShieldAlert className="size-3.5" />}
        label="Protected area · needs you"
        tone="border-status-waiting/20 bg-status-waiting/[0.06] text-status-waiting"
      />
      <div className="space-y-3 px-4 py-3">
        <h3 className="text-[14px] font-medium">
          {item.title.replace(/^Factory PR needs you: /, "")}
        </h3>
        {item.body && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">{item.body}</p>
        )}
        {open && <PrReviewStatus item={item} />}
        <div className="flex flex-wrap items-center gap-1.5">
          {open && <InboxActions item={item} />}
          {item.projectId && (
            <Button size="sm" variant="ghost" asChild>
              <Link
                to="/projects/$projectId/factory/$itemId"
                params={{ projectId: item.projectId, itemId }}
              >
                Merge checks
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A feature's spec waiting for your approval before it is built (spec approval on). */
function SpecCard({ item }: { item: InboxItem }) {
  const itemId = item.id.slice(SPEC.length);
  const open = item.status === "open";
  return (
    <div
      className="rounded-xl border border-status-waiting/35 bg-card"
      data-testid="factory-spec-approval"
    >
      <Header
        icon={<FileCheck className="size-3.5" />}
        label="Spec to approve · needs you"
        tone="border-status-waiting/20 bg-status-waiting/[0.06] text-status-waiting"
      />
      <div className="space-y-3 px-4 py-3">
        <h3 className="text-[14px] font-medium">{item.title.replace(/^Approve the spec: /, "")}</h3>
        {item.body && (
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-surface px-3 py-2 text-[13px] scroll-thin">
            <Markdown>{item.body}</Markdown>
          </div>
        )}
        {/* The factory raises it with the spec's version as its `updatedAt`. */}
        {open && item.projectId && (
          <SpecDecision
            projectId={item.projectId}
            itemId={itemId}
            version={item.updatedAt}
            compact
          />
        )}
        {item.projectId && (
          <Button size="sm" variant="ghost" asChild>
            <Link
              to="/projects/$projectId/factory/$itemId"
              params={{ projectId: item.projectId, itemId }}
            >
              Open the work item
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Factory inbox items (§10.1, §11.1): the daily digest, protected-area escalations and specs
 * waiting for approval.
 */
export function FactoryInboxCard({ item }: { item: InboxItem }) {
  const kind = factoryInboxKind(item);
  if (kind === "digest") return <DigestCard item={item} />;
  if (kind === "spec") return <SpecCard item={item} />;
  if (kind === "failure")
    return (
      <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
        <h3 className="text-[14px] font-medium">{item.title}</h3>
        {item.body && <p className="text-[13px] text-muted-foreground">{item.body}</p>}
        {item.status === "open" && item.projectId && (
          <div className="flex gap-1.5">
            <FactoryFailureActions
              projectId={item.projectId}
              itemId={item.id.slice(FACTORY_FAILURE_INBOX_PREFIX.length)}
              name={item.issue ? `#${item.issue.number}` : item.title}
              canDismiss={item.pr?.state !== "open" && item.pr?.state !== "draft"}
            />
          </div>
        )}
      </div>
    );
  return <EscalationCard item={item} />;
}
