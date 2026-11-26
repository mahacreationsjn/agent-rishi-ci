import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { defaultComponents, type ExtraProps } from "streamdown";
import { serverOrigin, useClient } from "@/lib/api";
import { imageSource } from "@/lib/markdown-images";

const DefaultImage = defaultComponents.img;

/**
 * Remote images the user loaded on this page, by the exact URL clicked, with the address that
 * shows each: they stay loaded while a reply re-renders, and a changed URL needs its own click.
 */
const loaded = new Map<string, string>();

type ImageProps = ComponentProps<"img"> & ExtraProps;

/** A click in flight, or one that failed, for this URL. */
type Attempt = { url: string; state: "loading" | "failed" | "loaded" };

/**
 * An image in Markdown (#317). Local ones (inline, stored artifacts) render as usual; a remote
 * one renders a placeholder naming its host until the user clicks **Load image**, so an agent
 * reply or a stranger's issue can't make the browser contact a host by being shown. A loaded
 * image comes through Agent Rishi's server, the only place the UI's CSP lets images come from,
 * from a single-use address the click asked for (#341).
 */
export function MarkdownImage({ srcSet: _srcSet, sizes: _sizes, ...props }: ImageProps) {
  const client = useClient();
  const source = imageSource(props.src, [window.location.origin, serverOrigin]);
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  if (source.kind === "local") return <DefaultImage {...props} />;
  const remote = source.kind === "remote" ? source : null;
  const src = remote ? loaded.get(remote.url) : undefined;
  if (remote && src) {
    // The address works once: if the browser has to ask again, the user clicks again.
    const forget = () => {
      loaded.delete(remote.url);
      setAttempt({ url: remote.url, state: "failed" });
    };
    return <DefaultImage {...props} src={src} onError={forget} />;
  }
  const state = remote && attempt?.url === remote.url ? attempt.state : null;
  const load = async (url: string) => {
    setAttempt({ url, state: "loading" });
    try {
      loaded.set(url, await client.remoteImageUrl(url));
      setAttempt({ url, state: "loaded" });
    } catch {
      setAttempt({ url, state: "failed" });
    }
  };
  const alt = props.alt?.trim();
  return (
    <span
      data-streamdown="image-blocked"
      title={remote?.url}
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 align-middle text-[12.5px] text-muted-foreground"
    >
      <ImageOff className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">
        {alt ? `${alt} · ` : ""}
        {remote ? (
          <>
            {state === "failed" ? "Couldn't load image from " : "Image from "}
            <span className="font-medium text-foreground">{remote.host}</span>
          </>
        ) : (
          "Image not shown"
        )}
      </span>
      {remote && (
        <button
          type="button"
          aria-label={`Load image from ${remote.host}`}
          disabled={state === "loading"}
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
          onClick={() => void load(remote.url)}
        >
          {state === "loading" ? "Loading…" : state === "failed" ? "Try again" : "Load image"}
        </button>
      )}
    </span>
  );
}

/** `<picture><source srcset>` would pick a remote file over the `<img>`: sources are dropped. */
export function MarkdownSource() {
  return null;
}
