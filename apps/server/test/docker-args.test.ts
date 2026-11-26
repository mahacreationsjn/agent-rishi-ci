import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SandboxSpec, sandboxRefFor } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import {
  buildArgs,
  execLinkArgs,
  gitIdentityArgs,
  imageLabelsArgs,
  imageName,
  inspectStateArgs,
  isNoSuchObject,
  listArgs,
  parseLabels,
  parseList,
  parseState,
  parseVersion,
  removeArgs,
  runArgs,
  startArgs,
  stopArgs,
  versionArgs,
  volumeCreateArgs,
  volumeRemoveArgs,
} from "../src/execution/docker/args";

/**
 * Remote runners phase 4a (#309, `docs/remote-runners.md` §5.2): every `docker` command the
 * Docker backend runs, built and parsed without Docker.
 */

const ref = sandboxRefFor("agent-rishi-3f2a1b4c-9d8e7f");
const spec: SandboxSpec = {
  recordId: "3f2a1b4c-9d8e7f",
  sessionId: "3f2a1b4c-0000-4000-8000-000000000001",
  projectId: "p-1",
  image: "agent-rishi-runner:0.7.2",
  cpus: 2,
  memoryMb: 4096,
  fake: true,
};
const ok = { notFound: false, code: 0, stderr: "" };

describe("detect (docker version)", () => {
  it("asks for the version as JSON", () => {
    expect(versionArgs()).toEqual(["version", "--format", "{{json .}}"]);
  });

  it("is available with a daemon new enough", () => {
    const stdout = JSON.stringify({
      Client: { Version: "29.6.1", ApiVersion: "1.55" },
      Server: { Version: "29.6.1", ApiVersion: "1.55", MinAPIVersion: "1.40" },
    });
    expect(parseVersion({ ...ok, stdout })).toEqual({
      backend: "docker",
      available: true,
      code: "ok",
      version: "29.6.1",
      reason: null,
      fix: null,
    });
  });

  it("says Docker isn't installed", () => {
    const status = parseVersion({ notFound: true, code: null, stdout: "", stderr: "" });
    expect(status).toMatchObject({ available: false, code: "not_found" });
    expect(status.reason).toMatch(/Docker not found/);
    expect(status.fix).toMatch(/Install Docker/);
  });

  it("says the daemon isn't running (Linux socket, Windows pipe, no server section)", () => {
    const client = JSON.stringify({ Client: { Version: "29.6.1" }, Server: null });
    for (const stderr of [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "error during connect: Get http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
      "",
    ]) {
      const status = parseVersion({ notFound: false, code: 1, stdout: client, stderr });
      expect(status, stderr).toMatchObject({ available: false, code: "daemon_down" });
      expect(status.fix).toMatch(/Start Docker/);
    }
    expect(parseVersion({ ...ok, code: null, stdout: "", timedOut: true }).code).toBe(
      "daemon_down",
    );
  });

  it("says when the daemon is too old", () => {
    const stdout = JSON.stringify({ Server: { Version: "19.03.15", ApiVersion: "1.40" } });
    const status = parseVersion({ ...ok, stdout });
    expect(status).toMatchObject({ available: false, code: "too_old", version: "19.03.15" });
    expect(status.reason).toBe("Docker 19.03.15 is too old; Agent Rishi needs 20.10 or newer");
    expect(
      parseVersion({
        ...ok,
        stdout: JSON.stringify({ Server: { Version: "20.10.0", ApiVersion: "1.41" } }),
      }).available,
    ).toBe(true);
  });

  it("reports anything else with Docker's own words", () => {
    const status = parseVersion({
      notFound: false,
      code: 1,
      stdout: "",
      stderr: "permission denied while trying to connect",
    });
    expect(status).toMatchObject({ available: false, code: "detect_failed" });
    expect(status.reason).toContain("permission denied");
  });
});

describe("the runner image", () => {
  it("is named per version and built from a context with its labels", () => {
    expect(imageName("0.7.2")).toBe("agent-rishi-runner:0.7.2");
    expect(imageLabelsArgs("agent-rishi-runner:0.7.2")).toEqual([
      "image",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      "agent-rishi-runner:0.7.2",
    ]);
    expect(
      buildArgs({
        image: "agent-rishi-runner:0.7.2",
        context: "/tmp/ctx",
        version: "0.7.2",
        build: "ab12",
      }),
    ).toEqual([
      "build",
      "--tag",
      "agent-rishi-runner:0.7.2",
      "--label",
      "agent-rishi.version=0.7.2",
      "--label",
      "agent-rishi.build=ab12",
      "/tmp/ctx",
    ]);
  });

  it("reads image labels", () => {
    expect(parseLabels('{"agent-rishi.build":"ab12","agent-rishi.version":"0.7.2"}\n')).toEqual({
      "agent-rishi.build": "ab12",
      "agent-rishi.version": "0.7.2",
    });
    expect(parseLabels("null")).toEqual({});
    expect(parseLabels("not json")).toBeNull();
    expect(parseLabels("[1]")).toBeNull();
  });
});

describe("provision", () => {
  it("makes a labelled volume", () => {
    expect(volumeCreateArgs(ref, spec, "inst01", "0.7.2")).toEqual([
      "volume",
      "create",
      "--label",
      "agent-rishi.install=inst01",
      "--label",
      `agent-rishi.session=${spec.sessionId}`,
      "--label",
      "agent-rishi.project=p-1",
      "--label",
      "agent-rishi.runner=3f2a1b4c-9d8e7f",
      "--label",
      "agent-rishi.version=0.7.2",
      "agent-rishi-3f2a1b4c-9d8e7f-data",
    ]);
  });

  it("runs the runner hardened: --init, non-root, limits, labels, its volume only", () => {
    const args = runArgs(ref, spec, "inst01", "0.7.2");
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args.slice(0, 3)).toEqual(["run", "--detach", "--init"]);
    expect(flag("--name")).toBe(ref.container);
    expect(flag("--user")).toBe("1000:1000");
    expect(flag("--cpus")).toBe("2");
    expect(flag("--memory")).toBe("4096m");
    expect(flag("--pids-limit")).toBe("1024");
    expect(flag("--cap-drop")).toBe("ALL");
    expect(flag("--security-opt")).toBe("no-new-privileges");
    expect(flag("--restart")).toBe("unless-stopped");
    expect(flag("--mount")).toBe(`type=volume,source=${ref.volume},target=/data`);
    for (const label of [
      `agent-rishi.session=${spec.sessionId}`,
      "agent-rishi.project=p-1",
      "agent-rishi.version=0.7.2",
      "agent-rishi.install=inst01",
    ]) {
      expect(args).toContain(label);
    }
    expect(args.slice(args.indexOf("agent-rishi-runner:0.7.2"))).toEqual([
      "agent-rishi-runner:0.7.2",
      "agent-rishi-runner",
      "--home",
      "/data",
      "--backend",
      "docker",
      "--no-builtin",
      "--fake",
    ]);
    // No environment, host folder, published port or privileges.
    for (const banned of [
      "-e",
      "--env",
      "--env-file",
      "-v",
      "--volume",
      "-p",
      "--publish",
      "--privileged",
      "--network=host",
    ]) {
      expect(args, banned).not.toContain(banned);
    }
    expect(args.filter((a) => a.startsWith("type=bind"))).toEqual([]);
    expect(runArgs(ref, { ...spec, fake: false }, "inst01", "0.7.2")).not.toContain("--fake");
  });

  it("sets the git identity in the container", () => {
    expect(gitIdentityArgs(ref, "email", "dev@example.com")).toEqual([
      "exec",
      "--user",
      "1000:1000",
      ref.container,
      "git",
      "config",
      "--global",
      "user.email",
      "dev@example.com",
    ]);
  });
});

describe("the link and the lifecycle", () => {
  it("links with docker exec -i to agent-rishi runner-link", () => {
    expect(execLinkArgs(ref)).toEqual([
      "exec",
      "--interactive",
      "--user",
      "1000:1000",
      ref.container,
      "agent-rishi",
      "runner-link",
      "--home",
      "/data",
    ]);
  });

  it("starts, stops, removes and inspects by container name", () => {
    expect(startArgs(ref)).toEqual(["start", ref.container]);
    expect(stopArgs(ref)).toEqual(["stop", "--time", "10", ref.container]);
    expect(removeArgs(ref)).toEqual(["rm", "--force", ref.container]);
    expect(volumeRemoveArgs(ref)).toEqual(["volume", "rm", "--force", ref.volume]);
    expect(inspectStateArgs(ref)).toEqual([
      "container",
      "inspect",
      "--format",
      "{{json .State.Status}}",
      ref.container,
    ]);
  });

  it("reads container states and missing objects", () => {
    expect(parseState('"running"\n')).toBe("running");
    expect(parseState('"exited"')).toBe("exited");
    expect(parseState("created")).toBe("exited");
    expect(parseState('"paused"')).toBe("other");
    expect(isNoSuchObject("Error response from daemon: No such container: agent-rishi-x")).toBe(
      true,
    );
    expect(isNoSuchObject("Error: No such object: agent-rishi-x")).toBe(true);
    expect(isNoSuchObject("permission denied")).toBe(false);
  });

  it("lists this install's containers by label", () => {
    expect(listArgs("inst01")).toEqual([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "label=agent-rishi.install=inst01",
      "--format",
      "{{json .}}",
    ]);
    const row = (name: string, state: string, labels: string) =>
      JSON.stringify({ Names: name, State: state, Labels: labels, Mounts: `${name}-data` });
    const stdout = [
      row(
        ref.container,
        "running",
        `agent-rishi.install=inst01,agent-rishi.session=s1,agent-rishi.project=p-1,agent-rishi.runner=3f2a1b4c-9d8e7f,agent-rishi.version=0.7.2`,
      ),
      "not json",
      row("agent-rishi-other", "exited", "agent-rishi.install=inst01"),
      "",
    ].join("\n");
    expect(parseList(stdout)).toEqual([
      {
        container: ref.container,
        volume: ref.volume,
        sessionId: "s1",
        projectId: "p-1",
        recordId: "3f2a1b4c-9d8e7f",
        version: "0.7.2",
        state: "running",
      },
      {
        container: "agent-rishi-other",
        volume: "agent-rishi-other-data",
        sessionId: null,
        projectId: null,
        recordId: null,
        version: null,
        state: "exited",
      },
    ]);
  });
});

describe("no secret in any docker argument or the image", () => {
  it("keeps tokens out of every argument list and the Dockerfile", () => {
    // What a server holds while it makes a sandbox: none of it may reach Docker.
    const secrets = ["ghs_SENTINEL_github_token_9f3a", "f".repeat(64), "sk-ant-SENTINEL"];
    const all = [
      versionArgs(),
      imageLabelsArgs(spec.image),
      buildArgs({ image: spec.image, context: "/tmp/ctx", version: "0.7.2", build: "ab12" }),
      volumeCreateArgs(ref, spec, "inst01", "0.7.2"),
      runArgs(ref, spec, "inst01", "0.7.2"),
      execLinkArgs(ref),
      gitIdentityArgs(ref, "name", "Dev"),
      startArgs(ref),
      stopArgs(ref),
      removeArgs(ref),
      volumeRemoveArgs(ref),
      inspectStateArgs(ref),
      listArgs("inst01"),
    ];
    const text = JSON.stringify(all);
    for (const secret of secrets) expect(text).not.toContain(secret);
    // No environment variable is set on a container or an exec, at all.
    for (const args of all) {
      expect(args.filter((a) => a === "-e" || a.startsWith("--env"))).toEqual([]);
    }
    const dockerfile = readFileSync(
      join(import.meta.dirname, "../../cli/docker/Dockerfile"),
      "utf8",
    );
    // No build argument or environment variable a secret could be passed in through.
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s/im);
    expect(dockerfile).not.toMatch(/--mount=type=secret|GH_TOKEN|GITHUB_TOKEN|API_KEY/);
    expect(dockerfile).toMatch(/^USER node$/m);
  });
});
