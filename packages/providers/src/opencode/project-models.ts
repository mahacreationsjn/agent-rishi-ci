import path from "node:path";
import type { ModelInfo, ProjectModels } from "@agent-rishi/contracts";
import { executableFingerprint } from "../freshness";
import type { ResolvedCommand } from "../util/exec";
import { readProjectConfig } from "./project-config";

/** Projects whose lists are kept at once; the oldest goes first. */
const MAX_PROJECTS = 32;

/**
 * Said when a project's list could not be loaded. It never quotes OpenCode's output, which may
 * echo the config (and the keys in it).
 */
const PROBE_FAILED =
  "OpenCode couldn't list its models with the project's OpenCode config, so the list without it is shown. Run `opencode models` in the project folder to see why.";

interface Entry {
  /** `readProjectConfig().fingerprint` the list was made with. */
  config: string;
  /** `executableFingerprint` of the `opencode` that made it. */
  exe: string | undefined;
  models: ModelInfo[];
}

export interface ProjectModelDeps {
  /** List models with a project's config layered in (`probeOpenCode`). */
  probe: (exe: ResolvedCommand, projectConfig: Record<string, unknown>) => Promise<ModelInfo[]>;
  /** The list without any project's config (the adapter's catalog). */
  global: () => ModelInfo[];
}

/**
 * OpenCode's model list per project (#643): a project whose own config adds nothing gets the
 * global list; one that does gets a list made with its config, kept until the config or
 * `opencode` changes, the global list is refreshed (`clear`) or a refresh is asked for.
 */
export class OpenCodeProjectModels {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<ModelInfo[]>>();

  constructor(private readonly deps: ProjectModelDeps) {}

  /** The project's models and the warnings about its config. Never throws. */
  async list(
    exe: ResolvedCommand | undefined,
    projectDir: string,
    opts: { refresh?: boolean } = {},
  ): Promise<ProjectModels> {
    const project = readProjectConfig(projectDir);
    const warnings = [...project.warnings];
    if (!project.config || !exe) return { models: this.deps.global(), warnings };
    const key = keyOf(projectDir);
    const exeId = executableFingerprint(exe);
    const entry = this.entries.get(key);
    if (!opts.refresh && entry && entry.config === project.fingerprint && entry.exe === exeId) {
      return { models: entry.models, warnings };
    }
    const job = `${key}\0${project.fingerprint}`;
    let running = this.pending.get(job);
    if (!running) {
      running = this.deps.probe(exe, project.config).finally(() => this.pending.delete(job));
      this.pending.set(job, running);
    }
    try {
      const models = await running;
      if (!models.length) throw new Error("no models");
      this.remember(key, { config: project.fingerprint, exe: exeId, models });
      return { models, warnings };
    } catch {
      return { models: this.deps.global(), warnings: [...warnings, PROBE_FAILED] };
    }
  }

  /** The list last made for this project, if any (efforts and context windows of its models). */
  cached(projectDir: string | undefined): ModelInfo[] | undefined {
    return projectDir ? this.entries.get(keyOf(projectDir))?.models : undefined;
  }

  /** Forget every project's list (the global list changed: a sign-in, a new provider). */
  clear(): void {
    this.entries.clear();
  }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_PROJECTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function keyOf(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
