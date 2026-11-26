import type {
  AgentEvent,
  Attachment,
  ItemRecord,
  RawEventEnvelope,
  UserInput,
} from "@agent-rishi/contracts";
import { previewRecord } from "./preview";

/** Finds the artifact behind a file path (`ArtifactService.artifactForPath`). */
export interface ArtifactLookup {
  artifactForPath(path: string): { id: string } | undefined;
}

/** An absolute path on any platform: `/x`, `C:\x`, `C:/x`, `\\server\x`. */
const isAbsolutePath = (path: string) => /^(?:[\\/]|[a-zA-Z]:[\\/])/.test(path);

/**
 * True for an attachment that holds a filesystem path to map: an image read from a path, or a
 * file with no stored source whose path is absolute (a relative one names a worktree file).
 */
const needsMapping = (a: Attachment) =>
  a.type === "image" ? a.source.type === "path" : !a.source && isAbsolutePath(a.path);

/** The last segment of a path, whichever separator it uses. */
const fileName = (path: string, fallback: string) => path.split(/[\\/]/).pop() || fallback;

/**
 * Input as the browser sees it. Images and attached files are handed to providers as file paths
 * and providers echo that input back, so a user message can hold a path into the artifacts
 * folder (older transcripts stored images that way too). Such a path becomes its artifact, which
 * the UI loads from `/api/artifacts/:id`; any other image path, and any other absolute file
 * path, keeps only its file name, so no filesystem path under Agent Rishi's home reaches the
 * browser. Pure apart from the lookup.
 */
export function clientInput(input: UserInput, artifacts: ArtifactLookup): UserInput {
  if (!input.attachments.some(needsMapping)) return input;
  const attachments = input.attachments.map((a): Attachment => {
    if (!needsMapping(a)) return a;
    if (a.type === "file") {
      const artifact = artifacts.artifactForPath(a.path);
      const path = fileName(a.path, "file");
      if (!artifact) return { ...a, path };
      return { ...a, path, source: { type: "artifact" as const, artifactId: artifact.id } };
    }
    if (a.source.type !== "path") return a;
    const artifact = artifacts.artifactForPath(a.source.path);
    if (artifact) return { ...a, source: { type: "artifact" as const, artifactId: artifact.id } };
    return { ...a, source: { type: "path" as const, path: fileName(a.source.path, "image") } };
  });
  return { ...input, attachments };
}

/** An item record as served to the browser: large outputs previewed, attachments mapped. */
export function clientItemRecord(record: ItemRecord, artifacts: ArtifactLookup): ItemRecord {
  const previewed = previewRecord(record);
  const { item } = previewed;
  if (item.kind !== "user_message" || !item.input.attachments.some(needsMapping)) return previewed;
  return { ...previewed, item: { ...item, input: clientInput(item.input, artifacts) } };
}

/** A stored event as streamed to the browser: agent items carry mapped attachments too. */
export function clientEvent(event: RawEventEnvelope, artifacts: ArtifactLookup): RawEventEnvelope {
  if (
    event.type !== "agent.item.started" &&
    event.type !== "agent.item.updated" &&
    event.type !== "agent.item.completed"
  ) {
    return event;
  }
  const payload = event.payload as AgentEvent;
  if (!("item" in payload) || payload.item.kind !== "user_message") return event;
  const { item } = payload;
  if (!item.input.attachments.some(needsMapping)) return event;
  return {
    ...event,
    payload: { ...payload, item: { ...item, input: clientInput(item.input, artifacts) } },
  };
}
