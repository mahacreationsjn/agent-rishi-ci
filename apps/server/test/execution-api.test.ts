import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendStatus, Project, ProviderInfo } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { CREDENTIALS_UNAVAILABLE } from "../src/execution/sandboxes";
import { type Exec, runTool } from "../src/services/exec";
import { removeTree } from "./support/remove-tree";
import { ScriptedBackend } from "./support/scripted-backend";

/**
 * Remote runners phase 4a (#309): the `execution.backend` project setting and the backends'
 * status over the API. Docker can't be chosen for a project that isn't on GitHub, or while it
 * isn't available, and a docker project refuses providers that need credentials.
 */

const TOKEN = "d".repeat(64);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
const missing = {
  code: null,
  stdout: "",
  stderr: "",
  notFound: true,
  timedOut: false,
  path: null,
};
/** git for project detection; every other tool (docker too) is missing. */
const gitOnly: Exec = (command, args, opts) =>
  command === "git" ? runTool(command, args, opts) : Promise.resolve(missing);

let base: string;
let server: RunningServer;

function repo(name: string, origin?: string): string {
  const dir = mkdtempSync(join(base, `${name}-`));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# x\n");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  if (origin) git(dir, "remote", "add", "origin", origin);
  return dir;
}

async function start(backend?: ScriptedBackend) {
  server = await startServer({
    port: 0,
    dataDir: mkdtempSync(join(base, "home-")),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    exec: gitOnly,
    github: { sync: false },
    ...(backend ? { executionBackends: { docker: backend } } : {}),
  });
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { backends?: BackendStatus[] } & Record<string, unknown>,
  };
}

async function addProject(dir: string): Promise<Project> {
  return (await server.services.projects.create({ source: { type: "local", path: dir } })).project;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agent-rishi-exec-api-"));
});

afterEach(async () => {
  await server?.close();
  await removeTree(base);
});

describe("execution backends over the API", () => {
  it("reports Docker missing on a machine without it, with the fix", async () => {
    await start();
    const { body } = await api("GET", "/execution/backends");
    expect(body.backends).toEqual([
      { backend: "local", available: true, code: "ok", version: null, reason: null, fix: null },
      expect.objectContaining({ backend: "docker", available: false, code: "not_found" }),
    ]);
    const github = await addProject(repo("gh", "https://github.com/agent-rishi-test/a.git"));
    const refused = await api("PATCH", `/projects/${github.id}`, {
      execution: { backend: "docker" },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("Docker not found");
    expect(server.services.projects.get(github.id).execution.backend).toBe("local");
  });

  it("lets a GitHub project switch to Docker, and never a local one", async () => {
    const backend = new ScriptedBackend(base);
    await start(backend);
    const github = await addProject(repo("gh", "https://github.com/agent-rishi-test/b.git"));
    const local = await addProject(repo("local"));
    expect(github.execution).toEqual({ backend: "local" });

    const forLocal = await api("GET", `/execution/backends?projectId=${local.id}`);
    expect(forLocal.body.backends?.[1]).toMatchObject({
      backend: "docker",
      available: false,
      code: "unsupported_project",
    });
    const refused = await api("PATCH", `/projects/${local.id}`, {
      execution: { backend: "docker" },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("need a GitHub project");

    const ok = await api("PATCH", `/projects/${github.id}`, { execution: { backend: "docker" } });
    expect(ok.status).toBe(200);
    expect(server.services.projects.get(github.id).execution.backend).toBe("docker");
    // The setting is stored: it survives a restart's projection.
    const stored = server.store
      .listAfter(0, 1000)
      .filter((e) => e.type === "project.updated")
      .at(-1)?.payload as { project: Project };
    expect(stored.project.execution).toEqual({ backend: "docker" });

    // Docker going away: switching back to local still works, switching to it doesn't.
    backend.status = {
      ...backend.status,
      available: false,
      code: "daemon_down",
      reason: "Docker is installed but its daemon isn't running",
    };
    expect(
      (await api("PATCH", `/projects/${github.id}`, { execution: { backend: "local" } })).status,
    ).toBe(200);
    const down = await api("PATCH", `/projects/${github.id}`, { execution: { backend: "docker" } });
    expect(down.status).toBe(400);
    expect(JSON.stringify(down.body)).toContain("daemon isn't running");
  });

  it("refuses sessions a docker project can't host before they start", async () => {
    await start(new ScriptedBackend(base));
    const github = await addProject(repo("gh", "https://github.com/agent-rishi-test/c.git"));
    const docker = { ...github, execution: { backend: "docker" as const } };
    const info = (credentialFree?: boolean) =>
      ({ id: "p", capabilities: { credentialFree } }) as unknown as ProviderInfo;
    const { sandboxes } = server.services;
    expect(() => sandboxes.assertStartable("agent", docker, info())).toThrow(
      CREDENTIALS_UNAVAILABLE,
    );
    expect(() => sandboxes.assertStartable("agent", docker, info(true))).not.toThrow();
    // Unknown here (the home runner hasn't loaded it): the sandbox's runner decides at start.
    expect(() => sandboxes.assertStartable("agent", docker, undefined)).not.toThrow();
    // PMs and local projects stay on this machine.
    expect(() => sandboxes.assertStartable("pm", docker, info())).not.toThrow();
    expect(() => sandboxes.assertStartable("agent", github, info())).not.toThrow();
    expect(() =>
      sandboxes.assertStartable("agent", { ...docker, kind: "local" } as Project, info(true)),
    ).toThrow(/need a GitHub project/);
  });
});
