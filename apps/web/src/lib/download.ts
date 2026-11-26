/** Save a blob as a file through a temporary link. */
export function saveBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save Markdown text as a `.md` file. */
export function saveMarkdown(fileName: string, markdown: string): void {
  saveBlob(fileName, new Blob([markdown], { type: "text/markdown" }));
}
