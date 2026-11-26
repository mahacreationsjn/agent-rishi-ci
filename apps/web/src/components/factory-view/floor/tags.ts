import type { AgentStep, SceneAgent } from "../scene/agents";

/**
 * A figure's name tag (#476): the small paper tag hanging from it, with its issue number and a
 * glyph for its step ("#142" and a hammer while it implements), or its role for agents without
 * an item. Pure; the overlay draws the glyph.
 */

export type TagGlyph = AgentStep | "pm" | "scout" | "area";

const AREA_SHORT: Record<string, string> = {
  features: "Features",
  ux: "UX",
  performance: "Perf",
  tech_debt: "Debt",
  test_gaps: "Tests",
  security: "Security",
  bugs: "Bugs",
  docs: "Docs",
};

export function tagOf(a: SceneAgent): { text: string; glyph: TagGlyph } {
  if (a.role === "pm") return { text: "PM", glyph: "pm" };
  if (a.role === "scout") return { text: "Scout", glyph: "scout" };
  if (a.role === "area") return { text: AREA_SHORT[a.area ?? ""] ?? "Area", glyph: "area" };
  // The issue number; a pull request without an issue shows its own.
  const w = a.card?.item;
  const pr = w?.pr?.number ?? w?.ownedPr?.number;
  const text = w?.issue ? `#${w.issue.number}` : pr ? `PR ${pr}` : "#?";
  return { text, glyph: a.step ?? "implementing" };
}
