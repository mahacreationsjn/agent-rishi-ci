// Runs the desktop app from this checkout (`pnpm desktop:dev`), after the web UI and the
// desktop bundle were built. Development data stays out of your real home: the default home
// is `.agent-rishi-dev/` (the one `pnpm dev` uses), so when `pnpm dev` is running the app attaches
// to that server; otherwise it starts its own with the Fake provider.
//
//   pnpm desktop:dev [-- --home <dir>] [--port <n>] [agent-rishi://...]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "..", "..");
const electron = createRequire(import.meta.url)("electron");
const args = process.argv.slice(2).filter((a) => a !== "--");
if (!args.includes("--home") && !args.some((a) => a.startsWith("--home="))) {
  args.push("--home", resolve(repo, ".agent-rishi-dev"));
}
if (!args.includes("--fake")) args.push("--fake");

const child = spawn(electron, [root, ...args], {
  stdio: "inherit",
  env: { ...process.env, AGENT_RISHI_DEBUG: process.env.AGENT_RISHI_DEBUG ?? "1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
