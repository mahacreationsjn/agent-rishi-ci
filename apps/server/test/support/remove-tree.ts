import { rmSync } from "node:fs";

/**
 * Delete a test's temp folder in teardown, retrying while Windows still holds it. A process that
 * just exited (a runner, git, a fake CLI) keeps its working directory busy for a moment after its
 * pid is gone, and a virus scanner may still have a new file open; `rmSync`'s own `maxRetries`
 * has not been enough on Node 24 (EPERM on the folder itself). A folder that still can't be
 * removed is reported and left behind: a leftover temp folder is not a test failure (#382).
 */
export async function removeTree(path: string, attempts = 40): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= attempts) {
        console.warn(`removeTree: left ${path} behind: ${String(error)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
