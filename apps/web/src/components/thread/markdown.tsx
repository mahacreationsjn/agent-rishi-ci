import { createCodePlugin } from "@streamdown/code";
import { memo, useMemo } from "react";
import {
  type Components,
  defaultRehypePlugins,
  type LinkSafetyConfig,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { cn } from "@/lib/utils";
import { LinkConfirmDialog } from "./link-confirm-dialog";
import { MarkdownImage, MarkdownSource } from "./markdown-image";

const code = createCodePlugin({ themes: ["github-light-default", "github-dark-default"] });
const plugins = { code };

/** Remote images wait for a click; `<source>` can't route around that (#317). */
const imageComponents: Components = { img: MarkdownImage, source: MarkdownSource };

/**
 * Links show their real target and open after a confirmation (#317); Streamdown's harden step
 * already refuses `javascript:` and `data:` links.
 */
const linkSafety: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkConfirmDialog {...props} />,
};

type SanitizeSchema = { protocols?: Record<string, string[] | undefined> };

/**
 * Streamdown's own HTML, sanitize and harden steps, with inline images (`data:`, `blob:`) let
 * through the sanitizer: they never leave this machine. Which images load is decided by
 * `MarkdownImage`.
 */
function rehypePlugins() {
  const { raw, sanitize, harden } = defaultRehypePlugins;
  if (!Array.isArray(sanitize)) return Object.values(defaultRehypePlugins);
  const [plugin, schema = {}] = sanitize as [unknown, SanitizeSchema?];
  const src = [...(schema.protocols?.src ?? []), "data", "blob"];
  return [raw, [plugin, { ...schema, protocols: { ...schema.protocols, src } }], harden];
}

const rehype = rehypePlugins() as NonNullable<StreamdownProps["rehypePlugins"]>;

/** Renderer options a page of docs needs: its own links and headings, nothing clipped. */
export type MarkdownOptions = Pick<
  StreamdownProps,
  "components" | "controls" | "tableMaxHeight" | "codeBlockMaxHeight" | "lineNumbers"
>;

/** Streaming-safe markdown with Shiki-highlighted code blocks (§13). */
export const Markdown = memo(function Markdown({
  children,
  streaming = false,
  className,
  options,
}: {
  children: string;
  streaming?: boolean;
  className?: string;
  /** Keep it stable (a module constant), or the memo re-renders every time. */
  options?: MarkdownOptions;
}) {
  const own = options?.components;
  // A page's own components never replace the image guard.
  const components = useMemo(() => (own ? { ...own, ...imageComponents } : imageComponents), [own]);
  return (
    <Streamdown
      {...options}
      className={cn("markdown", className)}
      plugins={plugins}
      shikiTheme={["github-light-default", "github-dark-default"]}
      isAnimating={streaming}
      mode={streaming ? "streaming" : "static"}
      components={components}
      rehypePlugins={rehype}
      linkSafety={linkSafety}
      caret={streaming ? "block" : undefined}
    >
      {children}
    </Streamdown>
  );
});
