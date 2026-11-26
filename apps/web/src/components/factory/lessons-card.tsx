import { type FactoryLesson, lessonInBriefsAt } from "@agent-rishi/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Lightbulb, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useClient } from "@/lib/api";
import { factoryKeys } from "@/lib/factory";
import { ago, until } from "@/lib/format";

/**
 * The factory's lessons (§10.1): general rules its reviewers recorded with their verdicts, which
 * every new builder and reviewer gets in its brief once a day has passed. Forget takes one out of
 * the briefs for good.
 */
export function LessonsCard({
  projectId,
  lessons,
  learning,
}: {
  projectId: string;
  lessons: FactoryLesson[];
  /** "Learn from reviews" is on: lessons are asked for, kept and briefed. */
  learning: boolean;
}) {
  return (
    <details
      className="group rounded-lg border border-border bg-surface text-2xs"
      data-testid="factory-lessons"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 font-medium text-muted-foreground">
        <Lightbulb className="size-3.5" aria-hidden />
        Lessons
        <span className="font-normal text-muted-foreground/80">
          ·{" "}
          {learning
            ? "what reviews taught the factory; new builders and reviewers get them in their briefs"
            : "learning from reviews is off: briefs carry none"}
        </span>
        <span className="ml-auto tabular-nums">{lessons.length}</span>
      </summary>
      {lessons.length === 0 ? (
        <p className="border-t border-border px-2 py-3 text-center text-3xs text-muted-foreground/70">
          None yet: reviewers add lessons as they review.
        </p>
      ) : (
        <ul className="space-y-0.5 border-t border-border p-1.5">
          {lessons.map((l) => (
            <LessonRow key={l.id} projectId={projectId} lesson={l} />
          ))}
        </ul>
      )}
    </details>
  );
}

function LessonRow({ projectId, lesson }: { projectId: string; lesson: FactoryLesson }) {
  const forget = useForgetLesson(projectId);
  // A new lesson waits a day before it goes into briefs: time to read it and forget it.
  const inBriefs = lessonInBriefsAt(lesson);
  const waiting = inBriefs.getTime() > Date.now();
  return (
    <li
      className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/40"
      data-testid="factory-lesson"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-snug text-foreground/90">{lesson.text}</span>
        <span className="block text-3xs text-muted-foreground/80">
          {lesson.prNumber !== null ? (
            <Link
              to="/projects/$projectId/factory/$itemId"
              params={{ projectId, itemId: lesson.itemId }}
              className="hover:text-foreground hover:underline"
            >
              from #{lesson.prNumber}
            </Link>
          ) : (
            "from a review"
          )}
          {lesson.times > 1 && ` · recorded ${lesson.times}×`} · {ago(lesson.lastSeenAt)}
          {waiting && (
            <span className="text-status-waiting" data-testid="factory-lesson-waiting">
              {" "}
              · new: in briefs {until(inBriefs.toISOString())}
            </span>
          )}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-muted-foreground"
        aria-label={`Forget lesson: ${lesson.text}`}
        title="Forget: later builders and reviewers no longer get it, and it isn't learned again"
        disabled={forget.isPending}
        onClick={() => forget.mutate(lesson.id)}
      >
        <X className="size-3.5" />
      </Button>
    </li>
  );
}

/** Forget a lesson; the factory panel refreshes with the lessons still in force. */
function useForgetLesson(projectId: string) {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lessonId: string) => client.factory.forgetLesson(projectId, lessonId),
    onSuccess: () => {
      toast.success("Lesson forgotten", {
        description: "New builders and reviewers no longer get it.",
      });
      void queryClient.invalidateQueries({ queryKey: factoryKeys.status(projectId) });
    },
    onError: (e: Error) => toast.error("Couldn't forget the lesson", { description: e.message }),
  });
}
