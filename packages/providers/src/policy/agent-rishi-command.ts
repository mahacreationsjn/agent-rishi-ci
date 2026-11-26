import {
  agentRishiAccess,
  credentialsRisk,
  forReading,
  touchesAgentRishiCredentials,
  touchesAgentRishiHome,
} from "./agent-rishi-home";
import {
  listsAgentRishiHome,
  reachesHomeThroughFolder,
  reachesThroughFolder,
} from "./agent-rishi-search";
import type { RiskAssessment } from "./assessment";
import { binName, CD, DISCARD, unwrap } from "./command-words";
import type { PathContext } from "./paths";
import { onlyReads } from "./read-only";
import { secretArgument } from "./secrets";
import { type SimpleCommand, type WordPaths, wordPaths } from "./shell";

/** How a verdict names what was touched in Agent Rishi's home (`agentRishiAccess`). */
export const AGENT_RISHI_WHAT = {
  credentials: "Agent Rishi's own credentials",
  home: "Agent Rishi's own home",
} as const;

/** The paths each word of `cmd` may stand for: itself, and a PowerShell list's elements. */
export const pathsOf =
  (cmd: SimpleCommand): WordPaths =>
  (word, from) =>
    wordPaths(cmd, word, from);

/**
 * One simple command's access to Agent Rishi's home (§11.2, #320), its credentials first: a
 * redirect onto a path there, any argument (or here-string) that reaches one (read, written,
 * copied or deleted), a listing of a folder there, or a search or listing that reaches it from a
 * folder above (`./agent-rishi-search`). The session's own worktree under the home is not part of
 * it, nor, for a command that only reads (`onlyReads`) and whose output feeds no other command,
 * its own artifacts folder (`forReading`, #338): output handed on could name files there to a
 * command that writes or deletes them. Moving into the home with `cd` reads nothing; the command
 * that then reads is caught. `feeds`: the command's output is used by another command (a pipe or
 * a substitution).
 */
export function agentRishiCommand(
  cmd: SimpleCommand,
  ctx: PathContext,
  feeds: boolean,
): RiskAssessment | undefined {
  const { tokens } = unwrap(cmd.words);
  const bin = binName(tokens[0]);
  const args = tokens.slice(1);
  for (const target of cmd.writes) {
    const access = DISCARD.test(target) ? undefined : agentRishiAccess(target, ctx);
    if (access) return credentialsRisk(`Writes ${AGENT_RISHI_WHAT[access]}: ${target}`);
  }
  for (const word of cmd.input ?? []) {
    const access = agentRishiAccess(word, ctx);
    if (access) return credentialsRisk(`Passes ${AGENT_RISHI_WHAT[access]}: ${word}`);
  }
  // A file PowerShell's variable syntax reads (`${C:\Users\me\.agent-rishi\agent-rishi.db}`).
  for (const item of cmd.reads ?? []) {
    const access = agentRishiAccess(item, feeds ? ctx : forReading(ctx));
    if (access) return credentialsRisk(`Reads ${AGENT_RISHI_WHAT[access]}: ${item}`);
  }
  if (CD.has(bin)) return undefined;
  const paths = pathsOf(cmd);
  const reads = (a: string) => touchesAgentRishiCredentials(a, ctx);
  const touched = secretArgument(bin, args, [], reads, paths);
  if (touched) return credentialsRisk(`Accesses Agent Rishi's own credentials: ${touched}`);
  const through = reachesThroughFolder(bin, args, ctx, feeds, paths);
  if (through) return credentialsRisk(`Reaches Agent Rishi's own credentials from ${through}`);
  const home = !feeds && onlyReads(bin, args) ? forReading(ctx) : ctx;
  const inHome = (a: string) => touchesAgentRishiHome(a, home);
  const opened = secretArgument(bin, args, [], inHome, paths);
  if (opened) return credentialsRisk(`Accesses Agent Rishi's own home: ${opened}`);
  const listed = listsAgentRishiHome(bin, args, home);
  if (listed) return credentialsRisk(`Lists Agent Rishi's own home: ${listed}`);
  const below = reachesHomeThroughFolder(bin, args, home, feeds, paths);
  return below ? credentialsRisk(`Reaches Agent Rishi's own home from ${below}`) : undefined;
}
