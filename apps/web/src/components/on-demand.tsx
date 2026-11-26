/**
 * Heavy parts that only some panels need, each loaded from its own chunk the first time it
 * renders, so the terminal, the diff viewer and the code editor stay out of the entry chunk that
 * every first load downloads (see `apps/web/README.md`). Import these, not the modules behind
 * them; `apps/web/test/entry-chunk.test.ts` fails when a heavy library becomes reachable from the
 * entry again.
 */
import { lazyComponent } from "@/components/common/lazy-component";
import { Skeleton } from "@/components/ui/skeleton";

/** The terminal (`@xterm/xterm`). */
export const TerminalView = lazyComponent(() =>
  import("@/components/workbench/terminal-view").then((m) => m.TerminalView),
);

/** The right panel's Diff tab (`@pierre/diffs`). */
export const DiffPanel = lazyComponent(() =>
  import("@/components/workbench/diff-panel").then((m) => m.DiffPanel),
);

/** The right panel's Files tab (`@pierre/diffs`). */
export const FilesPanel = lazyComponent(() =>
  import("@/components/workbench/files-panel").then((m) => m.FilesPanel),
);

/** The code editor (`@codemirror/*`). */
export const CodeEditor = lazyComponent(() =>
  import("@/components/editor/code-editor").then((m) => m.CodeEditor),
);

/** The Factory view's Floor mode, a 3D workshop (`three`): loaded only when Floor is on. */
export const FloorScene = lazyComponent(() =>
  import("@/components/factory-view/floor/floor-scene").then((m) => m.FloorScene),
);

/** One file's diff from a patch (`@pierre/diffs`), such as a pull request's changed file. */
export const PatchDiff = lazyComponent(
  () => import("@pierre/diffs/react").then((m) => m.PatchDiff),
  <Skeleton className="m-2 h-16" />,
);

/** The diff between two versions of a file (`@pierre/diffs`). */
export const MultiFileDiff = lazyComponent(
  () => import("@pierre/diffs/react").then((m) => m.MultiFileDiff),
  <Skeleton className="m-2 h-16" />,
);
