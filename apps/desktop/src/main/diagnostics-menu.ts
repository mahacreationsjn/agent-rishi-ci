import { writeFile } from "node:fs/promises";
import { dialog } from "electron";
import type { Diagnostics } from "./diagnostics";

export async function exportDiagnostics(diagnostics: Diagnostics): Promise<void> {
  try {
    const { filePath } = await dialog.showSaveDialog({
      title: "Export Diagnostics",
      defaultPath: "agent-rishi-diagnostics.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (filePath) await writeFile(filePath, diagnostics.json(), { mode: 0o600 });
  } catch {
    dialog.showErrorBox("Export Diagnostics", "Agent Rishi could not save the diagnostics file.");
  }
}
