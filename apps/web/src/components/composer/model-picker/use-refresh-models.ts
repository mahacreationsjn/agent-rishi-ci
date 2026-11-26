import type { ProviderInfo, Snapshot } from "@agent-rishi/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useClient } from "@/lib/api";
import { snapshotKey } from "@/lib/queries";
import { projectModelsKey } from "./use-project-models";

/**
 * "Refresh models": ask providers for their model lists again, e.g. after a model release or
 * a CLI update. The refreshed lists replace the snapshot's at once (open pickers re-render);
 * the runner's broadcast brings them to other windows. With a project, a provider whose list
 * depends on the project (`capabilities.projectModels`) lists that project's models again too.
 */
export function useRefreshModels() {
  const client = useClient();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (providerIds: readonly string[], projectId?: string | null) => {
    if (refreshing || providerIds.length === 0) return;
    setRefreshing(true);
    try {
      const results = await Promise.all(providerIds.map((id) => client.refreshModels(id)));
      // Each answer carries every provider; take each refreshed provider from its own answer.
      const fresh = new Map<string, ProviderInfo>();
      results.forEach((r, i) => {
        const provider = r.providers.find((p) => p.id === providerIds[i]);
        if (provider) fresh.set(provider.id, provider);
      });
      queryClient.setQueryData<Snapshot>(snapshotKey, (s) =>
        s
          ? {
              ...s,
              runner: {
                ...s.runner,
                providers: s.runner.providers.map((p) => fresh.get(p.id) ?? p),
              },
            }
          : s,
      );
      if (projectId) {
        const perProject = [...fresh.values()].filter((p) => p.capabilities.projectModels);
        const lists = await Promise.all(
          perProject.map((p) => client.projectModels(p.id, projectId, { refresh: true })),
        );
        // Keyed by the refreshed global list, which the snapshot now holds.
        perProject.forEach((provider, i) => {
          queryClient.setQueryData(projectModelsKey(projectId, provider), lists[i]);
        });
      }
    } catch (e) {
      toast.error("Couldn't refresh the models", { description: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  return { refresh, refreshing };
}
