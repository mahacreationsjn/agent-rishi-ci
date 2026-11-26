import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../src/process/supervisor";
import { CheckRunner } from "../src/workspace/checks";

const dir = mkdtempSync(join(tmpdir(), "agent-rishi-checks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const node = (code: string) => `node -e "${code}"`;

describe("check.run", () => {
  const checks = new CheckRunner(new ProcessSupervisor(), {});
  const base = { name: "check.run" as const, sessionId: "s1", cwd: dir, timeoutMs: 60_000 };

  it("reports a passing check, with CI=true like an agent's shell", async () => {
    const result = await checks.run({ ...base, command: node("console.log(process.env.CI)") });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(result.output.trim()).toBe("true");
  });

  it("reports a failing check with the end of its output", async () => {
    const result = await checks.run({
      ...base,
      command: node("console.error('x'.repeat(20000) + 'END'); process.exit(3)"),
      ciEnv: false,
    });
    expect(result.exitCode).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(16_000);
    expect(result.output.trim().endsWith("END")).toBe(true);
  });

  it("is cancelled by check.cancel and refuses a second run meanwhile", async () => {
    const running = checks.run({ ...base, command: node("setTimeout(() => {}, 60000)") });
    await expect(checks.run({ ...base, command: node("0") })).rejects.toMatchObject({
      code: "check_running",
    });
    expect(checks.cancel("s1")).toBe(true);
    const result = await running;
    expect(result).toMatchObject({ exitCode: null, cancelled: true, timedOut: false });
    expect(checks.cancel("s1")).toBe(false);
  });

  it("fails with cwd_missing when the folder is gone", async () => {
    await expect(
      checks.run({ ...base, cwd: join(dir, "gone"), command: node("0") }),
    ).rejects.toMatchObject({ code: "cwd_missing" });
  });
});
