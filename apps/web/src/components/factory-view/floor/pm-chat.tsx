import { Link } from "@tanstack/react-router";
import { Bot, Minus } from "lucide-react";
import type { CSSProperties, Ref } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { cn } from "@/lib/utils";
import { QuickChat } from "../quick-chat";

/**
 * The PM chat as part of the floor (#264, #420): docked beside the scene on wide screens, over it
 * on narrower ones. Inside it is the usual quick chat, so the composer is the normal one and the
 * messages scroll.
 */
export function PmChat({
  projectId,
  onFold,
  className,
  style,
  ref,
}: {
  projectId: string;
  onFold: () => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
}) {
  const session = useRoleSession("pm", projectId);
  const busy = session?.status === "running" || session?.status === "starting";
  return (
    <aside
      ref={ref}
      aria-label="Project manager chat"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-md",
        className,
      )}
      style={style}
      data-testid="factory-view-pm-chat"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5 text-xs">
        <Bot className="size-3.5 text-primary" aria-hidden />
        <h2 className="font-medium">PM chat</h2>
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            busy ? "bg-status-running motion-safe:animate-pulse" : "bg-status-idle",
          )}
        />
        {busy && <span className="text-2xs text-muted-foreground">answering…</span>}
        <Link
          to="/projects/$projectId/pm"
          params={{ projectId }}
          className="ml-auto text-2xs text-primary hover:underline"
        >
          Full chat
        </Link>
        <button
          type="button"
          onClick={onFold}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Fold the PM chat"
          data-testid="factory-view-pm-chat-fold"
        >
          <Minus className="size-3.5" aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <QuickChat projectId={projectId} header={false} />
      </div>
    </aside>
  );
}
