import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { useRetryItem } from "./use-retry-item";

export function FactoryFailureActions({
  projectId,
  itemId,
  name,
  canDismiss,
}: {
  projectId: string;
  itemId: string;
  name: string;
  canDismiss: boolean;
}) {
  const retry = useRetryItem(projectId, itemId);
  const client = useClient();
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => client.factory.dismiss(projectId, itemId),
    onSuccess: () => {
      toast.success(`${name} dismissed`);
      void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
    },
    onError: (e) => toast.error("Couldn't dismiss", { description: e.message }),
  });
  const busy = retry.isPending || dismiss.isPending;
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => retry.mutate()}
        disabled={busy}
        aria-label={`Retry ${name}`}
      >
        <RotateCcw /> Retry
      </Button>
      {canDismiss && (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => dismiss.mutate()}
          disabled={busy}
          aria-label={`Dismiss ${name}`}
        >
          <X /> Dismiss
        </Button>
      )}
    </>
  );
}
