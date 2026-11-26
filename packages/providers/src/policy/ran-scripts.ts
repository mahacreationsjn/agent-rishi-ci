import { binName, unwrap } from "./command-words";
import { inlineCode, inlineCodeCommands } from "./inline-code";
import { type InlineScript, inlineScripts } from "./inline-scripts";
import { moveTo } from "./locations";
import { isWin } from "./paths";
import type { SimpleCommand } from "./shell";
import { shellReadings } from "./shell-readings";
import { type Feed, stdinCode, stdinScripts } from "./stdin-scripts";
import type { RiskContext } from "./targets";
import { toolScripts } from "./tool-scripts";

/**
 * Everything one simple command runs beside itself (§11.2), for the risk classifier to judge like
 * a command line of its own: a shell's inline script (`./inline-scripts`), a script it reads on
 * its input (`./stdin-scripts`), the commands another tool runs (`./tool-scripts`), and the code
 * of an interpreter's one-liner (`./inline-code`).
 */

/** How deep `bash -c "…"` style inline scripts are followed. */
export const MAX_DEPTH = 4;

/** The command lines `cmd` runs, while they are still followed. `feed`: the pipe it reads. */
export function scriptsOf(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  feed: Feed,
): InlineScript[] {
  if (depth >= MAX_DEPTH) return [];
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  const scripts = [
    ...inlineScripts(bin, args, cmd, feed.source),
    ...toolScripts(cmd, bin, args, ctx, feed),
  ];
  // What the shell itself runs, or reads from a heredoc it filled in, sees the shell's variables.
  const fed = stdinScripts(cmd, bin, args, feed, ctx);
  const inShell = SAME_SHELL.has(bin) ? scripts : [];
  const scoped = [...inShell, ...fed].map((script) => ({ ...script, scope: cmd.scope }));
  return [...(SAME_SHELL.has(bin) ? [] : scripts), ...scoped];
}

/** Commands whose string runs in the shell they are in: its variables are set there too. */
const SAME_SHELL = new Set(["eval", "iex", "invoke-expression", "trap", "alias", "source", "."]);

/** True when `cmd` runs a script nested deeper than is followed, so what it runs isn't read. */
export function tooDeep(cmd: SimpleCommand, ctx: RiskContext, depth: number, feed: Feed): boolean {
  return depth >= MAX_DEPTH && scriptsOf(cmd, ctx, 0, feed).length > 0;
}

/** The ways `script` may be read (`./shell-readings`), or its commands when it gives them. */
export function readings(script: InlineScript, ctx: RiskContext): SimpleCommand[][] {
  if (script.commands) return [script.commands];
  return shellReadings(script.text, script.dialect, ctx, script.scope);
}

/**
 * Where an inline script of `cmd` runs: where `env -C` moved it (`env -C dir bash -c …`), then in
 * its own folder when it names one (`Start-Process -WorkingDirectory`), in a new process, which
 * starts with a location stack of its own, and in the shell that reads it.
 */
export function scriptContext(
  script: InlineScript,
  cmd: SimpleCommand,
  ctx: RiskContext,
): RiskContext {
  const shell = script.commands ? ctx.shell : script.dialect;
  let fresh: RiskContext = { ...ctx, pushed: undefined, shell };
  for (const dir of unwrap(cmd.words).chdir) fresh = moveTo(dir, fresh);
  return script.dir ? moveTo(script.dir, fresh) : fresh;
}

/** The code an interpreter runs for `cmd`, and whether some of it is only known when it runs. */
export interface RanCode {
  code: string[];
  unknown: boolean;
}

/**
 * The code of an interpreter's one-liner (`python -c "…"`) and what it reads on its input
 * (`python - <<EOF`, `echo '…' | node`).
 */
export function codeOf(cmd: SimpleCommand, feed: Feed, ctx: RiskContext): RanCode {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const input = stdinCode(cmd, bin, feed, ctx);
  const code = inlineCode(bin, tokens.slice(1));
  return { code: input?.text ? [...code, input.text] : code, unknown: input?.dynamic === true };
}

/**
 * The command lines the code of an interpreter's one-liner may run (`./inline-code`:
 * `python -c "os.system('…')"`), read from its string literals. A guess, so only what they write
 * or delete outside the worktree, and what every level asks about, counts.
 */
export function codeScripts(
  cmd: SimpleCommand,
  ctx: RiskContext,
  depth: number,
  feed: Feed,
): InlineScript[] {
  if (depth >= MAX_DEPTH) return [];
  const dialect = isWin(ctx) ? "auto" : "posix";
  const bin = binName(unwrap(cmd.words).tokens[0]);
  return codeOf(cmd, feed, ctx)
    .code.flatMap((code) => inlineCodeCommands(code, bin))
    .map((text) => ({ text, dialect }));
}
