import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

/**
 * cmd's `for` loop runs commands (#499): `for /f … in ('command') do …` loops over the quoted
 * command's output, `for /f … in (file)` over a file's lines, and the command after `do` runs for
 * each item. Each is classified like a command line of its own, so `('set AWS')` asks: it prints
 * every variable whose name starts with `AWS`, values included, whatever `tokens=` and `delims=`
 * the loop then applies.
 */

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
  agentRishiHome: "C:\\Users\\me\\.agent-rishi",
};

const action = (command: string, ctx: RiskContext = win) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};
/** True when the command asks as reaching Agent Rishi's own home, which asks at every level. */
const guarded = (command: string) => {
  const r = classifyCommand(command, win);
  return r.risky && r.agentRishi === true;
};

describe("cmd for loops (#499)", () => {
  it("asks when the looped command dumps environment variables", () => {
    for (const cmd of [
      "for /f \"tokens=*\" %i in ('set AWS') do @echo %i",
      "for /f \"delims=\" %i in ('set AWS') do @echo %i",
      "for /f %i in ('set GITHUB_TOKEN') do @echo %i",
      "for /f \"tokens=1,2 delims==\" %i in ('set C') do @echo %i=%j",
      "for /f \"tokens=*\" %%a in ('set AWS_') do @echo %%a",
      "FOR /F \"tokens=*\" %i IN ('set AWS') DO @echo %i",
      "for /f %i in ( 'set AWS' ) do @echo %i",
      "for /f %i in ('set AWS')do @echo %i",
      "for /f \"tokens=*\" %i in ('set AWS ^| findstr KEY') do @echo %i",
      'for /f "usebackq tokens=*" %i in (`set AWS`) do @echo %i',
      "for /f \"usebackq tokens=*\" %i in ('set AWS') do @echo %i",
      "for /f \"tokens=*\" %i in ('cmd /c set AWS') do @echo %i",
      "for /f \"tokens=*\" %i in ('printenv GITHUB_TOKEN') do @echo %i",
      'cmd /c "for /f "tokens=*" %i in (\'set AWS\') do @echo %i"',
      // The loop runs its command through `cmd /c`, which drops a leading `"` and the last one.
      'for /f "tokens=*" %i in (\'"set AWS"\') do @echo %i',
      'for /f "tokens=*" %i in (\'  "set AWS"  \') do @echo %i',
      'for /f "tokens=*" %i in (\'"set AWS" ^| findstr KEY\') do @echo %i',
      'for /f "tokens=*" %i in (\'"type .env"\') do @echo %i',
    ]) {
      expect(action(cmd), cmd).toBe("secrets");
    }
    expect(action("cmd /c '\"set AWS\"'", { ...win, shell: "powershell" })).toBe("secrets");
  });

  it("asks when the loop reads Agent Rishi's own credentials", () => {
    for (const cmd of [
      "for /f %i in ('type C:\\Users\\me\\.agent-rishi\\install-token') do @echo %i",
      "for /f %i in ('\"type C:\\Users\\me\\.agent-rishi\\install-token\"') do @echo %i",
      "for /f %i in (C:\\Users\\me\\.agent-rishi\\install-token) do @echo %i",
    ]) {
      expect(guarded(cmd), cmd).toBe(true);
    }
  });

  it("classifies the looped command, the files read and the command after do", () => {
    expect(action("for /f %i in ('type .env') do @echo %i")).toBe("secrets");
    expect(action("for /f %i in ('git push --force origin main') do @echo %i")).toBe(
      "git_destructive",
    );
    expect(action('for /f "tokens=*" %i in (.env) do @echo %i')).toBe("secrets");
    expect(action('for /F"tokens=*" %i in (.env) do @echo %i')).toBe("secrets");
    expect(action('for /f "usebackq tokens=*" %i in ("C:\\work\\repo\\.env") do @echo %i')).toBe(
      "secrets",
    );
    expect(action("for %i in (1) do set AWS")).toBe("secrets");
    expect(action("for %i in (1) do @set AWS")).toBe("secrets");
    expect(action("for /l %i in (1,1,2) do git push --force origin main")).toBe("git_destructive");
    expect(action("for %a in (1) do for /f %b in ('set AWS') do @echo %b")).toBe("secrets");
  });

  it("asks for set behind cmd's @", () => {
    expect(action("@set AWS")).toBe("secrets");
    expect(action('cmd /c "@set AWS"')).toBe("secrets");
    expect(action("@ set AWS")).toBe("secrets");
  });

  it("keeps loops that print no values running freely", () => {
    for (const cmd of [
      "for /f \"tokens=*\" %i in ('git rev-parse HEAD') do @echo %i",
      "for /f %i in ('\"C:\\Program Files\\Git\\bin\\git.exe\" rev-parse HEAD') do @echo %i",
      "for /f \"delims=\" %i in ('dir /b') do @echo %i",
      "for /f %i in ('set /a 1+2') do @echo %i",
      'for /f "tokens=1,2 delims=." %a in ("1.2") do @echo %a',
      'for /f "tokens=*" %i in (package.json) do @echo %i',
      "for %f in (*.txt) do @echo %f",
      "for /l %i in (1,1,3) do @echo %i",
      "for /d %d in (packages\\*) do @echo %d",
      "@echo off",
    ]) {
      expect(action(cmd), cmd).toBeNull();
    }
    expect(action('for f in *.txt; do echo "$f"; done', posix)).toBeNull();
  });
});
