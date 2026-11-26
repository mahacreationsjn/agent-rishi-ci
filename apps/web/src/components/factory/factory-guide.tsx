import { BookOpen, CircleHelp, ExternalLink, ListTree } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect } from "react";
import type { ExtraProps } from "streamdown";
import { Markdown, type MarkdownOptions } from "@/components/thread/markdown";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DOCS_URL,
  FACTORY_GUIDE,
  type GuideSection,
  guideLink,
  headingId,
} from "@/lib/factory-guide";
import { cn } from "@/lib/utils";
import { useFactoryGuideStore } from "@/stores/factory-guide";

/** Element ids in the page get a prefix, so the guide's anchors never clash with the app's. */
const domId = (anchor: string) => `factory-guide-${anchor}`;
const MOBILE_TOC = "factory-guide-contents";

/** Scrolls the guide to a heading (a `##` section or a `###` heading in one). */
function scrollToAnchor(anchor: string, behavior: ScrollBehavior = "smooth") {
  const el = document.getElementById(anchor === MOBILE_TOC ? anchor : domId(anchor));
  if (!el) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : behavior });
}

type HastNode = { type: string; value?: string; children?: HastNode[] };
const textOf = (node: HastNode | undefined): string =>
  !node
    ? ""
    : node.type === "text"
      ? (node.value ?? "")
      : (node.children ?? []).map(textOf).join("");

/** Links in the guide: `#anchor` scrolls inside it, other docs open on GitHub. */
function GuideAnchor({
  href = "",
  children,
  node: _node,
  ...rest
}: ComponentProps<"a"> & ExtraProps) {
  const link = guideLink(href);
  if (link.kind === "anchor")
    return (
      <a
        {...rest}
        href={`#${link.id}`}
        data-streamdown="link"
        onClick={(e) => {
          e.preventDefault();
          scrollToAnchor(link.id);
        }}
      >
        {children}
      </a>
    );
  return (
    <a {...rest} href={link.url} target="_blank" rel="noreferrer" data-streamdown="link">
      {children}
    </a>
  );
}

/** `###` headings carry their GitHub anchor, so links and deep links can land on them. */
function GuideH3({ children, node, ...rest }: ComponentProps<"h3"> & ExtraProps) {
  const id = headingId(textOf(node as unknown as HastNode));
  return (
    <h3 {...rest} id={domId(id)} className="scroll-mt-3">
      {children}
    </h3>
  );
}

const OPTIONS: MarkdownOptions = {
  components: { a: GuideAnchor, h3: GuideH3 },
  // A guide shows everything: no copy buttons or line numbers on the diagram, no clipped tables.
  controls: false,
  lineNumbers: false,
  tableMaxHeight: 0,
  codeBlockMaxHeight: 0,
};

function Contents({ sections, className }: { sections: GuideSection[]; className?: string }) {
  return (
    <ol className={cn("space-y-0.5 text-[13px]", className)}>
      {sections.map((s, i) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              scrollToAnchor(s.id);
            }}
            className="flex gap-2 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/60">
              {i + 1}
            </span>
            <span className="min-w-0">{s.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * "How the factory loop works": `docs/factory-loop.md`, bundled with the app, in a side sheet
 * with a table of contents. One per window (mounted at the root), opened with
 * `useFactoryGuideStore().show(section?)` from the factory panel, the Factory view and its lanes.
 */
export function FactoryGuideSheet() {
  const open = useFactoryGuideStore((s) => s.open);
  const section = useFactoryGuideStore((s) => s.section);
  const hide = useFactoryGuideStore((s) => s.hide);
  const guide = FACTORY_GUIDE;

  // Opened at a section: jump there once the sheet's content is in the page.
  useEffect(() => {
    if (!open || !section) return;
    const frame = requestAnimationFrame(() => scrollToAnchor(section, "auto"));
    return () => cancelAnimationFrame(frame);
  }, [open, section]);

  return (
    <Sheet open={open} onOpenChange={(next) => !next && hide()}>
      <SheetContent
        side="right"
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl"
        data-testid="factory-guide"
      >
        <SheetHeader className="shrink-0 border-b border-border pr-12">
          <SheetTitle className="flex items-center gap-2 text-[15px]">
            <BookOpen className="size-4 shrink-0 text-primary" aria-hidden />
            {guide.title}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
            <span>The software factory and the dark factory, step by step.</span>
            <a
              href={`${DOCS_URL}factory-loop.md`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden /> In the docs
            </a>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary hover:underline md:hidden"
              onClick={() => scrollToAnchor(MOBILE_TOC)}
            >
              <ListTree className="size-3" aria-hidden /> Contents
            </button>
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Contents"
            className="hidden w-56 shrink-0 overflow-y-auto border-r border-border p-2 scroll-thin md:block"
          >
            <Contents sections={guide.sections} />
          </nav>
          <div
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-3 pb-12 scroll-thin sm:px-6"
            data-testid="factory-guide-body"
          >
            {guide.intro && (
              <Markdown options={OPTIONS} className="factory-guide">
                {guide.intro}
              </Markdown>
            )}
            <nav
              id={MOBILE_TOC}
              aria-label="Contents"
              className="mt-4 scroll-mt-3 rounded-lg border border-border bg-surface p-2 md:hidden"
            >
              <div className="px-2 pb-1 text-3xs tracking-wider text-muted-foreground uppercase">
                Contents
              </div>
              <Contents sections={guide.sections} />
            </nav>
            {guide.sections.map((s) => (
              <section
                key={s.id}
                id={domId(s.id)}
                aria-labelledby={`${domId(s.id)}-title`}
                className="scroll-mt-3 pt-6"
                data-testid="factory-guide-section"
              >
                <h2
                  id={`${domId(s.id)}-title`}
                  className="border-b border-border pb-1.5 text-[17px] font-semibold tracking-tight"
                >
                  {s.title}
                </h2>
                <Markdown options={OPTIONS} className="factory-guide mt-3">
                  {s.body}
                </Markdown>
              </section>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** The (?) "How it works" button in the factory panel's and the Factory view's headers. */
export function FactoryGuideButton({
  section,
  className,
}: {
  section?: string;
  className?: string;
}) {
  const show = useFactoryGuideStore((s) => s.show);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => show(section)}
      title="How the factory loop works"
      aria-label="How it works"
      className={className}
      data-testid="factory-guide-open"
    >
      <CircleHelp />
      <span className="hidden sm:inline">How it works</span>
    </Button>
  );
}

/** A quiet text link into the guide, for empty states and lanes. */
export function FactoryGuideLink({
  section,
  children,
  className,
}: {
  section?: string;
  children: ReactNode;
  className?: string;
}) {
  const show = useFactoryGuideStore((s) => s.show);
  return (
    <button
      type="button"
      onClick={() => show(section)}
      className={cn(
        "text-primary/90 underline decoration-primary/30 underline-offset-2 hover:text-primary hover:decoration-primary",
        className,
      )}
      data-testid="factory-guide-link"
    >
      {children}
    </button>
  );
}
