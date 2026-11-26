import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type Artifact,
  type ArtifactKind,
  type Attachment,
  type ItemOf,
  MAX_ATTACHMENT_BYTES,
  type UserInput,
} from "@agent-rishi/contracts";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { rowToArtifact } from "../db/rows";
import { artifacts } from "../db/schema";
import type { EventStore } from "../events/store";
import { safeFileName } from "./artifact-names";
import { badRequest, notFound } from "./errors";
import { realPathOf, resolveInside } from "./files/path-guard";

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "text/plain": ".txt",
};

/** Max size of one attachment (an image or a file), in bytes. */
export { MAX_ATTACHMENT_BYTES };

export interface SaveArtifactInput {
  bytes: Buffer;
  name: string;
  mediaType: string;
  kind: ArtifactKind;
  projectId?: string | null;
  sessionId?: string | null;
  /**
   * Keep the file under this name (made safe, `safeFileName`) in a folder of its own,
   * `<session>/<id>/<name>`, instead of `<session>/<id>.<ext>`: for files an agent opens by
   * path, whose name tells it what they are.
   */
  fileName?: string;
}

/** The last segment of a path, whichever separator it uses. */
const lastSegment = (path: string) => path.split(/[\\/]/).pop() ?? "";

/** Decoded attachment bytes, refused over `MAX_ATTACHMENT_BYTES`. */
function attachmentBytes(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw badRequest("Attachment is larger than 20 MB", "attachment_too_large");
  }
  return bytes;
}

/** True for an attachment whose bytes came inline and still need storing. */
const hasInlineBytes = (a: Attachment) => a.source?.type === "base64";

/** True for an attachment that refers to a stored artifact the runner needs as a path. */
const hasArtifact = (a: Attachment) => a.source?.type === "artifact";

/** Files under `<home>/artifacts` (§6): screenshots, pasted images, full tool outputs. */
export class ArtifactService {
  constructor(
    private readonly db: Db,
    private readonly store: EventStore,
    private readonly dir: string,
  ) {}

  save(input: SaveArtifactInput): Artifact {
    const id = randomUUID();
    const folder = input.sessionId ?? "shared";
    const relative =
      input.fileName !== undefined
        ? `${folder}/${id}/${safeFileName(input.fileName)}`
        : `${folder}/${id}${EXTENSIONS[input.mediaType] ?? ""}`;
    const absolute = resolveInside(this.dir, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.bytes, { flag: "wx" });
    const artifact: Artifact = {
      id,
      kind: input.kind,
      name: input.name,
      mediaType: input.mediaType,
      path: relative,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      threadId: null,
      itemId: null,
      createdAt: new Date().toISOString(),
    };
    this.store.append([
      { type: "artifact.created", sessionId: artifact.sessionId, payload: { artifact } },
    ]);
    return artifact;
  }

  /** The artifacts folder (`<home>/artifacts`). */
  get rootDir(): string {
    return this.dir;
  }

  /**
   * A session's own artifacts folder (`<home>/artifacts/<session>`): its screenshots and pasted
   * images. Tools that read files a session points at accept paths in it.
   */
  sessionDir(sessionId: string): string {
    return resolveInside(this.dir, sessionId);
  }

  get(id: string): Artifact {
    const artifact = this.find(id);
    if (!artifact) throw notFound(`No artifact ${id}`, "artifact_not_found");
    return artifact;
  }

  list(filter: { sessionId?: string; projectId?: string } = {}): Artifact[] {
    const conditions: SQL[] = [];
    if (filter.sessionId) conditions.push(eq(artifacts.sessionId, filter.sessionId));
    if (filter.projectId) conditions.push(eq(artifacts.projectId, filter.projectId));
    return this.db
      .select()
      .from(artifacts)
      .where(and(...conditions))
      .orderBy(desc(artifacts.createdAt))
      .limit(500)
      .all()
      .map(rowToArtifact);
  }

  /** Absolute path of an artifact's file, guaranteed to be inside the artifacts folder. */
  filePath(artifact: Artifact): string {
    return resolveInside(this.dir, artifact.path);
  }

  /**
   * The real path of an artifact's file (symlinks, junctions and Windows short names resolved),
   * still inside the artifacts folder. Tools that publish or share an artifact check and read
   * this file, never the alias `filePath` returns.
   */
  realFilePath(artifact: Artifact): string {
    const real = realPathOf(this.filePath(artifact));
    if (!real) throw notFound(`Artifact ${artifact.id} has no file`, "artifact_file_missing");
    return real;
  }

  /**
   * The artifact stored in `file`, comparing real paths, so a symlink or junction in or above
   * the artifacts folder can't hide which artifact a file is (and so its original name). Reads
   * the file system, unlike `artifactForPath`.
   */
  artifactForFile(file: string): Artifact | undefined {
    const real = realPathOf(file);
    if (!real) return undefined;
    for (const candidate of new Set([file, real])) {
      for (const artifact of this.candidates(candidate)) {
        const stored = realPathOf(resolve(this.dir, artifact.path));
        if (stored && comparable(stored) === comparable(real)) return artifact;
      }
    }
    return undefined;
  }

  /**
   * Store attachments that came with their bytes (base64: pasted images, files attached in the
   * browser) as artifacts and point the attachment at the artifact, so large payloads never land
   * in the event log and stored input (queued messages, pending starts, conflict records) never
   * carries a filesystem path. `resolveAttachments` turns the reference into a file path when
   * the input is handed to the runner. Input that belongs to no session yet (a conflicting
   * start) goes to the shared folder.
   *
   * A file is written only from the bytes received, under a safe version of its name in a
   * folder of its own; the `path` the browser sent is used for nothing but that name, never
   * read, and replaced by the stored file's name.
   */
  externalizeAttachments(
    input: UserInput,
    owner: { sessionId: string | null; projectId: string | null },
  ): UserInput {
    if (!input.attachments.some(hasInlineBytes)) return input;
    const attachments = input.attachments.map((a): Attachment => {
      if (a.source?.type !== "base64") return a;
      const bytes = attachmentBytes(a.source.data);
      if (a.type === "image") {
        const artifact = this.save({
          bytes,
          name: a.name ?? `pasted${EXTENSIONS[a.mediaType] ?? ""}`,
          mediaType: a.mediaType,
          kind: "image",
          ...owner,
        });
        return { ...a, source: { type: "artifact" as const, artifactId: artifact.id } };
      }
      const name = lastSegment(a.name || a.path) || "attachment";
      const artifact = this.save({
        bytes,
        name,
        mediaType: a.mediaType || "application/octet-stream",
        kind: "file",
        fileName: name,
        ...owner,
      });
      const source = { type: "artifact" as const, artifactId: artifact.id };
      return { ...a, path: lastSegment(artifact.path), source };
    });
    return { ...input, attachments };
  }

  /**
   * Point artifact attachments at their file, for the runner: providers read images and files
   * by path, so a file's `path` becomes the stored file's absolute path and its `source` goes.
   * Only call this on input that goes to the runner, never on what the browser sees.
   *
   * Only `owner`'s own artifacts resolve, and shared ones (a conflicting start's, `shared/`) of
   * its project: a message can't hand an agent another session's file. Any other id is refused
   * as unknown, so the reply doesn't tell whether it exists.
   */
  resolveAttachments(
    input: UserInput,
    owner: { sessionId: string; projectId: string | null },
  ): UserInput {
    if (!input.attachments.some(hasArtifact)) return input;
    const attachments = input.attachments.map((a): Attachment => {
      if (a.source?.type !== "artifact") return a;
      const artifact = this.find(a.source.artifactId);
      const owned =
        artifact?.sessionId === owner.sessionId ||
        (artifact?.sessionId === null && artifact.projectId === owner.projectId);
      if (!artifact || !owned) {
        throw badRequest(`No artifact ${a.source.artifactId}`, "unknown_artifact");
      }
      const path = this.filePath(artifact);
      if (a.type === "image") return { ...a, source: { type: "path" as const, path } };
      const { source: _stored, ...file } = a;
      return { ...file, path };
    });
    return { ...input, attachments };
  }

  /**
   * The artifact whose own file is `path`, or `undefined`. Providers echo the input they were
   * given, so a user message's image or file comes back as the resolved path (and older
   * transcripts stored images that way); this maps it back to the artifact the browser can
   * load. Only an exact match with an artifact's file inside the artifacts folder counts;
   * nothing is read from disk.
   */
  artifactForPath(path: string): Artifact | undefined {
    const target = comparable(resolve(path));
    return this.candidates(path).find(
      (artifact) => comparable(resolve(this.dir, artifact.path)) === target,
    );
  }

  /**
   * The artifacts `path` may be the file of, judged by its name alone: `<id>.<ext>`, or
   * `<id>/<name>` for a file kept under its own name. Callers compare the full path.
   */
  private candidates(path: string): Artifact[] {
    const ids = artifactIdsOf(path);
    return ids.flatMap((id) => this.find(id) ?? []);
  }

  private find(id: string): Artifact | undefined {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    return row ? rowToArtifact(row) : undefined;
  }
}

/**
 * The transcript notice that shows a stored artifact inline (`shared_artifact`): images as a
 * picture with the caption under it, other files as a download.
 */
export function sharedArtifactNotice(
  artifact: Artifact,
  caption?: string,
  id = `share-${randomUUID()}`,
): ItemOf<"notice"> {
  return {
    id,
    kind: "notice",
    status: "completed",
    level: "info",
    code: "shared_artifact",
    message: caption ?? artifact.name,
    data: {
      artifactId: artifact.id,
      name: artifact.name,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      url: `/api/artifacts/${artifact.id}`,
    },
  };
}

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const comparable = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/**
 * The artifact ids a stored file's path can carry: its own name without the extension
 * (`<id>.<ext>`), and the folder it sits in (`<id>/<name>`, a file kept under its own name).
 */
function artifactIdsOf(path: string): string[] {
  const segments = path.split(/[\\/]/);
  const own = (segments.at(-1) ?? "").replace(/\.[^.]*$/, "");
  const folder = segments.at(-2) ?? "";
  return [...new Set([own, folder])].filter((id) => id.length > 0);
}
