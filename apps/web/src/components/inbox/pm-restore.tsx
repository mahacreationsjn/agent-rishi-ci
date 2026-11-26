import { type InboxItem, InboxPmResolution, inboxResolvedByPm } from "@agent-rishi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";

/** The project manager's reason, when it dismissed the item (`resolve_inbox_item`, #673). */
export function pmDismissalReason(item: InboxItem): string | null {
  if (!inboxResolvedByPm(item)) return null;
  return InboxPmResolution.parse(item.resolution).reason;
}

/** Restore an item the project manager dismissed: it opens again in the inbox (§11.1). */
export function PmRestore({ item }: { item: InboxItem }) {
  const client = useClient();
  const restore = useMutation({
    mutationFn: async () => {
      const res = await client.restoreInbox([item.id]);
      if (res.restored === 0) throw new Error("It was changed since; reload the inbox");
      return res;
    },
    onError: (e: Error) => toast.error("Couldn't restore the item", { description: e.message }),
    onSuccess: () => toast.success("Restored to the inbox"),
  });
  if (!inboxResolvedByPm(item)) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-6 px-2 text-2xs"
      onClick={() => restore.mutate()}
      disabled={restore.isPending}
    >
      <Undo2 /> Restore
    </Button>
  );
}
