import { type RiskAssessment, risky } from "./assessment";

/**
 * Commands that stay installed and run later on their own (§11.2): a new crontab. `crontab -`
 * (read on the input), `crontab file`, `crontab -e` and `crontab -r` replace, edit or remove the
 * user's crontab, outside the worktree, so they ask as a write there; `crontab -l` only lists it.
 * What `at` and `batch` schedule is read on their input and judged like any script
 * (`./stdin-scripts`).
 */

/** `crontab`'s options that only show something: list, version, test a file's syntax. */
const SHOWS = /^-[lVT]$/;
/** `crontab`'s options that take a value: the user, the host of a cluster. */
const VALUED = /^-[uc]$/;

/** The verdict on `crontab` and its `args`; undefined for any other program, or a listing. */
export function crontabChange(bin: string, args: readonly string[]): RiskAssessment | undefined {
  if (bin !== "crontab") return undefined;
  const words = args.filter((a, i) => !VALUED.test(a) && !VALUED.test(args[i - 1] ?? ""));
  if (words.some((a) => SHOWS.test(a))) return undefined;
  return risky("outside_worktree", "Changes the user's crontab, which runs commands later");
}
