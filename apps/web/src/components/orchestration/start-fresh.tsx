import type { Session } from "@agent-rishi/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive } from "lucide-react";
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
import { useClient } from "@/lib/api";
import { useProjectArchived, useSnapshotData } from "@/lib/queries";

type RoleSession = Session & { role: "orchestrator" | "pm" };

const isRole = (session: Session): session is RoleSession => session.role !== "agent";

const roleName = (session: Session) => (session.role === "pm" ? "PM" : "orchestrator");

/**
 * Why "Start fresh" can't run now, or null when it can. The server refuses the same: archiving
 * the session would cut off its turn or drop a question the person hasn't answered.
 */
export function startFreshBlocked(
  session: Pick<Session, "role" | "status">,
  running: boolean,
  openRequests: number,
): string | null {
  const name = session.role === "pm" ? "PM" : "orchestrator";
  if (session.status === "waiting" || openRequests > 0) {
    return `Answer the ${name}'s open question or approval first`;
  }
  if (running || session.status === "running") return `Wait for the ${name}'s turn to finish`;
  if (session.status === "created" || session.status === "queued" || session.status === "starting")
    return `The ${name} is still starting`;
  return null;
}

/** The role chat's own page: the orchestrator's home or the project's PM. */
function useOpenRoleChat() {
  const navigate = useNavigate();
  return (session: Session) =>
    session.role === "pm" && session.projectId
      ? navigate({ to: "/projects/$projectId/pm", params: { projectId: session.projectId } })
      : navigate({ to: "/" });
}

/**
 * "Start fresh" for the orchestrator's or a PM's thread menu (§8.1): whether it shows, why it
 * is disabled, and the confirmation dialog it opens. Only for the role's current session.
 */
export function useStartFresh(session: Session, running: boolean) {
  const client = useClient();
  const navigate = useNavigate();
  const openRoleChat = useOpenRoleChat();
  const [confirming, setConfirming] = useState(false);
  const openRequests = useSnapshotData(
    (s) =>
      s.inbox.filter(
        (i) =>
          i.sessionId === session.id &&
          i.status === "open" &&
          (i.kind === "question" || i.kind === "approval"),
      ).length,
    0,
  );
  const mutation = useMutation({
    mutationFn: () =>
      client.orchestration.startFresh(
        session.role === "pm" ? "pm" : "orchestrator",
        session.projectId,
        session.id,
      ),
    onSuccess: ({ archivedSessionId }) => {
      setConfirming(false);
      void openRoleChat(session);
      toast.success(`Started a fresh ${roleName(session)} conversation`, {
        description: "The earlier one is archived and read-only.",
        action: {
          label: "Open earlier",
          onClick: () =>
            void navigate({ to: "/sessions/$sessionId", params: { sessionId: archivedSessionId } }),
        },
      });
    },
    onError: (error) =>
      toast.error("Couldn't start fresh", {
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const projectArchived = useProjectArchived(session.projectId);
  const available = isRole(session) && !session.archivedAt;
  return {
    /** Show "Start fresh": the role's current session. */
    available,
    /** Why it can't run right now (null when it can). */
    blocked: available
      ? mutation.isPending
        ? "Starting fresh…"
        : projectArchived
          ? "The project is archived"
          : startFreshBlocked(session, running, openRequests)
      : null,
    open: () => setConfirming(true),
    dialog: (
      <StartFreshDialog
        session={session}
        open={confirming}
        onOpenChange={setConfirming}
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      />
    ),
  };
}

function StartFreshDialog({
  session,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const name = roleName(session);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start a fresh {name} conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            This conversation is archived and stays readable, but can't be continued. The new one
            starts empty, on the provider and model chosen in settings. Project notes, scheduled
            wake-ups, inbox items and the work the {name} follows carry over.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              // Closed by `onSuccess`, so a refusal keeps the dialog's context.
              e.preventDefault();
              onConfirm();
            }}
          >
            Start fresh
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * In place of the composer on an archived orchestrator or PM conversation: it is read-only
 * (a newer session holds the role), with a link to the current one.
 */
export function ArchivedRoleNotice({ session }: { session: Session }) {
  const name = session.role === "pm" ? "project manager" : "orchestrator";
  return (
    <div className="mx-auto flex w-full max-w-[46rem] items-center gap-2.5 px-6 pb-4">
      <p className="flex flex-1 items-center gap-2 rounded-xl border border-dashed border-border px-3.5 py-2.5 text-xs text-muted-foreground">
        <Archive className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          An earlier {name} conversation, archived and read-only.{" "}
          {session.role === "pm" && session.projectId ? (
            <Link
              to="/projects/$projectId/pm"
              params={{ projectId: session.projectId }}
              className="text-foreground underline-offset-2 hover:underline"
            >
              Open the current one
            </Link>
          ) : (
            <Link to="/" className="text-foreground underline-offset-2 hover:underline">
              Open the current one
            </Link>
          )}
        </span>
      </p>
    </div>
  );
}

/** An archived orchestrator or PM conversation: read-only (§8.1). */
export const isArchivedRole = (session: Pick<Session, "role" | "archivedAt">) =>
  session.role !== "agent" && Boolean(session.archivedAt);
