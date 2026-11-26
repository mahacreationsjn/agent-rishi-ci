import type { LinkSafetyModalProps } from "streamdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyWithFeedback } from "@/lib/copy";

/**
 * A link in Markdown shows where it really goes before it opens (#317): agent replies and
 * GitHub text can label a link with anything.
 */
export function LinkConfirmDialog({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open this link?</DialogTitle>
          <DialogDescription>Check where it goes. It opens outside Agent Rishi.</DialogDescription>
        </DialogHeader>
        <p className="break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[12.5px] text-foreground">
          {url}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void copyWithFeedback(url, "Link copied")}>
            Copy link
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            Open link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
