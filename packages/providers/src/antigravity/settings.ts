import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseJsonc } from "../util/jsonc";

/**
 * The folder, under Antigravity CLI's own (`~/.gemini/antigravity-cli`), that Agent Rishi's
 * sessions read their settings from (`agy acp --cli_dir_name agent-rishi`). The login stays in the
 * parent folder, so sessions use the user's own sign-in.
 */
export const AGY_CLI_DIR = "agent-rishi";

/** Antigravity CLI's folder: `~/.gemini/antigravity-cli`. */
export function agyDir(home: string = homedir()): string {
  return path.join(home, ".gemini", "antigravity-cli");
}

/**
 * Settings that would let tools run without asking, or a plan proceed without review (its
 * Artifact Review setting): dropped from the user's copy.
 */
const SKIPS_APPROVALS = [
  "toolPermission",
  "agentMode",
  "permissions",
  "artifactReview",
  "artifactReviewMode",
  "artifactReviewPolicy",
] as const;

/**
 * The settings Agent Rishi's sessions run with (§11.2): the user's own (`~/.gemini/antigravity-cli/
 * settings.json`: model, login method, sandbox, ...) without anything that skips approvals, plus
 * `toolPermission: "strict"`, under which Antigravity CLI asks before every tool action, allow
 * rules included (from this file, the shared settings or a project's), so Agent Rishi's policy
 * decides each one. The user's `deny` rules are kept. Pure.
 */
export function agentRishiAgySettings(user: unknown): Record<string, unknown> {
  const own =
    user && typeof user === "object" && !Array.isArray(user)
      ? { ...(user as Record<string, unknown>) }
      : {};
  const deny = denyRules(own.permissions);
  for (const key of SKIPS_APPROVALS) delete own[key];
  return {
    ...own,
    toolPermission: "strict",
    ...(deny.length ? { permissions: { deny } } : {}),
  };
}

function denyRules(permissions: unknown): string[] {
  if (!permissions || typeof permissions !== "object") return [];
  const deny = (permissions as { deny?: unknown }).deny;
  return Array.isArray(deny) ? deny.filter((r): r is string => typeof r === "string") : [];
}

function readJson(file: string): unknown {
  try {
    return parseJsonc(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

/**
 * Write Agent Rishi's settings for Antigravity CLI sessions (`agentRishiAgySettings`) to
 * `~/.gemini/antigravity-cli/agent-rishi/settings.json`, from the user's current settings. Written
 * before every session, so a change to the user's own settings applies from the next one.
 * Returns the folder name for `--cli_dir_name`.
 */
export function writeAgySettings(home: string = homedir()): string {
  const base = agyDir(home);
  const dir = path.join(base, AGY_CLI_DIR);
  mkdirSync(dir, { recursive: true });
  const settings = agentRishiAgySettings(readJson(path.join(base, "settings.json")));
  const file = path.join(dir, "settings.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort on file systems without modes.
  }
  return AGY_CLI_DIR;
}
