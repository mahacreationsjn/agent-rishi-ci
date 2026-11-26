import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDefaultProvider } from "../src/services/projects/project-config";
import { removeTree } from "./support/remove-tree";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-rishi-pcfg-"));
});
afterEach(() => removeTree(dir));

const writeConfig = (text: string) => {
  mkdirSync(join(dir, ".agent-rishi"), { recursive: true });
  writeFileSync(join(dir, ".agent-rishi", "project.json"), text);
};

describe(".agent-rishi/project.json defaultProvider", () => {
  it("is the project's default unless the project sets its own", () => {
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
    writeConfig('{ "defaultProvider": "codex", "setup": ["pnpm install"] }');
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBe("codex");
    expect(projectDefaultProvider({ defaultProvider: "claude", path: dir })).toBe("claude");
  });

  it("ignores invalid files", () => {
    writeConfig("{ not json");
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
    writeConfig('{ "defaultProvider": "" }');
    expect(projectDefaultProvider({ defaultProvider: null, path: dir })).toBeNull();
  });
});
