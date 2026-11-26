import { randomUUID } from "node:crypto";
import {
  Automation,
  type AutomationCreator,
  AutomationGuards,
  type AutomationImportLinkResponse,
  type AutomationImportPreviewItem,
  type AutomationTemplate,
  type CreateAutomationRequest,
  type DuplicateAutomationRequest,
  type ImportAutomationsRequest,
  type UpdateAutomationRequest,
} from "@agent-rishi/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToAutomation } from "../../db/rows";
import { automations } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { badRequest, conflict, notFound } from "../errors";
import type { ProjectService } from "../projects/project-service";
import { approved, changesBehaviour } from "./approval";
import { collectImportFiles, previewFile, previewImport } from "./import";
import { resolveImportLink } from "./import-link";
import type { ScheduleStore } from "./schedule-store";
import { type AutomationSources, templateFits } from "./sources";
import { validateAutomation } from "./validate";

export interface DefinitionsDeps {
  db: Db;
  store: EventStore;
  projects: ProjectService;
  sources: AutomationSources;
  schedules: ScheduleStore;
  /** Downloads for imports from a link (tests script it); public addresses only otherwise. */
  fetch?: typeof fetch;
}

/** Id of a project's starter automation created from a template. */
export function starterId(projectId: string, templateId: string): string {
  return `starter:${projectId}:${templateId}`;
}

export { validateAutomation } from "./validate";

/** Options of `AutomationDefinitions.create`. */
export interface CreateOptions {
  id?: string;
  /** Who creates it (`user` when omitted). */
  createdBy?: AutomationCreator;
}

/** Options of `AutomationDefinitions.update`. */
export interface UpdateOptions {
  /**
   * When the change gives an automation that is on a different trigger, action or guards,
   * switch it off in the same change, so a person approves what it now does before it runs
   * again (a PM's edits, §10). Only the automation's own switch: an automation for all
   * projects keeps its per-project overrides. Without it the change is a person's, and saving
   * an automation that is on approves its permission level.
   */
  switchOffOnChange?: boolean;
}

/**
 * Database-stored automations (§10): create (from a template or from scratch), update,
 * delete, enable and disable, and the starter set offered to new projects. File-based
 * automations are read-only here except for their enabled switch. Switching one on, or a
 * person creating or saving one that is on, records the permission level they approved.
 */
export class AutomationDefinitions {
  constructor(private readonly deps: DefinitionsDeps) {}

  all(): Automation[] {
    return this.deps.db.select().from(automations).all().map(rowToAutomation);
  }

  find(id: string): Automation | undefined {
    const row = this.deps.db.select().from(automations).where(eq(automations.id, id)).get();
    return row ? rowToAutomation(row) : undefined;
  }

  get(id: string): Automation {
    const a = this.find(id);
    if (!a) throw notFound(`No automation ${id}`, "automation_not_found");
    return a;
  }

  create(req: CreateAutomationRequest, opts: CreateOptions = {}): Automation {
    const id = opts.id ?? randomUUID();
    const template = req.templateId ? this.template(req.templateId) : undefined;
    if (req.projectId) this.deps.projects.get(req.projectId);
    const now = new Date().toISOString();
    const trigger = req.trigger ?? template?.trigger;
    const action = req.action ?? template?.action;
    const name = req.name ?? template?.name;
    if (!trigger || !action || !name) throw badRequest("name, trigger and action are required");
    const automation = Automation.parse({
      id,
      name,
      description:
        req.description !== undefined ? req.description : (template?.description ?? null),
      enabled: req.enabled,
      source: "database",
      templateId: template?.id ?? null,
      trigger,
      action,
      target: req.projectId
        ? { type: "project", projectId: req.projectId }
        : { type: "all_projects" },
      guards: AutomationGuards.parse({ ...template?.guards, ...req.guards }),
      workKey: req.workKey ?? template?.workKey,
      ...(opts.createdBy && opts.createdBy !== "user" ? { createdBy: opts.createdBy } : {}),
      createdAt: now,
      updatedAt: now,
    });
    validateAutomation(automation);
    // Created on: only a person does that (a PM's and imported automations are created off).
    return this.save(automation.enabled ? approved(automation) : automation);
  }

  update(id: string, req: UpdateAutomationRequest, opts: UpdateOptions = {}): Automation {
    const current = this.editable(id);
    if (req.target?.type === "project") this.deps.projects.get(req.target.projectId);
    const { workKey: _drop, ...rest } = current;
    const workKey = req.workKey === null ? undefined : (req.workKey ?? current.workKey);
    const next = Automation.parse({
      ...rest,
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.description !== undefined ? { description: req.description } : {}),
      ...(req.trigger ? { trigger: req.trigger } : {}),
      ...(req.action ? { action: req.action } : {}),
      ...(req.target ? { target: req.target } : {}),
      guards: AutomationGuards.parse({ ...current.guards, ...req.guards }),
      ...(workKey ? { workKey } : {}),
      updatedAt: new Date().toISOString(),
    });
    validateAutomation(next);
    if (!opts.switchOffOnChange) return this.save(next.enabled ? approved(next) : next);
    const switchOff = next.enabled && changesBehaviour(current, next);
    return this.save(switchOff ? { ...next, enabled: false } : next);
  }

  remove(id: string): void {
    this.editable(id);
    this.deps.store.append([
      { type: "automation.deleted", sessionId: null, payload: { automationId: id } },
    ]);
    this.deps.schedules.removeAutomation(id);
  }

  /**
   * Enable or disable. With `projectId` on an automation that targets all projects, only that
   * project's override changes; otherwise the automation's own switch.
   */
  setEnabled(id: string, enabled: boolean, projectId?: string): Automation {
    const a = this.get(id);
    if (projectId) this.deps.projects.get(projectId);
    if (projectId && a.target.type === "project" && a.target.projectId !== projectId) {
      throw notFound(`Automation ${id} does not belong to that project`, "automation_not_found");
    }
    // Switching it on, here or in one project, approves its permission level as it is now.
    const next = { ...(enabled ? approved(a) : a), updatedAt: new Date().toISOString() };
    const approvalChanged = next.approvedAutonomy !== a.approvedAutonomy;
    if (projectId && a.target.type === "all_projects") {
      this.deps.schedules.upsert(id, projectId, { enabledOverride: enabled });
      return approvalChanged ? this.save(next) : a;
    }
    if (a.enabled === enabled && !approvalChanged) return a;
    return this.save({ ...next, enabled });
  }

  /** Drop a project's override of an all-projects automation; it follows its own switch again. */
  clearOverride(id: string, projectId: string): Automation {
    const a = this.get(id);
    this.deps.projects.get(projectId);
    if (a.target.type !== "all_projects") {
      throw conflict("Only automations for all projects have per-project overrides", "no_override");
    }
    this.deps.schedules.upsert(id, projectId, { enabledOverride: null });
    return a;
  }

  /**
   * Create the project's starter set (§10) from the starter templates that fit the project,
   * keeping existing ones; with `enable`, switch them all on.
   */
  starterSet(projectId: string, enable: boolean): Automation[] {
    const project = this.deps.projects.get(projectId);
    const out: Automation[] = [];
    for (const template of this.deps.sources.templates()) {
      if (!template.starter || template.source !== "builtin" || !templateFits(template, project)) {
        continue;
      }
      const id = starterId(projectId, template.id);
      const existing = this.find(id);
      if (existing) {
        out.push(enable ? this.setEnabled(id, true) : existing);
        continue;
      }
      out.push(this.create({ templateId: template.id, projectId, enabled: enable }, { id }));
    }
    return out;
  }

  /**
   * An editable database copy of any automation (also file-based and built-in ones), off,
   * named "<name> (copy)" unless a name is given. Targets `projectId`, else the original's
   * target. The copy keeps the original's work key, so the two never run the same work at once.
   */
  duplicate(id: string, req: DuplicateAutomationRequest): Automation {
    const a = this.get(id);
    const projectId =
      req.projectId ?? (a.target.type === "project" ? a.target.projectId : undefined);
    return this.create({
      projectId,
      name: req.name ?? `${a.name} (copy)`.slice(0, 200),
      description: a.description,
      trigger: a.trigger,
      action: a.action,
      guards: a.guards,
      workKey: a.workKey,
      enabled: false,
    });
  }

  /**
   * Import shared automation files (§10): re-parse the source with the file parser, then
   * create each selected valid file as a database automation, always off and marked
   * `createdBy: import`. Nothing runs.
   */
  importFrom(req: ImportAutomationsRequest): {
    created: Automation[];
    failed: { fileName: string; error: string }[];
  } {
    if (req.projectId) this.deps.projects.get(req.projectId);
    const select = req.select ? new Set(req.select) : null;
    const items = previewImport(req.source).filter((i) => !select || select.has(i.fileName));
    const created: Automation[] = [];
    const failed: { fileName: string; error: string }[] = [];
    for (const item of items) {
      const draft = item.automation;
      if (!draft) {
        failed.push({ fileName: item.fileName, error: item.error ?? "Invalid file" });
        continue;
      }
      created.push(
        this.create(
          {
            projectId: req.projectId,
            name: draft.name,
            description: draft.description,
            trigger: draft.trigger,
            action: draft.action,
            guards: draft.guards,
            workKey: draft.workKey,
            enabled: false,
          },
          { createdBy: "import" },
        ),
      );
    }
    return { created, failed };
  }

  /** Parse an import without saving anything. */
  previewImport(req: ImportAutomationsRequest["source"]): AutomationImportPreviewItem[] {
    return previewImport(req);
  }

  /**
   * Download a link's automation files once and preview them, without saving anything. The
   * import then sends back `source`, so it creates exactly what was previewed and never
   * downloads again.
   */
  async previewLink(url: string): Promise<AutomationImportLinkResponse> {
    const files = collectImportFiles({
      files: await resolveImportLink(url, { fetch: this.deps.fetch }),
    });
    return { source: { files }, items: files.map(previewFile) };
  }

  private template(id: string): AutomationTemplate {
    const template = this.deps.sources.template(id);
    if (!template) throw notFound(`No automation template ${id}`, "template_not_found");
    return template;
  }

  private editable(id: string): Automation {
    const a = this.get(id);
    if (a.source !== "database") {
      throw conflict(
        "This automation is defined in a file; edit the file instead",
        "automation_read_only",
      );
    }
    return a;
  }

  private save(automation: Automation): Automation {
    this.deps.store.append([
      { type: "automation.saved", sessionId: null, payload: { automation } },
    ]);
    return automation;
  }
}
