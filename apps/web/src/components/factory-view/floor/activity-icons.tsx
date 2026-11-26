import { Brain, FileText, Globe, type LucideIcon, Pencil, Search, Terminal } from "lucide-react";
import type { ActivityKind } from "../scene/activity";
import type { ActivityStore } from "./use-activity";
import { useActivityVersion } from "./use-activity";

/** Each kind of activity's icon, in the thought bubbles and the agent's card. */
export const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  edit: Pencil,
  run: Terminal,
  read: FileText,
  search: Search,
  web: Globe,
  think: Brain,
};

/** The agent's latest activities, newest first, for its card. */
export function RecentActivity({
  store,
  sessionId,
}: {
  store: ActivityStore;
  sessionId: string | null;
}) {
  useActivityVersion(store);
  const history = store.get(sessionId).history;
  if (history.length === 0) return null;
  return (
    <div data-testid="factory-view-floor-card-activity">
      <p className="text-muted-foreground">Latest activity</p>
      <ul className="space-y-0.5">
        {history.map((a) => {
          const Icon = ACTIVITY_ICON[a.kind];
          return (
            <li key={a.itemId} className="flex items-center gap-1">
              <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{a.text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
