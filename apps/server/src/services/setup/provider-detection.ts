import type { ProviderStatus } from "@agent-rishi/contracts";
import { builtinProviders, ProviderRegistry } from "@agent-rishi/providers";
import type { RunnerPort } from "../runner-port";

/** Detects the agent providers, each status with its level (Foundation §4.3). */
export type DetectProviders = () => Promise<ProviderStatus[]>;

/** A detection that lists the models first takes a CLI start per provider (up to 30 s each). */
export const PROVIDER_DETECT_TIMEOUT_MS = 90_000;

/** How long a setup check waits for the runner (server start) before detecting on its own. */
const RUNNER_WAIT_MS = 30_000;

let local: ProviderRegistry | undefined;

/**
 * The same detection the runner runs, in this process: the built-in providers' own `detect()`
 * and their model lists as the real check. For `agent-rishi doctor`, and for a server whose
 * runner can't be reached. One registry per process, so a check that passed earlier counts.
 */
export const localProviderDetection: DetectProviders = () => {
  local ??= new ProviderRegistry(builtinProviders());
  return local.detect(undefined, { verify: true });
};

/**
 * The runner's detection (`provider.detect`, after its model lists are refreshed), which setup
 * displays: there is no second one. Waits for the runner while it starts; without one, the same
 * detection runs here (`fallback`).
 */
export function runnerProviderDetection(
  runner: RunnerPort,
  opts: { fallback?: DetectProviders; waitMs?: number } = {},
): DetectProviders {
  return async () => {
    const waitMs = opts.waitMs ?? RUNNER_WAIT_MS;
    const connected =
      runner.isConnected() || (waitMs > 0 && (await runner.waitForConnection(waitMs)));
    if (!connected) return (opts.fallback ?? localProviderDetection)();
    const result = await runner.request(
      { name: "provider.detect", waitForModels: true },
      PROVIDER_DETECT_TIMEOUT_MS,
    );
    return result.statuses;
  };
}
