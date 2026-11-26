import { INBOX_BULK_MAX, type InboxItem } from "@agent-rishi/contracts";
import { useMutation } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { type AgentRishiClient, useClient } from "@/lib/api";
import { splitForDismiss } from "@/lib/inbox";

/** How long a bulk dismiss can be undone from its toast. */
export const UNDO_MS = 10_000;

/** How many of the items that stay the confirmation names. */
const NAMED = 5;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const notices = (n: number) => count(n, "notice");

/** "3 items that wait on you stay" (or "1 item that waits on you stays"). */
function stayLine(n: number): string {
  return n === 1 ? "1 item that waits on you stays" : `${n} items that wait on you stay`;
}

/** A toast's line for the items the server kept: "3 items that wait on you stay.", or none. */
function keptLine(kept: number): string | undefined {
  return kept > 0 ? `${stayLine(kept)}.` : undefined;
}

/** `message` ending as a sentence, so another can follow it. */
function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

/** `ids` split into requests the server accepts (at most {@link INBOX_BULK_MAX} each). */
function batches(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += INBOX_BULK_MAX) out.push(ids.slice(i, i + INBOX_BULK_MAX));
  return out;
}

/**
 * Undo from the toast: reopens exactly what the dismiss closed (`POST /api/inbox/restore`). When
 * a later request fails, the toast still says what the earlier ones reopened.
 */
async function undo(client: AgentRishiClient, ids: string[], what: (n: number) => string) {
  let restored = 0;
  try {
    for (const batch of batches(ids)) restored += (await client.restoreInbox(batch)).restored;
    toast.success(`Restored ${what(restored)}`);
  } catch (e) {
    const message =
      restored > 0
        ? `Restored ${what(restored)}, then couldn't restore the rest`
        : "Couldn't undo the dismiss";
    toast.error(message, { description: (e as Error).message });
  }
}

/** What a bulk dismiss did, over all its requests; `error` when a later request failed. */
interface BulkResult {
  dismissed: number;
  ids: string[];
  kept: number;
  error?: Error;
}

/**
 * Dismiss several items (§11.1), then a toast with **Undo** for {@link UNDO_MS}. More than
 * {@link INBOX_BULK_MAX} go in several requests, so every item counted is dismissed. Undo needs
 * nothing from the component, so it still works once the dismissed items (and this button with
 * them) are gone. `what` names the items: "6 notices".
 */
export function useBulkDismiss(what: (n: number) => string) {
  const client = useClient();
  return useMutation({
    mutationFn: async (items: InboxItem[]): Promise<BulkResult> => {
      const total: BulkResult = { dismissed: 0, ids: [], kept: 0 };
      for (const batch of batches(items.map((i) => i.id))) {
        try {
          const res = await client.dismissInbox(batch);
          total.dismissed += res.dismissed;
          total.ids.push(...res.ids);
          total.kept += res.kept;
        } catch (e) {
          // Some already went: keep their Undo rather than only reporting the failure.
          if (total.ids.length === 0) throw e;
          return { ...total, error: e as Error };
        }
      }
      return total;
    },
    onError: (e: Error) => toast.error("Couldn't dismiss them", { description: e.message }),
    onSuccess: (res) => {
      const kept = keptLine(res.kept);
      if (res.dismissed === 0) {
        toast.warning("Nothing was dismissed", { description: kept });
        return;
      }
      const action = { label: "Undo", onClick: () => void undo(client, res.ids, what) };
      if (res.error) {
        // The reason first, then what the requests that went through kept, as on success.
        const reason = res.error.message;
        toast.error(`Dismissed ${what(res.dismissed)}, then couldn't dismiss the rest`, {
          description: kept ? `${sentence(reason)} ${kept}` : reason,
          action,
          duration: UNDO_MS,
        });
        return;
      }
      toast.success(`Dismissed ${what(res.dismissed)}`, {
        description: kept,
        action,
        duration: UNDO_MS,
      });
    },
  });
}

/** An item that stays, as the confirmation names it. */
export interface StayingItem {
  id: string;
  title: string;
}

/**
 * The inbox header's **Dismiss N** (§11.1): dismisses the notices in the current view (`items`,
 * what the active tab lists) after a short confirmation that names what stays. Items that wait
 * on the user stay, with the view's conflicts (`alsoStaying`). Hidden when nothing would go.
 */
export function DismissView({
  items,
  alsoStaying = [],
}: {
  items: InboxItem[];
  alsoStaying?: StayingItem[];
}) {
  const [confirming, setConfirming] = useState(false);
  const bulk = useBulkDismiss(notices);
  const { dismiss, stay } = splitForDismiss(items);
  const staying: StayingItem[] = [...alsoStaying, ...stay];
  const n = dismiss.length;
  if (n === 0) return null;
  const named = staying.slice(0, NAMED);
  const more = staying.length - named.length;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground"
        title={`Dismiss the ${notices(n)} in this view`}
        onClick={() => setConfirming(true)}
        disabled={bulk.isPending}
      >
        <CheckCheck /> Dismiss {n}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss {notices(n)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {notices(n)} will be dismissed
              {staying.length > 0 ? `; ${stayLine(staying.length)}.` : "."} You can undo it for a
              few seconds.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {named.length > 0 && (
            <div className="min-w-0 text-[13px]" data-testid="dismiss-staying">
              <div className="mb-1.5 text-2xs text-muted-foreground">Staying</div>
              <ul className="space-y-1">
                {named.map((s) => (
                  <li key={s.id} className="truncate">
                    {s.title}
                  </li>
                ))}
              </ul>
              {more > 0 && <div className="mt-1 text-muted-foreground">and {more} more</div>}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => bulk.mutate(dismiss)}>Dismiss {n}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
