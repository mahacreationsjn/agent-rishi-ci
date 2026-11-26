import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server tests never load the real Claude/Codex adapters in the runner they spawn, so no
    // test can reach a live agent or the utility model. Live tests opt in explicitly.
    // Nor the npm registry (update check).
    env: { AGENT_RISHI_BUILTIN_PROVIDERS: "0", AGENT_RISHI_UPDATE_CHECK: "0" },
    // `AGENT_RISHI_TEST_CLOCK=hh:mm` starts the system clock at that time of day (does nothing unset).
    setupFiles: ["./test/support/clock-setup.ts"],
  },
});
