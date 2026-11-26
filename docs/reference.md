# Reference

The technical details behind Agent Rishi: where it keeps its data, how to configure it, the command-line options and how updates work. New to Agent Rishi? Start with the [README](../README.md) and [Getting started](getting-started.md).

## Configuration

| What | Where |
|---|---|
| Data directory | `~/.agent-rishi/`, or `AGENT_RISHI_HOME`, or `--home <dir>` |
| Port | `4317` by default, or `--port <n>`. The runner picks a free loopback port itself |
| Settings | **Settings** in the UI, stored in `<home>/settings.json` (non-secret) |
| Usage prices and budgets | **Usage** in the UI, stored in `<home>/usage-settings.json` |
| API keys | Settings, stored in the OS keychain |
| Per-project setup | `.agent-rishi/project.json` in the repo: worktree setup commands, the dev server and the project's checks |
| Automations | `~/.agent-rishi/automations/*.md` (all projects) and `<repo>/.agent-rishi/automations/*.md` |
| Project vision | `<repo>/.agent-rishi/VISION.md` (software and dark factory) |

Inside the data directory:

```
~/.agent-rishi/
  agent-rishi.db            SQLite database (event log + projections)
  settings.json         settings
  install-token         the per-install token (mode 600 where supported)
  server.json           running server's port and pid
  runner/               runner lock file and event journal
  wt/<project>/<id>/    agent worktrees (short paths for Windows)
  artifacts/            screenshots and files shared in chat
  orchestrator/         the orchestrator's working directory
  backups/              copies of config files taken before Agent Rishi overwrote them
  agent-config/         hooks you switched off on the Agents page (until you enable them)
  logs/runner.log       runner output
  deps/                 Claude Code support, installed on demand
  app/<version>/        Agent Rishi versions installed by one-click updates
  app/current.json      which installed version `agent-rishi` starts
```

Two copies can run side by side with different homes and ports, for example `agent-rishi --home ~/.agent-rishi-test --port 4400`.

A minimal `.agent-rishi/project.json`:

```json
{
  "setup": ["pnpm install"],
  "devServer": { "command": "pnpm dev", "port": 5173 },
  "checks": ["pnpm typecheck", { "command": "pnpm test", "timeoutSec": 900 }]
}
```

With `checks`, sessions can **keep going until checks pass**: after each turn Agent Rishi runs them in the session's worktree and sends failures back to the agent, up to a round cap.

## CLI reference

```
agent-rishi [options]      Start Agent Rishi and open it in the browser
agent-rishi doctor         Check the installation (--install: add Claude Code support now)
agent-rishi update         Install the latest version and switch to it (--rollback: go back)
agent-rishi stop           Stop the server and the runner
agent-rishi password       Set the network access password (--generate: make one up)
agent-rishi network on|off Let phones on your network open Agent Rishi, or stop it
agent-rishi runner-link    Connect stdin/stdout to the runner in --home (run by the server
                       inside a sandbox; stdout carries only protocol frames)

Options:
  --port <n>     Port to listen on (default 4317)
  --home <dir>   Data directory (default ~/.agent-rishi, or AGENT_RISHI_HOME)
  --no-open      Do not open the browser
  -v, --version  Print the version
  -h, --help     Show this help
```

- Running `agent-rishi` while it's already running prints the URL and opens it again.
- **Ctrl+C** stops the server; agents keep running in the runner. `agent-rishi stop` stops both.
- `agent-rishi doctor` exits non-zero when Agent Rishi can't run a session, and prints the one command that fixes each problem.
- Claude Code support (the Claude Agent SDK) isn't part of the package: it installs from npm into `~/.agent-rishi/deps/` the first time it's needed, or with `agent-rishi doctor --install`.

Environment variables: `AGENT_RISHI_HOME` (data directory), `AGENT_RISHI_DEBUG=1` (server log lines in the terminal), `AGENT_RISHI_SHELL` (terminal shell; PowerShell on Windows, `$SHELL` elsewhere), `AGENT_RISHI_GITHUB_SYNC=0` (turn GitHub polling off).

## Updating

> **Agent Rishi updates from git:** `git pull`, `pnpm install` and `pnpm build`, then restart it. Self-update is off (there is no npm package or release feed of its own), so the update banner below never shows and `agent-rishi update` says to use git. The rest of this section describes the update machinery the code still contains.

Agent Rishi checks npm for a new version when it starts and every 6 hours (only the package name is sent; turn it off under **Settings > General > Updates**). When one is out, a banner says so: **What's new** shows the release notes, **Update now** installs it and restarts Agent Rishi, and the page reconnects on its own. Running agents are drained and resumed, the same as after any runner restart.

- **How it works.** New versions install side by side into `~/.agent-rishi/app/<version>/`, and `~/.agent-rishi/app/current.json` names the one to run. Whatever `agent-rishi` you start (`agent-rishi`, a global install) checks that file first and runs the newer installed version in its place, so there's nothing to reinstall by hand. The previous version is kept for rollback.
- **Install automatically.** Set **Updates** to *Install automatically* to download new versions in the background; they start the next time you open Agent Rishi (or right away with **Restart now**).
- **From the terminal.** `agent-rishi update` does the same as the button (and restarts a running Agent Rishi); `agent-rishi update --rollback` goes back to the previous version. `agent-rishi doctor` lists the installed versions and which one starts.
- **Roll back** from **Settings > About** as well.
- **If it can't restart itself** (for example when started some other way), the banner says "Update installed, restart Agent Rishi to finish" with the command to run.
- **Running from source** (a clone of this repository) never switches versions: pull and rebuild (`git pull && pnpm install && pnpm build`).
- **The old way still works:** `npm i -g agent-rishi@latest`, or `agent-rishi@latest`. A globally installed version newer than the side-by-side one always wins.
- **Upgrading from 0.1.0:** 0.1.0 predates one-click updates; update it once by hand (`npm i -g agent-rishi@latest` or `agent-rishi@latest`).
- **The desktop app** updates itself from GitHub Releases with the same banner and the same setting; see [The desktop app](desktop.md#updates).

