import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `curl` piped into another command, e.g. `curl -sf URL | grep -q x`: quoted strings are skipped,
 * and `||`, `&&` and `;` end the curl command first. A reader that stops early (`grep -q` after
 * its match, `head`) closes the pipe while curl may still be writing, so curl exits 23 and the
 * step fails under `-eo pipefail` although the check passed (#539). Write the response to a file
 * and read the file.
 */
const CURL_PIPED = /\bcurl\b(?:"[^"]*"|'[^']*'|[^"'|;&\n]|&(?!&))*\|(?!\|)/;

/** The lines of a workflow (continuations joined, comments dropped) where curl is piped. */
function curlPipes(text) {
  return text
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("#") && CURL_PIPED.test(line));
}

const WORKFLOWS = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

describe("CI workflows", () => {
  it.each([
    'curl -sf -H "cookie: a=$T" http://127.0.0.1:4791/ | grep -q "<title>Agent Rishi"',
    'curl -sf "http://x/?a=1&b=2" | head -n1',
    "X=$(curl -s http://x | jq .ok)",
    "curl -s http://x 2>&1 | tee out.txt",
    "curl -s http://x \\\n  -H 'a: b' | grep -q ok",
  ])("finds curl piped into a reader: %s", (line) => {
    expect(curlPipes(line)).toHaveLength(1);
  });

  it.each([
    "curl -sf http://127.0.0.1:4791/ > index.html",
    "curl -sf http://127.0.0.1:4791/api/health > health.json && break",
    "curl -sf http://x || true",
    'curl -sf "http://x/?a=1&b=2" > a.json; grep -q ok a.json | cat',
    "grep -q ok doctor.txt | head -n1",
    "# curl -sf http://x | grep -q ok",
  ])("leaves other commands alone: %s", (line) => {
    expect(curlPipes(line)).toEqual([]);
  });

  it("never pipe curl's output into another command", () => {
    const found = readdirSync(WORKFLOWS)
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) =>
        curlPipes(readFileSync(join(WORKFLOWS, name), "utf8")).map((line) => `${name}: ${line}`),
      );
    expect(found, "write the response to a file and grep the file").toEqual([]);
  });
});
