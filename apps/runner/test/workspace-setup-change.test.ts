import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerEvent } from "@agent-rishi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { prepareWorkspace } from "../src/workspace/worktree";
import { makeRepo, removeDir, sh, tempDir, write } from "./helpers";

/**
 * Setup commands from a merged `.agent-rishi/project.json` change (#390): new worktrees branch from
 * the freshly fetched `origin/<default>` and run that copy's `setup`, so a merged PR that changes
 * setup would run on the user's machine from the next session on, without the user pulling.
 * Given the lists a person has seen (`seenSetups`), anything else is held, not run.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0).reverse()) removeDir(dir);
});

const marker = (name: string) => `node -e "require('fs').writeFileSync('${name}', 'ran')"`;
const config = (setup: string[]) => JSON.stringify({ setup });

describe("setup commands changed by a merged pull request", () => {
  it("are held in a new worktree until a person has seen them", async () => {
    const upstream = makeRepo({ ".agent-rishi/project.json": config([marker("a.done")]) });
    const project = tempDir("agent-rishi-project-");
    const home = tempDir("agent-rishi-home-");
    dirs.push(upstream, project, home);
    sh(project, "clone", "-q", upstream, ".");
    const ctx = {
      home,
      supervisor: new ProcessSupervisor(),
      emit: (_e: RunnerEvent) => undefined,
    };
    const prepare = (sessionId: string, seenSetups?: string[][]) =>
      prepareWorkspace(
        {
          name: "workspace.prepare",
          sessionId,
          repoPath: project,
          strategy: "worktree",
          setupCommands: ["echo explicit"],
          fetch: true,
          ...(seenSetups ? { seenSetups } : {}),
        },
        ctx,
      );

    // The setup the user has: it runs.
    const first = await prepare("sess-first", [[marker("a.done")]]);
    expect(existsSync(join(first.cwd, "a.done"))).toBe(true);
    expect(first.heldSetup).toBeUndefined();

    // A merged PR changes the setup on the remote; the user pulls nothing.
    write(upstream, ".agent-rishi/project.json", config([marker("b.done")]));
    sh(upstream, "commit", "-q", "-am", "Tidy the project (#42)");
    expect(readFileSync(join(project, ".agent-rishi", "project.json"), "utf8")).toContain("a.done");

    // The next worktree comes from origin/main: the changed command waits for a person, and the
    // explicit setup commands still run.
    const next = await prepare("sess-next", [[marker("a.done")]]);
    expect(readFileSync(join(next.cwd, ".agent-rishi", "project.json"), "utf8")).toContain(
      "b.done",
    );
    expect(existsSync(join(next.cwd, "b.done"))).toBe(false);
    expect(next.setup).toEqual([{ command: "echo explicit", exitCode: 0, ok: true }]);
    expect(next.heldSetup).toEqual({
      commands: [marker("b.done")],
      commit: sh(upstream, "rev-parse", "--short", "HEAD"),
      subject: "Tidy the project (#42)",
    });

    // Once a person has seen it, it runs; without a gate it runs as before.
    const seen = await prepare("sess-seen", [[marker("a.done")], [marker("b.done")]]);
    expect(existsSync(join(seen.cwd, "b.done"))).toBe(true);
    expect(seen.heldSetup).toBeUndefined();
    const ungated = await prepare("sess-ungated");
    expect(existsSync(join(ungated.cwd, "b.done"))).toBe(true);
  });
});
