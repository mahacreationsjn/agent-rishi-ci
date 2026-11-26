import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useProjectActions } from "@/lib/project-actions";
import { useSnapshot } from "@/lib/queries";
import { SettingRow, SettingsSection } from "./settings-ui";

/**
 * Settings > General: per project, whether agent sessions run with `CI=true` (§4.2,
 * `Project.agentCiEnv`). On by default; off when the project's own tools misbehave under CI.
 */
export function AgentEnvironmentSettings() {
  // Undefined until the snapshot loads, so "Add a project" never shows before it has (#400).
  const projects = useSnapshot().data?.projects;
  const { setAgentCiEnv } = useProjectActions();
  return (
    <SettingsSection
      title="Agent environment"
      description="Agent sessions run with CI=true, so installs and other commands never stop at a prompt nobody can answer. Your project's tools then act as they do in CI: Playwright won't reuse a running dev server, fails on test.only and retries failing tests; Yarn won't update the lockfile; Create React App fails the build on warnings. Turn it off for a project whose tools get in the way. Applies to agent sessions opened after the change; your terminals never get it."
    >
      {projects === undefined ? (
        <div className="px-4 py-3.5" role="status" aria-label="Loading projects">
          <Skeleton className="h-4 w-1/3" />
        </div>
      ) : projects.length === 0 ? (
        <p className="px-4 py-3.5 text-2xs text-muted-foreground">
          Add a project to choose this per project.
        </p>
      ) : (
        projects.map((project) => (
          <SettingRow
            key={project.id}
            label={project.name}
            help={
              project.agentCiEnv ? (
                "Agent sessions run with CI=true."
              ) : (
                <>
                  Agent sessions run without CI. pnpm may then stop to ask before reinstalling{" "}
                  <code>node_modules</code>: set <code>confirmModulesPurge: false</code> in the
                  project's <code>pnpm-workspace.yaml</code>.
                </>
              )
            }
          >
            <Switch
              aria-label={`Run ${project.name}'s agent sessions with CI=true`}
              checked={project.agentCiEnv}
              onCheckedChange={(on) => void setAgentCiEnv(project, on)}
            />
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}
