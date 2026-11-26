import { currentGitBranch } from "../util/git-head";
import { agentPermissionsCommand } from "./agent-permissions";
import { agentRishiCommand, pathsOf } from "./agent-rishi-command";
import { asksAtEveryLevel, mostSevere, type RiskAssessment, risky, SAFE } from "./assessment";
import { listOnlyReads, locationsThrough, ranLists, withFunctions } from "./blocks";
import { binName, DISCARD, unwrap } from "./command-words";
import { copyWrites } from "./copies";
import { redefinesFolderCommands } from "./current-folder";
import { classifyDelete, listedPaths } from "./deletes";
import { downloadWrites } from "./downloads";
import { dumpsEnvironment } from "./env-dumps";
import { type ListOutput, namesOnly } from "./env-names";
import { feedOf, firstInList, TOO_MANY_LOCATIONS, withKept } from "./first-in-list";
import { classifyGit } from "./git";
import { inlineCodePaths, inlineCodeWrites } from "./inline-code";
import { inlineScripts } from "./inline-scripts";
import { classifyInstall } from "./installs";
import { itemWrites } from "./item-writes";
import { MAX_LOCATIONS, moveTo } from "./locations";
import { isInside, isSecretPath, resolveAgainst } from "./paths";
import { projectConfigCommand } from "./project-config";
import { providerLoginCommand } from "./provider-logins";
import { dotnetWrites } from "./ps-dotnet";
import {
  codeOf,
  codeScripts,
  MAX_DEPTH,
  readings,
  scriptContext,
  scriptsOf,
  tooDeep,
} from "./ran-scripts";
import { programDenial } from "./read-only";
import { registryChange, registryExports } from "./registry";
import { pipesDownloadIntoInterpreter } from "./remote-scripts";
import { agentRishiFolderRisk, folderRisk } from "./run-folder";
import { crontabChange } from "./schedules";
import { secretArgument, toolOutputs } from "./secrets";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";
import { type Feed, within } from "./stdin-scripts";
import { classifyRead, classifyWrite, type RiskContext } from "./targets";
import { UNRESOLVED, unresolvedTarget } from "./variables";
import { gitWrites, toolWrites } from "./write-tools";

export { classifyFetch, classifyGlob, classifyRead, classifyWrite } from "./targets";
/**
 * Risky-action classifier for the `auto` and `full` autonomy levels (§11.2). Provider-neutral:
 * adapters translate their tool calls into `classifyCommand` / `classifyWrite` /
 * `classifyRead` / `classifyFetch` calls. A risky result is turned into an approval request;
 * everything else runs freely. Writes inside the worktree, the extra roots and the OS temp
 * directory are not risky; secrets files are, wherever they are. This file judges command lines;
 * `./targets`, a file, a search or a fetch.
 */
export type { RiskAssessment, RiskContext };

/** Why a script that isn't all written out asks (`eval "$CMD"`, `… | sh`; `./ran-scripts`). */
const UNKNOWN = "Runs a command that is only known when it runs";

/**
 * Classify a shell command (any shell: POSIX, PowerShell or cmd), in each way its shell may read
 * its escapes (`./shell-readings`). Downloads piped into an interpreter (`curl … | sh`,
 * `irm … | iex`) are found on the parsed pipeline in `classifyList`; here, a download run through
 * a substitution (`iex (irm …)`, `bash -c "$(curl …)"`, `bash <(curl …)`). Agent Rishi's own home and
 * credentials, then the agent CLIs' logins, are looked for first, across the whole command, so an
 * earlier ordinary risk (`cat .env; …`) can't hide them.
 */
export function classifyCommand(command: string, given: RiskContext): RiskAssessment {
  // `CDPATH` sends a `cd` to a relative folder anywhere it lists, and `GIT_DIR`, `GIT_WORK_TREE`
  // or another `PATH` a `cd` to the repository's top folder elsewhere (#614). A function or an
  // alias may make `pwd`, `Get-Location` or `git` print any folder (#663).
  const ctx = {
    ...given,
    cdPath: given.cdPath || /\bCDPATH\b/.test(command),
    gitEnv:
      given.gitEnv ||
      /\bGIT_(?:DIR|WORK_TREE)\b|\bPATH\b/.test(command) ||
      /\benv:path\b|SetEnvironmentVariable/i.test(command),
    redefines: given.redefines || redefinesFolderCommands(command),
  };
  // Every part is weighed, and the most severe verdict returned (#627): a risk Full allows (a
  // downloaded script, a force push) must not hide a later write outside the worktree.
  const found: RiskAssessment[] = [];
  if (
    /\b(iex|invoke-expression)\b[^|]*\b(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)\b/i.test(
      command,
    )
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  if (
    /\b(bash|sh|zsh)\s+(-c\s+)?["']?\$\(\s*(curl|wget)\b/i.test(command) ||
    /<\(\s*(curl|wget)\b/i.test(command)
  ) {
    found.push(risky("network", "Executes a downloaded script"));
  }
  for (const list of shellReadings(command, ctx.shell ?? "auto", ctx)) {
    // What every level asks about, looked for across the whole command first: Agent Rishi's own home
    // and credentials (and a command run there), an agent CLI's login, then a write of an agent's
    // own allow-list.
    const always =
      firstInList(list, ctx, 0, agentRishiCommand) ??
      firstInList(list, ctx, 0, (cmd, here) => agentRishiFolderRisk(cmd, here)) ??
      firstInList(list, ctx, 0, (cmd, here) => providerLoginCommand(cmd, here)) ??
      firstInList(list, ctx, 0, (cmd, here) => agentPermissionsCommand(cmd, here));
    found.push(always ?? classifyList(list, ctx, 0));
  }
  return mostSevere(found);
}

/** A script nested deeper than is followed (`MAX_DEPTH`): what it runs isn't read. */
const TOO_DEEP: RiskAssessment = {
  risky: true,
  action: "outside_worktree",
  reason: "Runs a command nested too deep to read",
  always: true,
};

/**
 * Classify commands in order, and return the most severe verdict of them all (`mostSevere`), not
 * the first: Full allows some risks, and one of those must not hide a later one it asks about
 * (`git push --force && rm -rf ~/x`, #627). A `cd` moves where later relative paths resolve;
 * commands in substitutions and subshells are classified too, without their `cd` leaking out, and
 * so are those in blocks and called functions, whose `cd` may (`./blocks`). `output`: where the
 * list's output goes, which decides whether an environment listing that keeps only the names is a
 * dump (`./env-names`): substitutions hand theirs to another command, except a `(…).Name` group,
 * which keeps only the names itself.
 */
function classifyList(
  list: SimpleCommand[],
  given: RiskContext,
  depth: number,
  output: ListOutput = "shown",
): RiskAssessment {
  const found: RiskAssessment[] = [];
  if (pipesDownloadIntoInterpreter(list)) {
    found.push(risky("network", "Pipes a downloaded script straight into a shell"));
  }
  const names = namesOnly(list, output);
  // Where the shell may be: one location, unless a pop or a block may or may not happen.
  let heres = [withFunctions(list, given)];
  let head = 0;
  for (const [i, cmd] of list.entries()) {
    if (!cmd.piped) head = i;
    const shown = output === "shown" && list[i + 1]?.piped !== true;
    const at = { namesOnly: names.listings.has(i), shown, ...feedOf(list, i, head) };
    for (const here of heres) {
      const inside = within(here, cmd, at);
      for (const [k, nested] of cmd.nested.entries()) {
        const into = k === 0 && names.projections.has(i) ? "names" : "feeds";
        found.push(classifyList(nested, inside, depth, into));
      }
      for (const ran of ranLists(cmd, inside)) {
        found.push(classifyList(ran.list, ran.ctx, depth, shown ? "shown" : "feeds"));
      }
      const placed = { ...at, inside };
      for (const one of withKept(cmd)) found.push(classifySimple(one, here, depth, placed));
    }
    heres = locationsThrough(cmd, heres);
    if (heres.length > MAX_LOCATIONS) return mostSevere([...found, TOO_MANY_LOCATIONS]);
  }
  return mostSevere(found);
}

/**
 * Where a simple command stands in its list. `namesOnly`: it lists the environment but only the
 * names reach the agent (`./env-names`). `shown`: its output reaches the agent, not another command.
 * `source` and `filtered`: the pipe it reads (`Feed`; `./deletes`, `./stdin-scripts`).
 */
interface Placement extends Feed {
  namesOnly: boolean;
  shown: boolean;
  /** The context of what the command runs inside itself, which reads its input (`within`). */
  inside: RiskContext;
}

/**
 * One simple command's verdict. Anything but a read run outside the worktree asks as a write there
 * (`./run-folder`, #614), so Full asks too: that beats a risk Full lets through (a force push in
 * another repository), while a write outside the worktree the checks found keeps its own reason.
 * What a shell's inline script or `Start-Process` runs is judged where it runs instead, unless the
 * shell is handed another repository (`GIT_DIR=… bash -c …`), which its script would use.
 */
function classifySimple(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const verdict = classifyActions(cmd, ctx, depth, at);
  if (verdict.risky && (verdict.action === "outside_worktree" || asksAtEveryLevel(verdict))) {
    return verdict;
  }
  const { tokens, assigns } = unwrap(cmd.words);
  const scripts =
    depth < MAX_DEPTH ? inlineScripts(binName(tokens[0]), tokens.slice(1), cmd, at.source) : [];
  const gitVars = assigns.some((a) => /^GIT_(?:DIR|WORK_TREE)=/.test(a));
  return (scripts.length > 0 && !gitVars ? undefined : folderRisk(cmd, ctx)) ?? verdict;
}

/**
 * What one simple command does: the classifier's checks, wherever it runs. Every check is made,
 * and the most severe verdict returned: `sudo rm -rf ~/x` is a delete outside the worktree, not
 * only an elevated command, and so is the script an elevated `Start-Process` runs.
 */
function classifyActions(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  at: Placement,
): RiskAssessment {
  const { tokens, elevated, chdir } = unwrap(cmd.words);
  const found: RiskAssessment[] = [];
  if (elevated) found.push(risky("other", "Runs a command with elevated privileges"));
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  // A block that never closes can't be read, so it asks unless the command only reads.
  if (cmd.unparsed && programDenial(bin, args) !== undefined) {
    found.push(risky("other", "Runs a block that never closes, so what it runs can't be read"));
  }

  // Inline scripts (`bash -c "…"`, `eval "…"`), the commands of cmd's `for` loop, what
  // Start-Process starts, a script read on the input and what another tool runs (`./ran-scripts`).
  const ran: RiskAssessment[] = [];
  // What a tool runs on the files it is given comes after the command's own verdict.
  const late: RiskAssessment[] = [];
  for (const script of scriptsOf(cmd, ctx, depth, at)) {
    if (script.elevated) found.push(risky("other", "Runs a command with elevated privileges"));
    const output = at.shown && !script.feeds ? "shown" : "feeds";
    const there = scriptContext(script, cmd, { ...ctx, stdin: at.inside.stdin });
    const lists = readings(script, there);
    const into = script.commands ? late : ran;
    for (const list of lists) into.push(classifyList(list, there, depth + 1, output));
    if (script.dynamic && !lists.every(listOnlyReads))
      ran.push(risky("other", `${UNKNOWN} (${bin})`));
  }
  if (tooDeep(cmd, ctx, depth, at)) found.push(TOO_DEEP);
  for (const script of codeScripts(cmd, ctx, depth, at)) {
    for (const list of shellReadings(script.text, script.dialect, ctx)) {
      const guess = classifyList(list, ctx, depth + 1, "feeds");
      if (guess.risky && (guess.action === "outside_worktree" || guess.action === "secrets")) {
        ran.push(guess);
      }
    }
  }
  const code = codeOf(cmd, at, ctx);
  if (code.unknown) ran.push(risky("other", `${UNKNOWN} (${bin})`));
  // A risk that was read comes before one that is only "unknown".
  const unknown = (r: RiskAssessment) => r.risky && r.reason.startsWith(UNKNOWN);
  found.push(...ran.filter((r) => !unknown(r)), ...ran.filter(unknown));

  // A target a variable only names when the command runs counts as outside (`./variables`).
  const write = (target: string, where: RiskContext): RiskAssessment =>
    unresolvedTarget(cmd, target, where)
      ? risky("outside_worktree", `Writes ${target}, ${UNRESOLVED}`)
      : classifyWrite(target, where);
  for (const target of cmd.writes) {
    if (!DISCARD.test(target)) found.push(write(target, ctx));
  }
  // Where `sudo -D dir` or `env -C dir` runs it, its own paths resolve.
  const here = chdir.reduce((at, dir) => moveTo(dir, at), ctx);

  if (bin === "git") {
    const verdict = classifyGit(args, {
      ownBranch: ctx.ownBranch,
      currentBranch: ctx.currentBranch ?? (() => currentGitBranch(ctx.cwd)),
      inWorktree: isInside(resolveAgainst(".", ctx), ctx.cwd, ctx),
    });
    // `git checkout <ref> -- .agent-rishi/project.json` writes Agent Rishi's project config.
    found.push(verdict.risky ? verdict : (projectConfigCommand(cmd, ctx) ?? SAFE));
    for (const target of gitWrites(args)) found.push(write(target, here));
    return mostSevere([...found, ...late]);
  }

  found.push(
    classifyInstall(
      bin,
      args.map((a) => a.toLowerCase()),
    ),
  );
  found.push(classifyDelete(cmd, ctx, at.source));
  const registry = registryChange(bin, args, tokens);
  if (registry) found.push(registry);
  found.push(crontabChange(bin, args) ?? SAFE);

  const copies = copyWrites(bin, args, ctx);
  const outputs = [...toolOutputs(bin, args), ...registryExports(bin, args)];
  const items = itemWrites(cmd, ctx, at.source);
  const downloads = downloadWrites(cmd, ctx);
  const written = [...copies.words, ...outputs, ...items.words, ...downloads.words];
  const targets = [...outputs, ...items.targets, ...downloads.targets];
  // A copy's destination is judged as written: into temp, its targets are named after the
  // files copied, which stay in that folder whatever they are called.
  const dest = copies.words.find((word) => unresolvedTarget(cmd, word, ctx));
  if (dest !== undefined) found.push(risky("outside_worktree", `Writes ${dest}, ${UNRESOLVED}`));
  else for (const target of copies.targets) found.push(classifyWrite(target, ctx));
  for (const target of targets) found.push(write(target, ctx));
  for (const target of toolWrites(bin, args)) found.push(write(target, here));
  // PowerShell's .NET file calls (`[IO.File]::Delete(…)`, `./ps-dotnet`).
  const dotnet = dotnetWrites(cmd);
  const handed = dotnet.piped && at.source ? listedPaths(at.source, ctx) : [];
  for (const target of [...dotnet.targets, ...handed]) found.push(classifyWrite(target, ctx));
  if (dotnet.unknown) found.push(risky("outside_worktree", `Writes ${UNRESOLVED}`));
  for (const item of dotnet.reads) found.push(classifyRead(item, ctx));
  // A one-liner's code (`./inline-code`): the rooted paths it names, when it writes or deletes, and
  // every path it names, read as `cat` would read it.
  for (const text of code.code) {
    for (const target of inlineCodeWrites(text)) {
      const write = classifyWrite(target, here);
      if (write.risky && write.action !== "file_change") found.push(write);
    }
    for (const item of inlineCodePaths(text)) found.push(classifyRead(item, here));
  }

  // A file PowerShell's variable syntax reads (`${C:\Users\me\.ssh\id_rsa}`), whatever the command.
  for (const item of cmd.reads ?? []) found.push(classifyRead(item, ctx));

  // Secrets: any argument (or element of a PowerShell list) that reads a credentials file.
  const secret = secretArgument(bin, args, written, isSecretPath, pathsOf(cmd));
  if (secret) found.push(risky("secrets", `Accesses the secrets file ${secret}`));

  if (!at.namesOnly && dumpsEnvironment(bin, args)) {
    found.push(risky("secrets", "Dumps environment variables"));
  }
  // Agent Rishi's project config: `sed -i`, `git checkout --` and inline code reach it too.
  found.push(projectConfigCommand(cmd, ctx) ?? SAFE);
  return mostSevere([...found, ...late]);
}
