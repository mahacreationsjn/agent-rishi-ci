import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@agent-rishi/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerBackend, installId } from "../src/execution/docker/backend";
import type { ImageSource } from "../src/execution/docker/image";
import type { Exec, ExecResult } from "../src/services/exec";
import { removeTree } from "./support/remove-tree";

/**
 * Remote runners phase 4a (#309): the Docker backend over a scripted `docker` (no Docker in
 * `pnpm test`): image builds only when the bundle changed, provisioning cleans up after itself,
 * removal tolerates what is already gone.
 */

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  notFound: false,
  timedOut: false,
  path: "docker",
  ...over,
});

interface Call {
  args: string[];
  /** For `docker build`: the context's files when it ran. */
  context?: string[];
}

let base: string;
let calls: Call[];
let answer: (args: string[]) => Partial<ExecResult>;
const exec: Exec = async (_command, args) => {
  const call: Call = { args };
  if (args[0] === "build") {
    const context = args[args.length - 1] as string;
    const list = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? list(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
      );
    call.context = list(context).sort();
    expect(JSON.parse(readFileSync(join(context, "agent-rishi/package.json"), "utf8"))).toEqual({
      name: "agent-rishi",
      version: "0.7.2",
      private: true,
      type: "module",
      dependencies: { "node-pty": "1.1.0" },
    });
  }
  calls.push(call);
  return result(answer(args));
};

function imageSource(): ImageSource {
  const pkg = mkdtempSync(join(base, "pkg-"));
  const dist = join(pkg, "dist");
  mkdirSync(join(dist, "web"), { recursive: true });
  for (const name of ["runner.js", "cli.js", "chunk-1.js", "chunk-1.js.map", "web/index.html"]) {
    writeFileSync(join(dist, name), `// ${name}\n`);
  }
  writeFileSync(join(pkg, "Dockerfile"), "FROM node:24-bookworm-slim\n");
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "agent-rishi",
      version: "0.7.2",
      dependencies: { "node-pty": "1.1.0" },
      devDependencies: { "@agent-rishi/server": "workspace:*" },
    }),
  );
  return {
    distDir: dist,
    dockerfile: join(pkg, "Dockerfile"),
    packageJson: join(pkg, "package.json"),
  };
}

const spec: SandboxSpec = {
  recordId: "3f2a1b4c-9d8e7f",
  sessionId: "3f2a1b4c-0000-4000-8000-000000000001",
  projectId: "p-1",
  image: "agent-rishi-runner:0.7.2",
  cpus: 2,
  memoryMb: 4096,
  fake: true,
};

function backend(source: ImageSource | null = imageSource(), now = () => 0) {
  return new DockerBackend({
    home: base,
    exec,
    version: "0.7.2",
    imageSource: () => source,
    gitIdentity: async () => ({ name: "Dev Person", email: "dev@example.com" }),
    now,
  });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "agent-rishi-docker-"));
  calls = [];
  answer = () => ({});
});

afterEach(async () => {
  await removeTree(base);
});

describe("the Docker backend", () => {
  it("keeps an install id and detects Docker, reusing the answer for 30 s", async () => {
    const id = installId(base);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
    expect(installId(base)).toBe(id);
    let clock = 0;
    answer = () => ({
      stdout: JSON.stringify({ Server: { Version: "29.6.1", ApiVersion: "1.55" } }),
    });
    const docker = backend(null, () => clock);
    expect((await docker.detect()).available).toBe(true);
    clock = 10_000;
    await docker.detect();
    expect(calls).toHaveLength(1);
    await docker.detect({ refresh: true });
    clock = 50_000;
    await docker.detect();
    expect(calls).toHaveLength(3);
  });

  it("builds the image only when the bundle changed, from the bundle and the Dockerfile", async () => {
    const source = imageSource();
    let labels = "null";
    answer = (args) => (args[0] === "image" ? { stdout: labels } : {});
    const docker = backend(source);
    expect(await docker.prepare()).toEqual({ image: "agent-rishi-runner:0.7.2" });
    const build = calls.find((c) => c.args[0] === "build");
    expect(build?.context).toEqual([
      "Dockerfile",
      "agent-rishi/dist/chunk-1.js",
      "agent-rishi/dist/cli.js",
      "agent-rishi/dist/runner.js",
      "agent-rishi/package.json",
    ]);
    // The context is a temp folder removed afterwards.
    expect(existsSync(build?.args.at(-1) as string)).toBe(false);
    const label = build?.args.find((a) => a.startsWith("agent-rishi.build=")) ?? "";
    expect(label).toMatch(/^agent-rishi\.build=[a-f0-9]{16}$/);

    // Same bundle: no build. A changed bundle: built again.
    labels = JSON.stringify({ "agent-rishi.build": label.split("=")[1] });
    calls = [];
    await docker.prepare();
    expect(calls.map((c) => c.args[0])).toEqual(["image"]);
    writeFileSync(join(source.distDir, "runner.js"), "// changed\n");
    calls = [];
    await docker.prepare();
    expect(calls.map((c) => c.args[0])).toEqual(["image", "build"]);
  });

  it("shares one build between starts and reports a failed one", async () => {
    answer = (args) =>
      args[0] === "image"
        ? { code: 1, stderr: "Error: No such image" }
        : args[0] === "build"
          ? { code: 1, stderr: "step 3/9\nnpm error code ENOTFOUND\nnpm error network down" }
          : {};
    const docker = backend();
    const both = await Promise.allSettled([docker.prepare(), docker.prepare()]);
    expect(calls.filter((c) => c.args[0] === "build")).toHaveLength(1);
    for (const outcome of both) {
      expect(outcome.status).toBe("rejected");
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(
        /Building agent-rishi-runner:0\.7\.2 failed: .*network down/,
      );
    }
    await expect(backend(null).prepare()).rejects.toThrow(/build the CLI first \(pnpm build\)/);
  });

  it("provisions a volume, then the container, then the git identity", async () => {
    const ref = await backend().provision(spec);
    expect(ref).toEqual({
      backend: "docker",
      container: "agent-rishi-3f2a1b4c-9d8e7f",
      volume: "agent-rishi-3f2a1b4c-9d8e7f-data",
    });
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "volume create",
      "run --detach",
      "exec --user",
      "exec --user",
    ]);
    expect(calls[2]?.args.slice(-2)).toEqual(["user.name", "Dev Person"]);
    expect(calls[3]?.args.slice(-2)).toEqual(["user.email", "dev@example.com"]);
  });

  it("removes what it made when the container can't start", async () => {
    answer = (args) =>
      args[0] === "run"
        ? {
            code: 125,
            stderr: "docker: Error response from daemon: Conflict. The container name is in use.",
          }
        : {};
    await expect(backend().provision(spec)).rejects.toThrow(
      /Docker failed starting the container: Conflict\. The container name is in use\./,
    );
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "volume create",
      "run --detach",
      "rm --force",
      "volume rm",
    ]);
  });

  it("removes a container that is already gone, then its volume; reads states and lists", async () => {
    answer = (args) =>
      args[0] === "rm"
        ? { code: 1, stderr: "Error response from daemon: No such container: agent-rishi-x" }
        : args[0] === "container"
          ? args.at(-1) === "agent-rishi-gone"
            ? { code: 1, stderr: "Error: No such object: agent-rishi-gone" }
            : { stdout: '"exited"\n' }
          : args[0] === "ps"
            ? {
                stdout: `${JSON.stringify({ Names: "agent-rishi-a", State: "running", Labels: "agent-rishi.session=s1" })}\n`,
              }
            : {};
    const docker = backend();
    await docker.remove({
      backend: "docker",
      container: "agent-rishi-x",
      volume: "agent-rishi-x-data",
    });
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "rm --force agent-rishi-x",
      "volume rm --force agent-rishi-x-data",
    ]);
    expect(await docker.state({ backend: "docker", container: "agent-rishi-a", volume: "v" })).toBe(
      "exited",
    );
    expect(
      await docker.state({ backend: "docker", container: "agent-rishi-gone", volume: "v" }),
    ).toBeNull();
    expect((await docker.list()).map((s) => [s.container, s.sessionId, s.state])).toEqual([
      ["agent-rishi-a", "s1", "running"],
    ]);
    expect(calls.at(-1)?.args).toContain(`label=agent-rishi.install=${installId(base)}`);
  });

  it("opens the link as docker exec -i without starting it", () => {
    const link = backend().openLink({ backend: "docker", container: "agent-rishi-a", volume: "v" });
    expect(link.kind).toBe("exec");
    expect(calls).toEqual([]);
  });
});
