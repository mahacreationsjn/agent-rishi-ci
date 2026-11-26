import { Attachment, MAX_ATTACHMENT_BYTES } from "@agent-rishi/contracts";
import { describe, expect, it } from "vitest";
import { filesToAttachments, toInputAttachments } from "@/components/composer/attachments";

describe("composer file attachments", () => {
  it("reads a file's bytes and sends them, with its name as the path", async () => {
    const pdf = new File(["%PDF-1.4"], "отчёт.pdf", { type: "application/pdf" });
    const untyped = new File(["a,b"], "data.csv");
    const { attachments, tooLarge } = await filesToAttachments([pdf, untyped]);
    expect(tooLarge).toEqual([]);
    const input = toInputAttachments(attachments);
    expect(input).toEqual([
      {
        type: "file",
        path: "отчёт.pdf",
        name: "отчёт.pdf",
        mediaType: "application/pdf",
        source: { type: "base64", data: btoa("%PDF-1.4") },
      },
      {
        type: "file",
        path: "data.csv",
        name: "data.csv",
        source: { type: "base64", data: btoa("a,b") },
      },
    ]);
    for (const a of input) expect(Attachment.safeParse(a).success).toBe(true);
  });

  it("leaves out files over 20 MB and names them", async () => {
    const big = new File(["x"], "video.mov");
    Object.defineProperty(big, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
    const small = new File(["ok"], "ok.txt", { type: "text/plain" });
    const { attachments, tooLarge } = await filesToAttachments([big, small]);
    expect(tooLarge).toEqual(["video.mov"]);
    expect(attachments.map((a) => a.name)).toEqual(["ok.txt"]);
  });
});
