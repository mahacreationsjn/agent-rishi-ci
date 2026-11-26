import { describe, expect, it } from "vitest";
import { Attachment, UserInput } from "../src";

const roundTrip = <T>(schema: { parse: (v: unknown) => T }, value: unknown): T => {
  const first = schema.parse(value);
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
  return first;
};

describe("file attachments", () => {
  it("round-trips a file with its bytes from the browser, and once stored as an artifact", () => {
    const uploaded = roundTrip(Attachment, {
      type: "file",
      path: "отчёт.pdf",
      name: "отчёт.pdf",
      mediaType: "application/pdf",
      source: { type: "base64", data: "JVBERi0xLjQK" },
    });
    expect(uploaded.type === "file" && uploaded.source?.type).toBe("base64");
    const stored = roundTrip(UserInput, {
      text: "read this",
      attachments: [
        { type: "file", path: "report.pdf", source: { type: "artifact", artifactId: "a1" } },
      ],
    });
    expect(stored.attachments[0]).toEqual({
      type: "file",
      path: "report.pdf",
      source: { type: "artifact", artifactId: "a1" },
    });
  });

  it("still parses a stored file with only a path", () => {
    const legacy = roundTrip(Attachment, { type: "file", path: "src/index.ts", name: "index.ts" });
    expect(legacy).toEqual({ type: "file", path: "src/index.ts", name: "index.ts" });
  });

  it("refuses a file source that is a path, or bytes that are not base64", () => {
    const file = { type: "file", path: "a.txt" };
    expect(
      Attachment.safeParse({ ...file, source: { type: "path", path: "/etc/passwd" } }).success,
    ).toBe(false);
    expect(Attachment.safeParse({ ...file, source: { type: "base64", data: "%%" } }).success).toBe(
      false,
    );
  });
});
