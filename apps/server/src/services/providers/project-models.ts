import type { Project, ProjectModelsResponse } from "@agent-rishi/contracts";
import { ServiceError } from "../errors";
import { type RunnerPort, toServiceError } from "../runner-port";

/** Listing a project's models may start the provider's CLI once (up to 20 s, then some). */
const PROJECT_MODELS_TIMEOUT_MS = 60_000;

/**
 * A provider's models for one project (#643). A provider whose list depends on the project
 * (`capabilities.projectModels`, OpenCode with a project `opencode.json`) is asked through the
 * home runner, which shares the server's disk, with the project's folder; the runner keeps the
 * list per project, so only `refresh` (or a change to the project's config) asks the provider
 * again. Any other provider answers with its usual list.
 */
export async function projectProviderModels(
  runner: RunnerPort,
  project: Project,
  providerId: string,
  refresh: boolean,
): Promise<ProjectModelsResponse> {
  if (!runner.isConnected()) {
    throw new ServiceError(503, "runner_unavailable", "The runner is not connected");
  }
  const provider = runner.providers().find((p) => p.id === providerId);
  if (!provider) {
    throw new ServiceError(404, "unknown_provider", `No provider "${providerId}" is loaded`);
  }
  const ids = { providerId, projectId: project.id };
  if (!provider.capabilities.projectModels)
    return { ...ids, models: provider.models, warnings: [] };
  try {
    const result = await runner.request(
      {
        name: "provider.models",
        providerId,
        projectDir: project.path,
        ...(refresh ? { refresh: true } : {}),
      },
      PROJECT_MODELS_TIMEOUT_MS,
    );
    return { ...ids, models: result.models, warnings: result.warnings };
  } catch (error) {
    throw toServiceError(error);
  }
}
