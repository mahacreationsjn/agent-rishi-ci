import type { RiskAssessment } from "./assessment";
import { locationsThrough, ranLists, withFunctions } from "./blocks";
import { MAX_LOCATIONS } from "./locations";
import { keptWords } from "./ps-assignments";
import { codeScripts, readings, scriptContext, scriptsOf } from "./ran-scripts";
import type { SimpleCommand } from "./shell";
import { type Feed, within } from "./stdin-scripts";
import type { RiskContext } from "./targets";

/**
 * The walk the risk classifier (`./risk`) makes over a whole command line before anything else
 * (§11.2), for what every level asks about: Agent Rishi's own home and credentials, an agent CLI's
 * login, an agent's allow-list. The first verdict a check gives anywhere wins, so an earlier
 * ordinary risk (`cat .env; …`) can't hide one of those.
 */

/**
 * One simple command's verdict for `firstInList`. `feeds`: its output is used by another
 * command (it sits in a substitution or a pipe).
 */
export type CommandCheck = (
  cmd: SimpleCommand,
  ctx: RiskContext,
  feeds: boolean,
) => RiskAssessment | undefined;

/** A command line that may leave the shell in more folders than are followed (`./locations`). */
export const TOO_MANY_LOCATIONS: RiskAssessment = {
  risky: true,
  action: "outside_worktree",
  reason: "Changes folders in more ways than can be followed",
  always: true,
};

/**
 * The first verdict `check` gives anywhere in `list`: substitutions, subshells, blocks, called
 * functions (`./blocks`) and inline scripts (`bash -c "…"`) included, following `cd` like
 * `classifyList`.
 */
export function firstInList(
  list: SimpleCommand[],
  given: RiskContext,
  depth: number,
  check: CommandCheck,
  feeds = false,
): RiskAssessment | undefined {
  let heres = [withFunctions(list, given)];
  let head = 0;
  for (const [i, cmd] of list.entries()) {
    if (!cmd.piped) head = i;
    const piped = list[i + 1]?.piped === true;
    const feed = feedOf(list, i, head);
    for (const here of heres) {
      const inside = within(here, cmd, feed);
      for (const nested of cmd.nested) {
        const found = firstInList(nested, inside, depth, check, true);
        if (found) return found;
      }
      for (const ran of ranLists(cmd, inside)) {
        const found = firstInList(ran.list, ran.ctx, depth, check, feeds || piped);
        if (found) return found;
      }
      const scripts = [
        ...scriptsOf(cmd, here, depth, feed),
        ...codeScripts(cmd, here, depth, feed),
      ];
      for (const script of scripts) {
        const into = feeds || piped || script.feeds === true;
        const there = scriptContext(script, cmd, inside);
        for (const inner of readings(script, there)) {
          const found = firstInList(inner, there, depth + 1, check, into);
          if (found) return found;
        }
      }
      for (const one of withKept(cmd)) {
        const found = check(one, here, feeds || piped);
        if (found) return found;
      }
    }
    heres = locationsThrough(cmd, heres);
    // A location past the limit isn't checked, so it may be Agent Rishi's home: every level asks.
    if (heres.length > MAX_LOCATIONS) return TOO_MANY_LOCATIONS;
  }
  return undefined;
}

/** The pipe the command at `i` reads: the command at its `head`, and whether others sit between. */
export function feedOf(list: SimpleCommand[], i: number, head: number): Feed {
  return list[i]?.piped ? { source: list[head], filtered: i - 1 !== head } : {};
}

/** `cmd`, then what a PowerShell assignment in it keeps in its variable (`keptWords`). */
export function withKept(cmd: SimpleCommand): SimpleCommand[] {
  const kept = keptWords(cmd);
  return kept ? [cmd, kept] : [cmd];
}
