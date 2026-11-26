import { type Attachment, ImageMediaType, MAX_ATTACHMENT_BYTES } from "@agent-rishi/contracts";
import { FileText, X } from "lucide-react";
import type { ComposerAttachment } from "@/stores/composer";

let n = 0;
const nextId = () => `att-${Date.now().toString(36)}-${n++}`;

/**
 * Composer attachments as message input: images and files inline as base64. A file's `path` is
 * only its name; the server stores the bytes and gives the agent the stored file's path.
 */
export function toInputAttachments(attachments: ComposerAttachment[]): Attachment[] {
  return attachments.map((a) =>
    a.type === "image"
      ? {
          type: "image",
          mediaType: a.mediaType,
          name: a.name,
          source: { type: "base64", data: a.data },
        }
      : {
          type: "file",
          path: a.name,
          name: a.name,
          ...(a.mediaType ? { mediaType: a.mediaType } : {}),
          source: { type: "base64", data: a.data },
        },
  );
}

/** A file's contents as a `data:` URL. */
function readDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The base64 part of a `data:` URL. */
const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/**
 * Read dropped, pasted or picked files into composer attachments: images to show and send
 * inline, other files with their bytes for the server to store. Files over 20 MB (the server's
 * limit) are left out and named in `tooLarge`.
 */
export async function filesToAttachments(
  files: File[],
): Promise<{ attachments: ComposerAttachment[]; tooLarge: string[] }> {
  const attachments: ComposerAttachment[] = [];
  const tooLarge: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      tooLarge.push(file.name || "A pasted file");
      continue;
    }
    const dataUrl = await readDataUrl(file);
    const media = ImageMediaType.safeParse(file.type);
    if (media.success) {
      attachments.push({
        id: nextId(),
        type: "image",
        name: file.name || "pasted-image.png",
        mediaType: media.data,
        data: base64Of(dataUrl),
        previewUrl: dataUrl,
      });
    } else {
      attachments.push({
        id: nextId(),
        type: "file",
        name: file.name || "attachment",
        ...(file.type ? { mediaType: file.type } : {}),
        data: base64Of(dataUrl),
      });
    }
  }
  return { attachments, tooLarge };
}

/** Thumbnails and file chips above the composer text. */
export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: ComposerAttachment[];
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {items.map((a) => (
        <div key={a.id} className="group relative animate-rise">
          {a.type === "image" ? (
            <img
              src={a.previewUrl}
              alt={a.name}
              className="size-14 rounded-lg border border-border object-cover"
            />
          ) : (
            <div className="flex h-14 max-w-44 items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-2xs">{a.name}</span>
            </div>
          )}
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.id)}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-foreground touch:opacity-100"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
