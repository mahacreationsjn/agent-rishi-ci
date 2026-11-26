/**
 * What the first page load downloads: everything `src/main.tsx` reaches through static imports
 * ends up in the entry chunk (or a chunk it preloads), so it is fetched and parsed before Home,
 * the inbox or a session can render. That matters most on a phone over the LAN, where plain
 * http means no service worker caches the app.
 *
 * The heavy parts below are only needed in specific panels or pages, so they must sit behind a
 * dynamic `import()` (a lazy route or a lazy panel) and never be statically reachable from the
 * entry. `import type` is erased at build time and is not followed; `import()` is on demand.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseSync } from "vite";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const entry = resolve(src, "main.tsx");

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/** The parts the issue names: needed only in specific panels or pages. */
const HEAVY: { name: string; matches: (dep: string) => boolean }[] = [
  { name: "the terminal (@xterm/*)", matches: (d) => d.startsWith("@xterm/") },
  { name: "the diff viewer (@pierre/diffs)", matches: (d) => isPackage(d, "@pierre/diffs") },
  { name: "charts (recharts)", matches: (d) => isPackage(d, "recharts") },
  { name: "the code editor (@codemirror/*)", matches: (d) => d.startsWith("@codemirror/") },
  {
    name: "the Factory view and its scenes",
    matches: (d) =>
      d === "src/routes/factory-view.tsx" ||
      d.startsWith("src/components/factory-view/scene/") ||
      d.startsWith("src/components/factory-view/floor/"),
  },
  { name: "the 3D factory floor (three)", matches: (d) => isPackage(d, "three") },
];

function isPackage(dep: string, pkg: string): boolean {
  return dep === pkg || dep.startsWith(`${pkg}/`);
}

/** Resolves a local specifier to a source file, or `null` for assets (CSS, images, `?raw`). */
function resolveLocal(from: string, specifier: string): string | null {
  const bare = specifier.split("?")[0] ?? specifier;
  const base = bare.startsWith("@/") ? resolve(src, bare.slice(2)) : resolve(dirname(from), bare);
  const candidates = [
    base,
    ...CODE_EXTENSIONS.map((ext) => base + ext),
    ...CODE_EXTENSIONS.map((ext) => resolve(base, `index${ext}`)),
  ];
  const file = candidates.find((c) => CODE_EXTENSIONS.some((e) => c.endsWith(e)) && existsSync(c));
  if (file) return file;
  if (/\.[a-z0-9]+$/i.test(bare) && !CODE_EXTENSIONS.some((e) => bare.endsWith(e))) return null;
  throw new Error(`Cannot resolve "${specifier}" imported from ${relative(root, from)}`);
}

type Node = {
  type: string;
  source?: { value: string } | null;
  importKind?: string;
  exportKind?: string;
};

/** The specifiers a module loads at runtime when it is evaluated (no types, no `import()`). */
function staticImports(file: string): string[] {
  const { program, errors } = parseSync(file, readFileSync(file, "utf8"));
  if (errors.length > 0)
    throw new Error(`Cannot parse ${relative(root, file)}: ${errors[0]?.message}`);
  const out: string[] = [];
  for (const node of program.body as unknown as Node[]) {
    if (!node.source) continue;
    if (node.type === "ImportDeclaration" && node.importKind !== "type")
      out.push(node.source.value);
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.exportKind !== "type"
    ) {
      out.push(node.source.value);
    }
  }
  return out;
}

/**
 * Everything the entry reaches through static imports, keyed by a local path relative to the
 * web app (`src/...`) or a package specifier, with the import chain that reaches it.
 */
function entryGraph(): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const start = relative(root, entry).replaceAll("\\", "/");
  chains.set(start, [start]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const chain = chains.get(relative(root, file).replaceAll("\\", "/")) ?? [];
    for (const specifier of staticImports(file)) {
      const local = specifier.startsWith(".") || specifier.startsWith("@/");
      const target = local ? resolveLocal(file, specifier) : null;
      if (local && !target) continue;
      const key = target ? relative(root, target).replaceAll("\\", "/") : specifier;
      if (chains.has(key)) continue;
      chains.set(key, [...chain, key]);
      if (target) queue.push(target);
    }
  }
  return chains;
}

describe("the entry chunk (what loads before any page renders)", () => {
  const graph = entryGraph();

  it("walks the app from src/main.tsx", () => {
    expect(graph.has("src/router.tsx")).toBe(true);
    expect(graph.has("src/components/shell/app-shell.tsx")).toBe(true);
    expect(graph.has("react")).toBe(true);
  });

  it.each(HEAVY)("does not statically import $name", ({ matches }) => {
    const reached = [...graph.entries()]
      .filter(([dep]) => matches(dep))
      .map(([, chain]) => chain.join(" -> "));
    expect(reached).toEqual([]);
  });
});
