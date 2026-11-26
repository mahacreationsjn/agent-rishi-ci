import { defineProject } from "vitest/config";

/** Unit tests for the main-process logic (pure modules; no Electron needed). */
export default defineProject({
  test: {
    name: "@agent-rishi/desktop",
    include: ["test/**/*.test.ts"],
  },
});
