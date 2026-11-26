import { describe, expect, it } from "vitest";
import { levelAllows } from "../src/codex/policy";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * Commands run through something else (§11.2): a file tool a package manager runs by name,
 * environments, sandboxes, terminals and schedulers that run a command, and a new crontab.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
  shell: "posix",
  agentRishiHome: "/home/me/.agent-rishi",
};
const ps: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  shell: "powershell",
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};

const levels = (command: string, ctx: RiskContext = posix) => {
  const risk = classifyCommand(command, ctx);
  return `${levelAllows("auto", risk) ? "-" : "auto"}/${levelAllows("full", risk) ? "-" : "full"}`;
};
const expectLevels = (expected: string, commands: string[], ctx: RiskContext = posix) => {
  for (const command of commands) expect(levels(command, ctx), command).toBe(expected);
};

describe("file tools a package manager runs by name", () => {
  it("are classified with their arguments", () => {
    expectLevels("auto/full", [
      "pnpm rimraf /other",
      "pnpm --filter web rimraf /other",
      "pnpm run rimraf /other",
      "yarn rimraf /other",
      "yarn run rimraf /other",
      "yarn workspace web rimraf /other",
      "bun run rimraf /other",
      "bun rimraf /other",
      "bunx rimraf /other",
      "npm exec rimraf /other",
      "npm run rimraf -- /other",
      "pnpm del-cli /other",
      "pnpm cpy src /other",
      "yarn cpx 'src/**' /other",
      "pnpm shx rm -rf /other",
      "yarn shx cp a /other/a",
      "pnpm --reporter silent rimraf /other",
    ]);
  });

  it("are classified when they are a shell, an interpreter or a variable setter", () => {
    expectLevels("auto/full", [
      "pnpm sh -c 'rm -rf /other'",
      "yarn bash -c 'rm -rf /other'",
      "bun run sh -c 'rm -rf /other'",
      "pnpm node -e \"require('fs').rmSync('/other', { recursive: true })\"",
      "pnpm cross-env A=1 rimraf /other",
      "pnpm dotenv -- rimraf /other",
    ]);
    expectLevels("-/-", [
      "pnpm node scripts/build.mjs",
      "pnpm sh -c 'echo hi'",
      "pnpm cross-env NODE_ENV=production vite build",
    ]);
  });

  it("leave script names, the manager's own commands and the worktree alone", () => {
    expectLevels("-/-", [
      "pnpm build",
      "pnpm test",
      "pnpm run build",
      "yarn test",
      "bun run dev",
      "npm run build",
      "pnpm rimraf dist",
      "yarn cpy src dist",
      "pnpm add -D rimraf",
      "npm install rimraf",
    ]);
  });
});

describe("more wrappers", () => {
  it("classify the command they run", () => {
    expectLevels("auto/full", [
      "wsl rm -rf /other",
      "wsl -d Ubuntu -- rm -rf /other",
      "wsl --cd /other rm -rf x",
      "conda run -n env rm -rf /other",
      "mise exec -- rm -rf /other",
      "mise x node@20 -- rm -rf /other",
      "mise exec -c 'rm -rf /other'",
      "hatch run rm -rf /other",
      "pipenv run rm -rf /other",
      "poetry run rm -rf /other",
      "direnv exec . rm -rf /other",
      "dotenv -- rm -rf /other",
      "dotenv -e .env.test rm -rf /other",
      "doppler run -- rm -rf /other",
      "doppler run --command 'rm -rf /other'",
      "cross-env NODE_ENV=test rm -rf /other",
      "cross-env-shell 'rm -rf /other'",
      "fakeroot rm -rf /other",
      "unshare -r rm -rf /other",
      "runuser -u bob -- rm -rf /other",
      "runuser bob -c 'rm -rf /other'",
      "gosu bob rm -rf /other",
      "script -c 'rm -rf /other' /dev/null",
      "script -qc 'rm -rf /other' /dev/null",
      "script -q /dev/null rm -rf /other",
      "su -lc 'rm -rf /other'",
      "tmux new -d 'rm -rf /other'",
      "tmux new-session -d -s build rm -rf /other",
      "tmux split-window -c /other 'rm -rf x'",
      "screen -dm rm -rf /other",
      "screen -dmS build rm -rf /other",
      "parallel rm -rf ::: /other",
      "parallel 'rm -rf {}' ::: /other",
      "parallel ::: 'rm -rf /other'",
      "ls /other | parallel rm",
      "echo 'rm -rf /other' | at now",
      "at now + 1 hour <<< 'rm -rf /other'",
      "echo 'rm -rf /other' | batch",
    ]);
    expectLevels("auto/full", ["wsl rm -rf /mnt/c/other", "wsl cp x /mnt/d/y"], ps);
    expect(classifyCommand("wsl cat /mnt/c/Users/me/.agent-rishi/install-token", ps)).toMatchObject(
      {
        agentRishi: true,
      },
    );
  });

  it("leave ordinary runs alone", () => {
    expectLevels("-/-", [
      "poetry run pytest",
      "gosu node pnpm test",
      "runuser -u node -- pnpm test",
      "cross-env NODE_ENV=test vitest",
      "conda run -n env pytest",
      "conda install numpy",
      "mise x node@20 -- node -v",
      "mise exec node@20",
      "pipenv run pytest",
      "hatch run test",
      "doppler run -- pnpm dev",
      "unshare -r pnpm test",
      "tmux new -d 'pnpm dev'",
      "tmux ls",
      "screen -ls",
      "screen -dmS dev pnpm dev",
      "wsl --list --verbose",
      "parallel -j4 pnpm test ::: a b",
      "echo 'pnpm test' | at now",
      "at -l",
    ]);
  });
});

describe("a new crontab", () => {
  it("asks as a write outside the worktree", () => {
    expectLevels("auto/full", [
      "echo '* * * * * true' | crontab -",
      "crontab - <<'EOF'\n* * * * * true\nEOF",
      "crontab jobs.txt",
      "crontab -u bob jobs.txt",
      "crontab -r",
      "crontab -e",
    ]);
  });

  it("doesn't ask to list it", () => {
    expectLevels("-/-", ["crontab -l", "crontab -u bob -l"]);
  });
});
