import {
  type FactorySpotCheckRequestInit,
  type FactorySpotCheckResponse,
  type GitHubPrRef,
  githubPrId,
  SPOT_CHECK_NOTE_MAX,
} from "@agent-rishi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FilePlus2, GitPullRequest, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { PrDetailsView } from "@/components/github/pr-details";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";

/**
 * A person's spot-check of a merge (§10.1): read the change in the PR view, then **Looks good** or
 * **Found a problem** with a note, which can become a follow-up issue. Used on the factory panel's
 * Spot-checks list and on the item page.
 */

/** Record a decision; the panel and the item page refresh, and a GitHub failure is said plainly. */
function useSpotCheck(projectId: string, itemId: string) {
  const client = useClient();
  const queryClient = useQueryClient();
  const done = (res: FactorySpotCheckResponse, success: string) => {
    if (res.issueError) {
      toast.warning("Recorded, but the issue wasn't filed", {
        description: `${res.issueError}. Use File issue to try again.`,
      });
    } else {
      toast.success(success);
    }
    void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
  };
  const fail = (title: string) => (e: Error) => {
    toast.error(title, { description: e.message });
    // Decided or withdrawn meanwhile: show it as it is now.
    void queryClient.invalidateQueries({ queryKey: factoryKeys.all });
  };
  const decide = useMutation({
    mutationFn: (req: FactorySpotCheckRequestInit) =>
      client.factory.spotCheck(projectId, itemId, req),
    onSuccess: (res, req) =>
      done(
        res,
        req.verdict === "looks_good"
          ? "Spot-check recorded: looks good"
          : res.item.spotCheck?.issue
            ? `Problem recorded and filed as #${res.item.spotCheck.issue.number}`
            : "Problem recorded",
      ),
    onError: fail("Couldn't record the spot-check"),
  });
  const fileIssue = useMutation({
    mutationFn: () => client.factory.fileSpotCheckIssue(projectId, itemId),
    onSuccess: (res) =>
      done(res, `Filed as #${res.item.spotCheck?.issue?.number ?? "?"}: the factory takes it on`),
    onError: fail("Couldn't file the issue"),
  });
  return { decide, fileIssue };
}

/**
 * The merged PR in the PR view (every changed file with its diff), in a dialog whose footer
 * records the spot-check, so you decide where you read the change. It closes once recorded.
 */
export function OpenPrButton({
  projectId,
  pr,
  itemId,
  title,
}: {
  projectId: string;
  pr: GitHubPrRef;
  /** The spot-checked item and its title, for the decision. */
  itemId: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <GitPullRequest /> Open PR
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex max-h-[85vh] flex-col sm:max-w-4xl"
          // Focus the dialog, not its first button: while the PR view loads that is Looks
          // good, and a stray Enter would record it unread.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Pull request #{pr.number}</DialogTitle>
            <DialogDescription className="truncate">{title}</DialogDescription>
          </DialogHeader>
          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 scroll-thin">
            {open && <PrDetailsView prId={githubPrId(projectId, pr.number)} />}
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-2xs text-muted-foreground">
              Read the change, then record what you found.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <SpotCheckDecision
                projectId={projectId}
                itemId={itemId}
                title={title}
                size="sm"
                onDecided={() => setOpen(false)}
              />
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Looks good, or Found a problem (a dialog for the note and the follow-up issue). */
export function SpotCheckDecision({
  projectId,
  itemId,
  title,
  size = "xs",
  onDecided,
}: {
  projectId: string;
  itemId: string;
  /** The item's title, for the dialog. */
  title: string;
  size?: "xs" | "sm";
  /** Called once the decision is recorded (the PR dialog closes). */
  onDecided?: () => void;
}) {
  const { decide } = useSpotCheck(projectId, itemId);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [fileIssue, setFileIssue] = useState(true);
  const switchId = useId();
  const text = note.trim();
  return (
    <>
      <Button
        size={size}
        variant="outline"
        onClick={() => decide.mutate({ verdict: "looks_good" }, { onSuccess: onDecided })}
        disabled={decide.isPending}
      >
        <Check /> Looks good
      </Button>
      <Button
        size={size}
        variant="outline"
        onClick={() => setAsking(true)}
        disabled={decide.isPending}
      >
        <TriangleAlert /> Found a problem
      </Button>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Found a problem</DialogTitle>
            <DialogDescription>
              What's wrong with "{title}"? It's recorded on the item and counts against its builder
              and reviewer in the scorecard.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={SPOT_CHECK_NOTE_MAX}
            placeholder="What you found, specific enough for an agent to fix it"
            aria-label="What you found"
            className="min-h-28 text-[13px]"
            autoFocus
          />
          <label htmlFor={switchId} className="flex items-start gap-2 text-xs">
            <Switch
              id={switchId}
              checked={fileIssue}
              onCheckedChange={setFileIssue}
              className="mt-0.5"
            />
            <span>
              File a follow-up issue with this note
              <span className="block text-3xs text-muted-foreground">
                Labelled for the factory, which takes it on as new work.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                decide.mutate(
                  { verdict: "problem", note: text, fileIssue },
                  {
                    onSuccess: () => {
                      setAsking(false);
                      setNote("");
                      onDecided?.();
                    },
                  },
                )
              }
              disabled={decide.isPending || !text}
            >
              {decide.isPending ? "Recording…" : "Record problem"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "File issue" for a problem recorded without its follow-up issue. */
export function FileSpotCheckIssueButton({
  projectId,
  itemId,
}: {
  projectId: string;
  itemId: string;
}) {
  const { fileIssue } = useSpotCheck(projectId, itemId);
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => fileIssue.mutate()}
      disabled={fileIssue.isPending}
    >
      <FilePlus2 /> {fileIssue.isPending ? "Filing…" : "File issue"}
    </Button>
  );
}
