import { parseArgs } from "node:util";
import { AGENT_RISHI_VERSION } from "@agent-rishi/contracts";

export const DEFAULT_PORT = 4317;

export const HELP = `agent-rishi ${AGENT_RISHI_VERSION}: a local-first harness for coding agents

Usage:
  agent-rishi [options]      Start Agent Rishi and open it in the browser
  agent-rishi doctor         Check the installation (--install: add Claude Code support now)
  agent-rishi update         Says how to update: from git (git pull, pnpm install, pnpm build)
  agent-rishi stop           Stop the server and the runner
  agent-rishi password       Set the network access password (--generate: make one up)
  agent-rishi network on|off Let phones on your network open Agent Rishi, or stop it
                         (on --loopback-only: stay on 127.0.0.1 behind a proxy such as Tailscale Serve)
  agent-rishi network origin add|remove|list <https-url>
                         HTTPS addresses of a proxy on this computer that Agent Rishi trusts
  agent-rishi runner-link    Connect stdin/stdout to the runner in --home (run by the server
                         inside a sandbox; stdout carries only protocol frames)

Options:
  --port <n>     Port to listen on (default ${DEFAULT_PORT})
  --home <dir>   Data directory (default ~/.agent-rishi, or AGENT_RISHI_HOME)
  --no-open      Do not open the browser
  -v, --version  Print the version
  -h, --help     Show this help
`;

/** The command line; throws on an unknown option. */
export function parseCli(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      home: { type: "string" },
      "no-open": { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      generate: { type: "boolean", default: false },
      "loopback-only": { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

export type ParsedCli = ReturnType<typeof parseCli>;
