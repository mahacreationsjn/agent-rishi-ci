/**
 * Manual check of the Docker execution backend (remote runners phase 4a, #309). Not part of
 * `pnpm test`: it needs Docker and a built CLI bundle (`pnpm build`). From the repository root:
 *
 *   node --import tsx apps/server/scripts/docker-check.ts
 *
 * It starts a server with the Fake provider and a GitHub project set to `docker`, then checks
 * that a session gets a container of its own and that, in it, the session clones the repo,
 * streams a turn, shows files and diffs, opens a terminal, makes MCP calls, and pushes and opens
 * a pull request. Then that a server restart continues in the same container, that archiving
 * removes the container and its volume, and that no secret shows up in what Docker keeps.
 *
 * Test remotes: the repository is served over git's smart HTTP, on https with a throwaway
 * self-signed certificate (`openssl` makes it), from this machine. The container reaches it as
 * `host.docker.internal` (Docker Desktop) and trusts the certificate for that one URL. The clone,
 * fetch and push need a brokered test credential, sent only for an https origin. GitHub's API is
 * the in-memory fake from the test suite. Nothing leaves this machine.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TERMINAL_CONTROL_PREFIX } from "@agent-rishi/contracts";
import WebSocket from "ws";
import { type RunningServer, type StartServerOptions, startServer } from "../src";
import { DockerBackend } from "../src/execution/docker/backend";
import { type Exec, runTool } from "../src/services/exec";
import { listSessionFiles } from "../src/services/files/session-files";
import type { GitBroker } from "../src/services/git-broker";
import { isRemoteRunner } from "../src/services/runner-port";
import { FakeGithub } from "../test/support/fake-github";

const TOKEN = "c".repeat(64);
/** The brokered git credential: it must reach no image, container config, env or log. */
const SENTINEL = "ghs_DOCKER_CHECK_never_stored_4e1d";
const base = mkdtempSync(join(tmpdir(), "agent-rishi-docker-check-"));
const logs: string[] = [];
let failures = 0;
/** Containers this check made (to remove them if a step fails before archive does). */
const madeHere = new Set<string>();

const sh = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 }).trim();
const docker = (...args: string[]) => sh("docker", args);

async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return value;
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(what);
}

async function waitFor(what: string, done: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A throwaway self-signed certificate for `host.docker.internal`. */
function selfSigned(dir: string): { key: string; cert: string } {
  sh("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
    "-subj",
    "/CN=host.docker.internal",
    "-addext",
    "subjectAltName=DNS:host.docker.internal",
  ]);
  return {
    key: readFileSync(join(dir, "key.pem"), "utf8"),
    cert: readFileSync(join(dir, "cert.pem"), "utf8"),
  };
}

/** git's smart HTTP (https) for the bare repositories in `root`, behind basic auth with `SENTINEL`. */
function gitHttpServer(
  root: string,
  tls: { key: string; cert: string },
): { server: Server; authorized: () => number } {
  let authorized = 0;
  const expected = `Basic ${Buffer.from(`x-access-token:${SENTINEL}`).toString("base64")}`;
  const server = createServer(tls, (req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test remote"' }).end();
      return;
    }
    authorized++;
    const url = new URL(req.url ?? "/", "http://remote");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x-access-token",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      },
      windowsHide: true,
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const at = line.indexOf(":");
        const key = line.slice(0, at).trim();
        const value = line.slice(at + 1).trim();
        if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      sent = true;
    });
    cgi.stdout.on("end", () => res.end());
    cgi.stderr.on("data", (d: Buffer) => logs.push(`git-http: ${d.toString().trim()}`));
  });
  return { server, authorized: () => authorized };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function main(): Promise<void> {
  console.log(`docker ${docker("version", "--format", "{{.Server.Version}}")}; work dir ${base}`);

  await step("detect reports a missing docker and a daemon that can't be reached", async () => {
    const missing = await new DockerBackend({
      home: base,
      command: "docker-not-installed",
    }).detect();
    check(missing.code === "not_found", `missing docker: ${missing.code}`);
    const unreachable: Exec = (cmd, args, opts) =>
      runTool(cmd, args, { ...opts, env: { ...opts?.env, DOCKER_HOST: "tcp://127.0.0.1:9" } });
    const down = await new DockerBackend({ home: base, exec: unreachable }).detect();
    check(down.code === "daemon_down", `daemon down: ${down.code} ${down.reason}`);
    console.log(`      not found: ${missing.reason}. ${missing.fix}`);
    console.log(`      daemon down: ${down.reason}. ${down.fix}`);
  });

  // The test remote and a fake GitHub API.
  const remotes = mkdtempSync(join(base, "remotes-"));
  const bare = join(remotes, "widgets.git");
  sh("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh("git", ["config", "http.receivepack", "true"], bare);
  const tls = selfSigned(remotes);
  const http = gitHttpServer(remotes, tls);
  const httpPort = await listen(http.server);
  const remoteUrl = `https://host.docker.internal:${httpPort}/widgets.git`;
  const work = mkdtempSync(join(base, "widgets-"));
  sh("git", ["init", "-q", "-b", "main"], work);
  writeFileSync(join(work, "README.md"), "# widgets\n");
  sh("git", ["add", "-A"], work);
  sh(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"],
    work,
  );
  sh("git", ["push", "-q", bare, "main"], work);
  sh("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], work);
  const gh = new FakeGithub();

  const credential = {
    scope: `https://host.docker.internal:${httpPort}`,
    username: "x-access-token",
    password: SENTINEL,
  };
  /** Test setup: the session's new container trusts the test remote's certificate (that URL only). */
  const trustTestRemote = (projectId: string) => {
    const container = docker(
      "ps",
      "--latest",
      "--quiet",
      "--filter",
      `label=agent-rishi.project=${projectId}`,
    );
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "1000:1000",
        container,
        "sh",
        "-c",
        "cat > /home/node/test-remote.pem",
      ],
      {
        input: tls.cert,
        windowsHide: true,
      },
    );
    docker(
      "exec",
      "--user",
      "1000:1000",
      container,
      "git",
      "config",
      "--global",
      `http.${credential.scope}/.sslCAInfo`,
      "/home/node/test-remote.pem",
    );
  };
  const gitBroker: GitBroker = {
    // Asked right before the clone, once the container runs.
    cloneUrl: async (project) => {
      trustTestRemote(project.id);
      return remoteUrl;
    },
    // As the real broker does for github.com (the PR push names the GitHub URL): only for a
    // runner other than the home runner, scoped to the test remote, where the clone points.
    credentialFor: async (port, url) =>
      isRemoteRunner(port) &&
      (url?.startsWith(credential.scope) || url?.startsWith("https://github.com/acme/"))
        ? credential
        : undefined,
    credentialForProject: async (port) => (isRemoteRunner(port) ? credential : undefined),
  };
  // `gh auth token` connects GitHub (the fake); git and docker run for real.
  const exec: Exec = (cmd, args, opts) =>
    cmd === "gh"
      ? Promise.resolve({
          code: 0,
          stdout: "tok-1\n",
          stderr: "",
          notFound: false,
          timedOut: false,
          path: "gh",
        })
      : runTool(cmd, args, opts);
  const home = join(base, "home");
  const options: StartServerOptions = {
    port: 0,
    dataDir: home,
    token: TOKEN,
    runner: false,
    enableFakeProvider: true,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: base,
    exec,
    github: { fetch: gh.fetch, baseUrl: "https://api.github.test", sync: false },
    gitBroker,
    sandboxConnectTimeoutMs: 180_000,
    log: (m) => logs.push(m),
  };
  let server: RunningServer = await startServer(options);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const projectId = (await step("a GitHub project is set to docker", async () => {
    const created = await api("POST", "/projects", { source: { type: "local", path: work } });
    const project = created.body.project as { id: string; kind: string };
    check(project.kind === "github", `project kind ${project.kind}`);
    const backends = await api("GET", `/execution/backends?projectId=${project.id}&refresh=true`);
    console.log(`      backends: ${JSON.stringify(backends.body.backends)}`);
    const patched = await api("PATCH", `/projects/${project.id}`, {
      execution: { backend: "docker" },
    });
    check(patched.status === 200, `PATCH ${patched.status} ${JSON.stringify(patched.body)}`);
    return project.id;
  })) as string;

  const sessionId = (await step(
    "a Fake session starts in a new container (image built if needed)",
    async () => {
      const started = await api("POST", "/sessions", {
        projectId,
        provider: "fake",
        input: { text: "Hello from the Docker check", attachments: [] },
      });
      const id = started.body.sessionId as string;
      await server.services.sessions.launching.get(id);
      await waitFor(
        "the first turn",
        () => server.services.sessionRepo.get(id).status === "idle",
        120_000,
      );
      return id;
    },
  )) as string;
  const session = () => server.services.sessionRepo.get(sessionId);
  const record = server.runners.list().find((r) => r.sessionId === sessionId);
  const container = record?.sandboxRef as string;
  const volume = `${container}-data`;
  if (container) madeHere.add(container);

  await step(
    "the container is labelled, non-root, limited, with --init and only its volume",
    () => {
      const [info] = JSON.parse(docker("inspect", container));
      const labels = info.Config.Labels as Record<string, string>;
      check(labels["agent-rishi.session"] === sessionId, "agent-rishi.session label");
      check(labels["agent-rishi.project"] === projectId, "agent-rishi.project label");
      check(Boolean(labels["agent-rishi.version"]), "agent-rishi.version label");
      check(info.Config.User === "1000:1000", `user ${info.Config.User}`);
      check(info.HostConfig.Init === true, "--init");
      check(info.HostConfig.Privileged === false, "not privileged");
      check(
        info.HostConfig.NanoCpus === 2e9 && info.HostConfig.Memory === 4096 * 1024 * 1024,
        "limits",
      );
      const mounts = info.Mounts.map((m: { Type: string; Name?: string }) => `${m.Type}:${m.Name}`);
      check(JSON.stringify(mounts) === JSON.stringify([`volume:${volume}`]), `mounts ${mounts}`);
      console.log(
        `      ${container}: user ${info.Config.User}, init, 2 CPUs, 4 GiB, mounts ${mounts}`,
      );
      console.log(
        `      env names: ${info.Config.Env.map((e: string) => e.split("=")[0]).join(", ")}`,
      );
    },
  );

  await step("the session cloned the repo inside the container", () => {
    check(session().cwd.startsWith("/data/ws/"), `cwd ${session().cwd}`);
    const log = docker(
      "exec",
      "--user",
      "1000:1000",
      container,
      "git",
      "-C",
      session().cwd,
      "log",
      "--oneline",
      "-1",
    );
    const origin = docker(
      "exec",
      "--user",
      "1000:1000",
      container,
      "git",
      "-C",
      session().cwd,
      "remote",
      "get-url",
      "origin",
    );
    check(origin === remoteUrl, `origin ${origin}`);
    console.log(`      ${session().cwd} on ${session().branch}: ${log}; origin ${origin}`);
  });

  await step("its turn streamed", () => {
    const events = server.store.listAfter(0, 100_000, [sessionId]);
    const deltas = events.filter((e) => e.type === "agent.item.delta").length;
    const reply = events
      .filter((e) => e.type === "agent.item.completed")
      .map((e) => (e.payload as { item?: { kind?: string; text?: string } }).item)
      .find((i) => i?.kind === "assistant_message")?.text;
    check(
      deltas > 1 && reply?.includes("Hello from the Docker check"),
      `deltas ${deltas}, reply ${reply}`,
    );
    console.log(`      ${deltas} deltas; reply "${reply}"`);
  });

  await step("files and diffs come from the container", async () => {
    docker(
      "exec",
      "--user",
      "1000:1000",
      "--workdir",
      session().cwd,
      container,
      "sh",
      "-c",
      "echo docker-check > notes.md",
    );
    const files = await listSessionFiles(server.services.workspaceFs(session()));
    check(
      files.entries.some((e) => e.path === "notes.md"),
      "notes.md listed",
    );
    const diff = await server.services.workbench.diff(sessionId, { kind: "uncommitted" });
    check(
      diff.files?.some((f) => f.path === "notes.md"),
      "notes.md in the diff",
    );
    console.log(
      `      files: ${files.entries.map((e) => e.path).join(", ")}; diff: ${diff.files?.map((f) => f.path).join(", ")}`,
    );
  });

  await step("a terminal opens in the container", async () => {
    const url = `${server.url.replace("http", "ws")}/ws/pty?sessionId=${sessionId}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    let output = "";
    ws.on("message", (data) => {
      const text = data.toString();
      if (!text.startsWith(TERMINAL_CONTROL_PREFIX)) output += text;
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    ws.send(JSON.stringify({ type: "input", data: "echo in-$(hostname)-as-$(id -u)\r" }));
    await waitFor(
      "the terminal's output",
      () => output.includes(`in-${container}-as-1000`),
      20_000,
    );
    ws.send(JSON.stringify({ type: "kill" }));
    ws.close();
    console.log(`      printed in-${container}-as-1000`);
  });

  // MCP calls made inside the container, as an agent would: through the runner's proxy there.
  const proxy = server.runners.client(record?.id as string)?.mcpProxyUrl as string;
  const mcpToken = server.services.mcpTokens.mint({ role: "agent", sessionId, projectId });
  const mcpCall = (name: string, args: Record<string, unknown>) => {
    const script = `let s="";process.stdin.on("data",d=>s+=d).on("end",async()=>{const {url,token,body}=JSON.parse(s);const r=await fetch(url,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify(body)});console.log(r.status+" "+(await r.text()))})`;
    const input = JSON.stringify({
      url: proxy,
      token: mcpToken,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    });
    // Async: the server runs in this process and must answer while the call waits.
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        "docker",
        ["exec", "-i", "--user", "1000:1000", container, "node", "-e", script],
        { windowsHide: true },
      );
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", reject);
      child.on("close", () => resolve(out.trim()));
      child.stdin.end(input);
    });
  };

  await step("an MCP call from inside the container reaches Agent Rishi", async () => {
    const answer = await mcpCall("report_progress", { text: "Checking Docker sandboxes" });
    check(answer.startsWith("200 "), answer.slice(0, 200));
    check(
      session().progress?.text === "Checking Docker sandboxes",
      `progress ${JSON.stringify(session().progress)}`,
    );
    console.log(`      report_progress: ${answer.slice(0, 120)}…`);
  });

  await step(
    "create_pull_request commits, pushes with the brokered credential and opens a PR",
    async () => {
      const before = http.authorized();
      const answer = await mcpCall("create_pull_request", {
        title: "docs: add notes",
        commitMessage: "docs: add notes",
      });
      check(answer.startsWith("200 ") && !answer.includes('"isError":true'), answer.slice(0, 300));
      const branch = session().branch as string;
      const pushed = sh("git", ["rev-parse", branch], bare);
      const pr = gh.requests.find((r) => r.method === "POST" && /\/pulls$/.test(r.path));
      check(pr, "no pull request was opened");
      check(http.authorized() > before, "the push did not authenticate");
      console.log(
        `      pushed ${branch} at ${pushed.slice(0, 8)}; PR ${JSON.stringify(pr?.body).slice(0, 120)}`,
      );
    },
  );

  const containerId = docker("inspect", "--format", "{{.Id}}", container);
  await step("after a server restart the session continues in the same container", async () => {
    await server.close();
    server = await startServer(options);
    await server.services.sandboxes.reattached;
    const client = server.runners.client(record?.id as string);
    await waitFor("the link", () => client?.status.state === "connected");
    check(docker("inspect", "--format", "{{.Id}}", container) === containerId, "a new container");
    await server.services.sessions.send(sessionId, {
      input: { text: "Still here after the restart", attachments: [] },
      whenBusy: "queue",
    });
    await waitFor("the reply", () =>
      server.store
        .listAfter(0, 100_000, [sessionId])
        .some(
          (e) =>
            e.type === "agent.item.completed" &&
            JSON.stringify(e.payload).includes("Still here after the restart"),
        ),
    );
    console.log(
      `      same container ${containerId.slice(0, 12)}, runner ${client?.status.runnerId}`,
    );
  });

  await step("no secret in docker inspect, the image, the container's env or the logs", () => {
    const image = `agent-rishi-runner:${record?.imageVersion}`;
    const places: Record<string, string> = {
      "docker inspect": docker("inspect", container),
      "image inspect": docker("image", "inspect", image),
      "image history": docker("history", "--no-trunc", image),
      "container env": docker("exec", container, "env"),
      "docker logs": sh("docker", ["logs", container]),
      "server log": logs.join("\n"),
    };
    for (const [where, text] of Object.entries(places)) {
      for (const [name, secret] of [
        ["git credential", SENTINEL],
        ["install token", TOKEN],
        ["MCP token", mcpToken],
        ["GitHub token", "tok-1"],
      ] as const) {
        check(!text.includes(secret), `${name} found in ${where}`);
      }
    }
    console.log(`      checked ${Object.keys(places).join(", ")}`);
  });

  await step("archiving removes the container and its volume", async () => {
    const result = await server.services.worktreeCleanup.archive(sessionId);
    check(
      result.worktree.status === "removed",
      `${result.worktree.status}: ${result.worktree.message}`,
    );
    check(
      docker("ps", "--all", "--quiet", "--filter", `name=^${container}$`) === "",
      "container still there",
    );
    check(
      docker("volume", "ls", "--quiet", "--filter", `name=^${volume}$`) === "",
      "volume still there",
    );
    console.log(`      ${container} and ${volume} are gone`);
  });

  await server.close();
  http.server.close();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) console.log(logs.slice(-40).join("\n"));
}

main()
  .catch((error: unknown) => {
    failures++;
    console.error(error);
    console.log(logs.slice(-40).join("\n"));
  })
  .finally(() => {
    // Containers and volumes this check made, should a step have left one behind.
    try {
      for (const name of docker(
        "ps",
        "--all",
        "--format",
        "{{.Names}}",
        "--filter",
        "label=agent-rishi.install",
      ).split(/s+/)) {
        if (name && madeHere.has(name)) {
          docker("rm", "--force", name);
          docker("volume", "rm", "--force", `${name}-data`);
        }
      }
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      console.log(`cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(failures === 0 ? 0 : 1);
  });
