import type { ModelInfo, ProjectModelsResponse, ProviderInfo } from "@agent-rishi/contracts";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { useClient } from "@/lib/api";

/**
 * Query key of one provider's model list for one project. It holds a short version of the
 * provider's global list (`provider.models`), so a new global list (a sign-in, Refresh models
 * elsewhere, a model release) lists the project again at once: the runner forgets its project
 * lists then too.
 */
export const projectModelsKey = (projectId: string, provider: ProviderInfo) =>
  ["project-models", projectId, provider.id, listVersion(provider.models)] as const;

/** A short fingerprint of a model list's ids (FNV-1a), for the query key. */
function listVersion(models: readonly ModelInfo[]): string {
  let hash = 0x811c9dc5;
  for (const model of models) {
    for (let i = 0; i < model.id.length; i++) {
      hash = Math.imul(hash ^ model.id.charCodeAt(i), 0x01000193);
    }
    hash = Math.imul(hash ^ 0x0a, 0x01000193);
  }
  return `${models.length}-${(hash >>> 0).toString(36)}`;
}

const dataOf = (results: { data?: ProjectModelsResponse }[]) => results.map((r) => r.data);

export interface ProjectProviders {
  providers: ProviderInfo[];
  /** Per provider id: what of the project's own config was left out, and why. */
  warnings: ReadonlyMap<string, readonly string[]>;
}

/**
 * The providers with each one's models for this project (#643): a provider whose list depends on
 * the project (`capabilities.projectModels`, e.g. OpenCode with a project `opencode.json`) gets
 * the list made with the project's own config. The others, every provider without a project,
 * and a provider whose project list is still loading keep their usual list. `providers` must be
 * the runner's own (the snapshot's), not a list this hook already returned.
 */
export function useProjectProviders(
  projectId: string | null | undefined,
  providers: ProviderInfo[],
): ProjectProviders {
  const client = useClient();
  const perProject = projectId ? providers.filter((p) => p.capabilities.projectModels) : [];
  const lists = useQueries({
    queries: perProject.map((provider) => ({
      queryKey: projectModelsKey(projectId ?? "", provider),
      queryFn: () => client.projectModels(provider.id, projectId ?? ""),
      staleTime: 5 * 60_000,
      // While a new global list is listed for the project, keep showing the last one.
      placeholderData: keepPreviousData,
      retry: false,
    })),
    combine: dataOf,
  });
  return useMemo(() => {
    const byId = new Map<string, ProjectModelsResponse>();
    for (const list of lists)
      if (list && list.projectId === projectId) byId.set(list.providerId, list);
    const warnings = new Map<string, readonly string[]>();
    for (const [id, list] of byId) if (list.warnings.length) warnings.set(id, list.warnings);
    if (byId.size === 0) return { providers, warnings };
    return {
      providers: providers.map((p) => {
        const list = byId.get(p.id);
        return list && list.models.length > 0 ? { ...p, models: list.models } : p;
      }),
      warnings,
    };
  }, [providers, lists, projectId]);
}
