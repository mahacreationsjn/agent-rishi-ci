import { setTimeout as delay } from "node:timers/promises";
import { serverHealthy } from "./server-plan";

export async function loadAfterReady(
  load: () => Promise<void>,
  waitForReady: () => Promise<void>,
): Promise<void> {
  try {
    await load();
  } catch {
    await waitForReady();
    await load();
  }
}

export async function waitForServer(url: string, isCurrent: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 4 && isCurrent(); attempt++) {
    if (await serverHealthy(url)) return;
    await delay(250);
  }
  throw new Error("The server did not become ready");
}
