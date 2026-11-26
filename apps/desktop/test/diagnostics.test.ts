import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Diagnostics } from "../src/main/diagnostics";

describe("diagnostics export", () => {
  it("exports typed process facts and drops raw strings and extra fields", () => {
    const diagnostics = new Diagnostics();
    const privateDetails = {
      kind: "renderer-exit" as const,
      reason: "crashed",
      code: 9,
      transcript: "private transcript",
      log: "raw log line",
      token: "private token",
      url: "http://127.0.0.1/?token=private-token",
    };
    diagnostics.record(privateDetails);
    diagnostics.record({ ...privateDetails, reason: privateDetails.url });
    diagnostics.record({
      kind: "server-exit",
      reason: "unexpected",
      code: null,
      signal: "SIGTERM",
    });
    diagnostics.record({ kind: "quit", reason: "tray" });
    expect(JSON.parse(diagnostics.json())).toEqual({
      version: 1,
      events: [
        { kind: "renderer-exit", reason: "crashed", code: 9 },
        { kind: "renderer-exit", reason: "unknown", code: 9 },
        { kind: "server-exit", reason: "unexpected", code: null, signal: "SIGTERM" },
        { kind: "quit", reason: "tray" },
      ],
    });
  });

  it("keeps quit reasons across app launches and redacts stored input again", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-rishi-diagnostics-"));
    const file = join(dir, "events.json");
    try {
      new Diagnostics(file).record({ kind: "quit", reason: "tray" });
      const report = JSON.parse(new Diagnostics(file).json());
      expect(report.events).toEqual([{ kind: "quit", reason: "tray" }]);
      report.events.push({ kind: "child-exit", reason: "secret", signal: "token=secret" });
      writeFileSync(file, JSON.stringify(report));
      expect(JSON.parse(new Diagnostics(file).json()).events[1]).toEqual({
        kind: "child-exit",
        reason: "unknown",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
