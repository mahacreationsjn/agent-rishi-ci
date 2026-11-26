import type { Project, ProjectExecutionBackend } from "@agent-rishi/contracts";
import { useQuery } from "@tanstack/react-query";
import { ExperimentalBadge } from "@/components/factory/autonomy-dialog";
import { Segmented, SettingsSection } from "@/components/settings/settings-ui";
import { useClient } from "@/lib/api";
import { useProjectActions } from "@/lib/project-actions";

/**
 * Project page > Settings: where the project's new agent sessions run (`Project.execution`,
 * `docs/remote-runners.md` §5). This machine (worktrees) or, experimentally, a Docker container
 * per session. Docker can't be picked while it isn't available, or for a project that isn't on
 * GitHub, and the reason is shown.
 */
export function ProjectExecution({ project }: { project: Project }) {
  const client = useClient();
  const { setExecutionBackend } = useProjectActions();
  const backends = useQuery({
    queryKey: ["execution", "backends", project.id, project.kind],
    queryFn: () => client.executionBackends({ projectId: project.id }),
    retry: false,
    staleTime: 30_000,
  });
  const docker = backends.data?.backends.find((b) => b.backend === "docker");
  // A project from an older server has no setting: it runs locally.
  const current = project.execution?.backend ?? "local";
  const blocked = !docker?.available;
  const reason = docker
    ? [docker.reason, docker.fix].filter(Boolean).join(". ")
    : backends.isPending
      ? "Checking Docker…"
      : "Docker couldn't be checked";

  return (
    <SettingsSection
      title="Where sessions run"
      description="Where new agent sessions in this project run. Sessions that already started stay where they are."
    >
      <div className="space-y-3 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            Agent sessions
            {current === "docker" && <ExperimentalBadge />}
          </div>
          <div className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
            {current === "docker" ? (
              <>
                Each new agent session gets a Docker container of its own, which clones the
                repository from GitHub. Archiving the session removes the container. For now only
                providers that need no sign-in run there.
              </>
            ) : (
              <>Each new agent session works in a worktree on this machine.</>
            )}
          </div>
        </div>
        <Segmented<ProjectExecutionBackend>
          value={current}
          onChange={(backend) => {
            if (backend !== current) void setExecutionBackend(project, backend);
          }}
          options={[
            { value: "local", label: "This machine" },
            {
              value: "docker",
              label: "Docker (experimental)",
              disabled: blocked && current !== "docker",
              title: blocked ? reason : undefined,
            },
          ]}
        />
        {blocked && (
          <p className="text-2xs text-muted-foreground" data-testid="docker-unavailable">
            {reason}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
