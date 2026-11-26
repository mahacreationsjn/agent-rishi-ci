import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FactoryLimits, FactoryStatus } from "@agent-rishi/contracts";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FactoryGuideButton, FactoryGuideSheet } from "@/components/factory/factory-guide";
import { PipelineBoard } from "@/components/factory-view/pipeline-board";
import { viewPipeline } from "@/components/factory-view/stages";
import {
  FACTORY_GUIDE,
  FACTORY_GUIDE_SOURCE,
  GUIDE_ANCHOR,
  guideAnchors,
  guideLink,
  headingId,
  parseGuide,
  withDocLinks,
} from "@/lib/factory-guide";
import { useFactoryGuideStore } from "@/stores/factory-guide";
import { renderWithClient } from "./utils";

/**
 * Issue #298: the in-app "How the factory loop works" guide is `docs/factory-loop.md` itself,
 * bundled with the web app. These keep the two from drifting and its links from breaking.
 */

const DOC = resolve(import.meta.dirname, "../../../docs/factory-loop.md");

describe("the factory guide's source", () => {
  it("is docs/factory-loop.md as it is on disk, not a copy", () => {
    expect(FACTORY_GUIDE_SOURCE).toBe(readFileSync(DOC, "utf8"));
  });

  it("has a title, an intro and the sections the issue asks for", () => {
    expect(FACTORY_GUIDE.title).toBe("How the factory loop works");
    expect(FACTORY_GUIDE.intro.length).toBeGreaterThan(0);
    expect(FACTORY_GUIDE.sections.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        "the-factory-loop",
        "the-pipelines",
        "the-merge-queue",
        "agent-slots-and-priority",
        "reviewers-and-providers",
        "when-things-go-wrong",
        "the-two-modes-side-by-side",
        "controls",
        "glossary",
      ]),
    );
  });

  it("links only to headings that exist, and the app's deep links land on one", () => {
    const anchors = guideAnchors(FACTORY_GUIDE_SOURCE);
    const links = [...FACTORY_GUIDE_SOURCE.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(anchors, `#${link}`).toContain(link);
    for (const anchor of Object.values(GUIDE_ANCHOR)) expect(anchors, anchor).toContain(anchor);
  });

  it("uses no images, which wouldn't load inside the app", () => {
    expect(FACTORY_GUIDE_SOURCE).not.toMatch(/!\[[^\]]*\]\(/);
  });
});

describe("parseGuide", () => {
  it("splits on ## headings, but not on ones inside code blocks", () => {
    const g = parseGuide(
      "# Title\r\n\r\nIntro.\r\n\r\n## One, two\r\n\r\nA\r\n\r\n```md\r\n## not a heading\r\n```\r\n\r\n## `Three` (3)\r\n\r\nB\r\n",
    );
    expect(g.title).toBe("Title");
    expect(g.intro).toBe("Intro.");
    expect(g.sections.map((s) => [s.id, s.title])).toEqual([
      ["one-two", "One, two"],
      ["three-3", "`Three` (3)"],
    ]);
    expect(g.sections[0]?.body).toContain("## not a heading");
  });

  it("makes anchors the way GitHub does", () => {
    expect(headingId("The two modes, side by side")).toBe("the-two-modes-side-by-side");
    expect(headingId("Reproduce or analyze")).toBe("reproduce-or-analyze");
    expect(headingId("Kill switch: Stop now")).toBe("kill-switch-stop-now");
  });

  it("keeps anchor links in the guide and opens other docs on GitHub", () => {
    expect(
      withDocLinks(
        "See [a](software-factory.md#merge-checks), [b](./github.md), [c](#the-merge-queue) and [d](https://example.com/x).",
      ),
    ).toBe(
      "See [a](https://github.com/sventkrtl/agent-rishi/blob/main/docs/software-factory.md#merge-checks), [b](https://github.com/sventkrtl/agent-rishi/blob/main/docs/github.md), [c](#the-merge-queue) and [d](https://example.com/x).",
    );
    expect(guideLink("#the-merge-queue")).toEqual({ kind: "anchor", id: "the-merge-queue" });
    expect(guideLink("https://example.com/x")).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
  });
});

describe("links into the guide from the Factory view", () => {
  const empty = FactoryStatus.parse({
    projectId: "p1",
    mode: "software_factory",
    experimental: true,
    loopState: "idle",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 } }),
    tuning: {},
    spendToday: { usd: 0, tokens: 0 },
    mergesToday: 0,
    consecutiveFailures: 0,
    activeSessions: 0,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent: [],
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
  });

  it("open it at the section about each empty stage and the empty Needs you lane", () => {
    // A wide screen: the stages are columns, so the empty ones show "Nothing here".
    const media = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(min-width: 1024px)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    onTestFinished(() => media.mockRestore());
    useFactoryGuideStore.setState({ open: false, section: null });
    renderWithClient(
      <PipelineBoard
        f={empty}
        pipeline={viewPipeline(empty, new Map(), 0)}
        now={0}
        onOpen={() => {}}
      />,
    );
    const links = screen.getAllByTestId("factory-guide-link");
    // Six stages, each "Nothing here · how it works", and the lane's "What lands here?".
    expect(links).toHaveLength(7);
    const opened = links.map((link) => {
      fireEvent.click(link);
      return useFactoryGuideStore.getState().section;
    });
    expect(opened).toEqual([
      GUIDE_ANCHOR.needsYou,
      GUIDE_ANCHOR.intake,
      GUIDE_ANCHOR.type,
      GUIDE_ANCHOR.building,
      GUIDE_ANCHOR.reviewing,
      GUIDE_ANCHOR.merge,
      GUIDE_ANCHOR.merged,
    ]);
  });
});

describe("the guide sheet", () => {
  it("opens from the How it works button with a table of contents", async () => {
    useFactoryGuideStore.setState({ open: false, section: null });
    renderWithClient(
      <>
        <FactoryGuideButton />
        <FactoryGuideSheet />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    const sheet = await screen.findByTestId("factory-guide");
    expect(within(sheet).getByRole("heading", { name: FACTORY_GUIDE.title })).toBeTruthy();
    const [contents] = within(sheet).getAllByRole("navigation", { name: "Contents" });
    if (!contents) throw new Error("no table of contents");
    for (const s of FACTORY_GUIDE.sections)
      expect(within(contents).getByRole("link", { name: new RegExp(s.title) })).toBeTruthy();
    expect(within(sheet).getAllByTestId("factory-guide-section")).toHaveLength(
      FACTORY_GUIDE.sections.length,
    );
  });
});
