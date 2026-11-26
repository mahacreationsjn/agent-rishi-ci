import { createHash } from "node:crypto";

/**
 * One changed file of a PR with its unified patch against the merge base (null: none sent) and
 * its blob sha at the head (GitHub's per-file `sha`; null or absent: not sent).
 */
export interface PatchedFile {
  path: string;
  previousPath?: string;
  status: string;
  patch: string | null;
  sha?: string | null;
}

/** A hunk header (`@@ -12,6 +14,7 @@ function name`): where the hunk is, not what it changes. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/gm;

/**
 * A fingerprint of what a pull request itself changes (§10.1, Review): every file's path, status
 * and patch against the merge base, with the hunk headers left out (commits the default branch
 * gained elsewhere in a file only move its hunks). Merging the default branch in (update-branch)
 * or a rebase that brought only its commits in keeps the fingerprint, so an approval carries
 * over to that head (`approval.ts`). Any change to the PR's own lines, the lines around them, or
 * a file it adds, removes or renames changes it.
 *
 * A file GitHub sends no patch for (binary, too large: every migration's `snapshot.json`) counts
 * by its content: its blob sha at the head. An added one keeps it across an update-branch that
 * leaves it alone; a modified or renamed one gets a new blob whenever anyone changes it, the
 * default branch included, which owes a re-check (conservative). Null when it can't be told: a
 * patch-less file without a blob sha, or a file list GitHub cut short (`changedFiles` is more).
 */
export function prDiffKey(files: readonly PatchedFile[], changedFiles: number): string | null {
  if (files.length < changedFiles) return null;
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const f of sorted) {
    const previous = f.previousPath ?? null;
    if (f.patch !== null) {
      const body = f.patch.replace(HUNK_HEADER, "@@");
      hash.update(`${JSON.stringify([f.path, previous, f.status, body])}\n`);
    } else if (f.sha) {
      // A shape no patched file has (`{ blob }` where the patch would be).
      hash.update(`${JSON.stringify([f.path, previous, f.status, { blob: f.sha }])}\n`);
    } else {
      return null;
    }
  }
  return hash.digest("hex").slice(0, 24);
}
