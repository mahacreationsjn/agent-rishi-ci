/**
 * The in-app factory guide ("How the factory loop works"). Its text is `docs/factory-loop.md`,
 * imported as a string at build time: the app and the docs show the same file, there is no copy
 * to drift, and the guide works offline.
 */
import source from "../../../../docs/factory-loop.md?raw";

/** One `##` section of the guide: a table-of-contents entry. */
export interface GuideSection {
  /** The heading's anchor, as GitHub makes it ("when-things-go-wrong"). */
  id: string;
  title: string;
  /** The section's Markdown, without its heading. */
  body: string;
}

export interface Guide {
  /** The `#` title. */
  title: string;
  /** The Markdown between the title and the first `##` section. */
  intro: string;
  sections: GuideSection[];
}

/**
 * A heading's anchor, the way GitHub makes it: lower case, punctuation dropped, spaces as
 * hyphens. Links in the doc (`[...](#the-merge-queue)`) then work on GitHub and in the app.
 */
export function headingId(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

const FENCE = /^\s*(```|~~~)/;

/** Splits the guide into its title, intro and `##` sections; headings in code blocks don't count. */
export function parseGuide(markdown: string): Guide {
  let title = "";
  const intro: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const h1 = fenced ? undefined : /^# (.+)$/.exec(line)?.[1];
    const h2 = fenced ? undefined : /^## (.+)$/.exec(line)?.[1];
    if (h1 && !title && sections.length === 0) title = h1.trim();
    else if (h2) sections.push({ title: h2.trim(), lines: [] });
    else (sections.at(-1)?.lines ?? intro).push(line);
  }
  return {
    title,
    intro: intro.join("\n").trim(),
    sections: sections.map((s) => ({
      id: headingId(s.title),
      title: s.title,
      body: s.lines.join("\n").trim(),
    })),
  };
}

/** The anchors a link inside the guide may point at: every `##` and `###` heading. */
export function guideAnchors(markdown: string): Set<string> {
  const ids = new Set<string>();
  let fenced = false;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced ? undefined : /^#{2,3} (.+)$/.exec(line)?.[1];
    if (h) ids.add(headingId(h));
  }
  return ids;
}

/** Where a link to another doc (`software-factory.md#settings-and-limits`) opens: on GitHub. */
export const DOCS_URL = "https://github.com/sventkrtl/agent-rishi/blob/main/docs/";

const RELATIVE_LINK = /\]\((?!#|[a-z][a-z0-9+.-]*:)(?:\.\/)?([^)\s]+)\)/gi;

/**
 * Links to other docs made absolute (on GitHub), for the app: the renderer blocks relative URLs,
 * which wouldn't resolve inside the app anyway. Links to `#headings` stay in the guide.
 */
export function withDocLinks(markdown: string): string {
  return markdown.replace(RELATIVE_LINK, (_, path: string) => `](${DOCS_URL}${path})`);
}

/** The Markdown source of the guide, as bundled. */
export const FACTORY_GUIDE_SOURCE: string = source;

/** The guide, parsed once. */
export const FACTORY_GUIDE: Guide = parseGuide(withDocLinks(source));

/**
 * Where the app opens the guide from a place in the Factory view: each pipeline stage's empty
 * state and the "Needs you" lane. A test checks every one is a heading in the doc.
 */
export const GUIDE_ANCHOR = {
  intake: "intake-and-classification",
  type: "agent-slots-and-priority",
  building: "reproduce-or-analyze-then-implement",
  reviewing: "review",
  merge: "the-merge-queue",
  merged: "watching-main-after-a-merge",
  needsYou: "what-needs-you",
} as const;

/** Where a link in the guide goes: `#anchor` stays in the guide, anything else opens a new tab. */
export function guideLink(
  href: string,
): { kind: "anchor"; id: string } | { kind: "external"; url: string } {
  if (href.startsWith("#")) return { kind: "anchor", id: href.slice(1) };
  return { kind: "external", url: href };
}
