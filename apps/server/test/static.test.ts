import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { mountWeb } from "../src/routes/static";
import { removeTree } from "./support/remove-tree";

let dir: string;
afterEach(() => removeTree(dir));

describe("mountWeb", () => {
  it("serves the current index.html for client routes after a rebuild", async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-rishi-web-"));
    writeFileSync(join(dir, "index.html"), "<p>v1</p>");
    const app = new Hono();
    mountWeb(app, dir);
    expect(await (await app.request("/projects/p1")).text()).toBe("<p>v1</p>");

    writeFileSync(join(dir, "index.html"), "<p>version 2</p>");
    expect(await (await app.request("/projects/p1")).text()).toBe("<p>version 2</p>");

    rmSync(join(dir, "index.html"));
    expect(await (await app.request("/reports")).text()).toContain("not built");
    expect((await app.request("/api/nope")).status).toBe(404);
  });
});
