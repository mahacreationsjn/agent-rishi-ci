import { existsSync, type FSWatcher, watch } from "node:fs";
import { basename, join } from "node:path";
import type {
  Automation,
  AutomationFileError,
  AutomationTemplate,
  NewEvent,
  Project,
} from "@agent-rishi/contracts";
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToAutomation } from "../../db/rows";
import { automations } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import type { InboxService } from "../inbox-service";
import type { ProjectService } from "../projects/project-service";
import { changesBehaviour } from "./approval";
import { fileChangeInbox } from "./pm-change-notice";
import type { ScheduleStore } from "./schedule-store";
import {
  findTemplatesDir,
  type ParsedAutomationFile,
  readAutomationDir,
  toTemplate,
} from "./templates";

export interface AutomationSourcesDeps {
  db: Db;
  store: EventStore;
  projects: ProjectService;
  /** `~/.agent-rishi/automations`. */
  globalDir: string;
  /** Built-in templates folder (found automatically when omitted). */
  templatesDir?: string;
  /** Where the notice goes when a file's change switches an automation off. */
  inbox?: InboxService;
  /** Per-project switches of automations for all projects, cleared with their own switch. */
  schedules?: ScheduleStore;
  /** Called after a reload changed any definition. */
  onChange?: () => void;
  /** Rescan interval for folders created after start (default 60 s; 0 disables). */
  rescanMs?: number;
  log?: (message: string) => void;
}

const FILE_SOURCES = ["global_file", "project_file"] as const;

/** Repo-relative folder of project automation files. */
export const PROJECT_AUTOMATIONS_DIR = join(".agent-rishi", "automations");

/** The definition fields that, when changed in a file, update the stored automation. */
function definitionKey(a: Automation): string {
  return JSON.stringify([
    a.name,
    a.description,
    a.templateId,
    a.trigger,
    a.action,
    a.target,
    a.guards,
    a.workKey ?? null,
  ]);
}

/**
 * Automation definitions from Markdown files (§10): global ones in `~/.agent-rishi/automations/`
 * (they target all projects) and each project's `.agent-rishi/automations/` (that project only).
 * They are mirrored into the `automations` projection through `automation.saved` /
 * `automation.deleted`, keeping the enabled flag and approved permission level (files never
 * enable anything). An agent or a merged pull request can rewrite a file, so a change to what
 * an automation that is on does (trigger, action, guards) switches it off, with an inbox item
 * showing the change, until a person switches it on again; a new name or description keeps it
 * on. Folders are watched, with a periodic rescan for folders created later. Built-in templates
 * are read once.
 */
export class AutomationSources {
  private readonly paths = new Map<string, string>();
  private errors: AutomationFileError[] = [];
  private builtin: AutomationTemplate[] = [];
  private globalTemplates: AutomationTemplate[] = [];
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private rescan: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AutomationSourcesDeps) {
    const dir = findTemplatesDir(deps.templatesDir);
    if (dir) {
      const { files, errors } = readAutomationDir(dir);
      this.builtin = files.map((f) => toTemplate(f, "builtin"));
      for (const e of errors) deps.log?.(`automations: built-in template ${e.path}: ${e.message}`);
    } else {
      deps.log?.("automations: built-in templates folder not found");
    }
  }

  /** Built-in templates, then global automation files. */
  templates(): AutomationTemplate[] {
    const builtinIds = new Set(this.builtin.map((t) => t.id));
    return [...this.builtin, ...this.globalTemplates.filter((t) => !builtinIds.has(t.id))];
  }

  template(id: string): AutomationTemplate | undefined {
    return this.templates().find((t) => t.id === id);
  }

  fileErrors(): AutomationFileError[] {
    return this.errors;
  }

  pathOf(automationId: string): string | null {
    return this.paths.get(automationId) ?? null;
  }

  start(): void {
    this.reload();
    const every = this.deps.rescanMs ?? 60_000;
    if (every > 0) {
      this.rescan = setInterval(() => this.reload(), every);
      this.rescan.unref();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.rescan) clearInterval(this.rescan);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /** Re-read every folder and sync the projection. Returns true when anything changed. */
  reload(): boolean {
    const now = new Date().toISOString();
    const errors: AutomationFileError[] = [];
    const found: Automation[] = [];
    const paths = new Map<string, string>();
    const add = (
      file: { path: string; parsed: ParsedAutomationFile },
      base: Pick<Automation, "id" | "source" | "target">,
    ) => {
      const { parsed } = file;
      found.push({
        ...base,
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description ?? null,
        enabled: false,
        templateId: parsed.id,
        trigger: parsed.frontmatter.trigger,
        action: parsed.action,
        guards: parsed.guards,
        workKey: parsed.workKey,
        createdAt: now,
        updatedAt: now,
      });
      paths.set(base.id, file.path);
    };

    const global = readAutomationDir(this.deps.globalDir);
    errors.push(...global.errors);
    this.globalTemplates = global.files.map((f) => toTemplate(f, "global_file"));
    for (const file of global.files) {
      add(file, {
        id: `global:${file.parsed.id}`,
        source: "global_file",
        target: { type: "all_projects" },
      });
    }
    const dirs = [this.deps.globalDir];
    for (const project of this.deps.projects.list()) {
      if (project.archivedAt) continue;
      const dir = join(project.path, PROJECT_AUTOMATIONS_DIR);
      dirs.push(dir);
      const local = readAutomationDir(dir);
      errors.push(...local.errors);
      for (const file of local.files) {
        add(file, {
          id: `project:${project.id}:${file.parsed.id}`,
          source: "project_file",
          target: { type: "project", projectId: project.id },
        });
      }
    }
    this.errors = errors;
    this.paths.clear();
    for (const [k, v] of paths) this.paths.set(k, v);
    this.watchDirs(dirs);
    return this.sync(found, now);
  }

  /**
   * Store new or changed file definitions and delete those whose file is gone. A change to
   * what an automation that is on does switches it off and tells the user.
   */
  private sync(found: Automation[], now: string): boolean {
    const existing = new Map(
      this.deps.db
        .select()
        .from(automations)
        .where(inArray(automations.source, [...FILE_SOURCES]))
        .all()
        .map((r) => {
          const a = rowToAutomation(r);
          return [a.id, a] as const;
        }),
    );
    const events: NewEvent[] = [];
    const switchedOff: Array<{ before: Automation; after: Automation }> = [];
    for (const next of found) {
      const prev = existing.get(next.id);
      existing.delete(next.id);
      if (prev && definitionKey(prev) === definitionKey(next)) continue;
      let automation = next;
      if (prev) {
        const off = this.isOn(prev) && changesBehaviour(prev, next);
        automation = {
          ...next,
          enabled: prev.enabled && !off,
          createdAt: prev.createdAt,
          ...(prev.approvedAutonomy ? { approvedAutonomy: prev.approvedAutonomy } : {}),
        };
        if (off) switchedOff.push({ before: prev, after: automation });
      }
      events.push({ type: "automation.saved", sessionId: null, payload: { automation } });
    }
    for (const gone of existing.keys()) {
      events.push({ type: "automation.deleted", sessionId: null, payload: { automationId: gone } });
    }
    if (events.length === 0) return false;
    this.deps.store.append(events);
    for (const { before, after } of switchedOff) this.switchedOff(before, after, now);
    this.deps.onChange?.();
    return true;
  }

  /** On by its own switch, or (for all projects) in a project that switched it on. */
  private isOn(a: Automation): boolean {
    if (a.enabled) return true;
    if (a.target.type !== "all_projects" || !this.deps.schedules) return false;
    return this.deps.schedules.forAutomation(a.id).some((r) => r.enabledOverride === true);
  }

  /** Projects that switched it on follow its own switch again (now off); the user is told. */
  private switchedOff(before: Automation, after: Automation, now: string): void {
    for (const row of this.deps.schedules?.forAutomation(after.id) ?? []) {
      if (row.enabledOverride !== true) continue;
      this.deps.schedules?.upsert(after.id, row.projectId, { enabledOverride: null });
    }
    const path = this.paths.get(after.id);
    const shown =
      path && after.source === "project_file"
        ? `${PROJECT_AUTOMATIONS_DIR.replace(/\\/g, "/")}/${basename(path)}`
        : (path ?? null);
    this.deps.log?.(`automations: ${after.id} switched off: its file changed what it does`);
    this.deps.inbox?.put(fileChangeInbox(before, after, shown, now));
  }

  private watchDirs(dirs: string[]): void {
    const wanted = new Set(dirs.filter((d) => existsSync(d)));
    for (const [dir, watcher] of this.watchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, () => this.scheduleReload());
        watcher.on("error", () => {
          watcher.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, watcher);
      } catch (error) {
        this.deps.log?.(`automations: cannot watch ${dir}: ${errorMessage(error)}`);
      }
    }
  }

  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.reload();
      } catch (error) {
        this.deps.log?.(`automations: reload failed: ${errorMessage(error)}`);
      }
    }, 200);
    this.timer.unref();
  }
}

/** True when a project can run a template (GitHub-only templates need a GitHub project). */
export function templateFits(template: AutomationTemplate, project: Project): boolean {
  return !template.requiresGithub || project.kind === "github";
}
