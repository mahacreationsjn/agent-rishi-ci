import { describe, expect, it } from "vitest";
import { defaultSettings, Settings, TokenSaverSettings, tokenSaverLevel } from "../src";

describe("Settings.tokenSaver", () => {
  it("defaults to off with no role or project overrides, so older settings files still parse", () => {
    const expected = {
      default: "off",
      roles: { orchestrator: null, pm: null, agent: null },
      projects: {},
    };
    expect(defaultSettings().tokenSaver).toEqual(expected);
    expect(Settings.parse({ followups: { enabled: false } }).tokenSaver).toEqual(expected);
  });

  it("round-trips a global level, role defaults and project overrides", () => {
    const tokenSaver = {
      default: "lite",
      roles: { orchestrator: "full", pm: null, agent: "ultra" },
      projects: { p1: { level: "off" } },
    };
    const parsed = Settings.parse({ tokenSaver });
    expect(parsed.tokenSaver).toEqual(tokenSaver);
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects unknown levels", () => {
    expect(TokenSaverSettings.safeParse({ default: "max" }).success).toBe(false);
    expect(TokenSaverSettings.safeParse({ projects: { p1: { level: "on" } } }).success).toBe(false);
  });

  it("resolves project override, then role default, then the global default", () => {
    const s = TokenSaverSettings.parse({
      default: "lite",
      roles: { pm: "full" },
      projects: { p1: { level: "off" } },
    });
    expect(tokenSaverLevel(s, "agent", "p1")).toBe("off");
    expect(tokenSaverLevel(s, "pm", "p1")).toBe("off");
    expect(tokenSaverLevel(s, "pm", "p2")).toBe("full");
    expect(tokenSaverLevel(s, "agent", "p2")).toBe("lite");
    expect(tokenSaverLevel(s, "orchestrator", null)).toBe("lite");
  });
});
