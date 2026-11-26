/**
 * Development entry (`pnpm dev`): data in `<repo>/.agent-rishi-dev`, fixed port 4318, the Fake
 * provider enabled, and the Vite dev server allowed as an origin.
 */
import { resolve } from "node:path";
import { ensureHome } from "./paths";
import { startServer } from "./server";
import { ensureInstallToken } from "./token";

const home =
  process.env.AGENT_RISHI_HOME ?? resolve(import.meta.dirname, "../../../.agent-rishi-dev");
const port = Number(process.env.AGENT_RISHI_PORT ?? 4318);
const token = ensureInstallToken(ensureHome(home).token);

const server = await startServer({
  port,
  dataDir: home,
  token,
  enableFakeProvider: true,
  allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
  log: (m) => console.log(`[agent-rishi] ${m}`),
});
console.log(`[agent-rishi] UI (vite): http://localhost:5173   API: ${server.url}`);

const stop = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
