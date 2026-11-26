// Copies runtime assets next to the bundle: drizzle migrations, automation templates, the
// prebuilt web UI and the Dockerfile the Docker backend builds the runner image from.
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const assets = [
  ["../server/drizzle", "dist/drizzle"],
  ["../server/templates", "dist/templates"],
  ["../web/dist", "dist/web"],
  ["docker", "dist/docker"],
];
for (const [from, to] of assets) {
  const src = resolve(root, from);
  if (!existsSync(src)) throw new Error(`Missing ${src}; build the workspace first`);
  rmSync(resolve(root, to), { recursive: true, force: true });
  cpSync(src, resolve(root, to), { recursive: true });
}
console.log("copied drizzle migrations, automation templates, web assets and the Dockerfile");
