import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changelogSection,
  parseReleaseArgs,
  preflightProblems,
  releaseArtifacts,
  sha256sums,
} from "./local-release.mjs";

describe("parseReleaseArgs", () => {
  it("takes a bump and flags, drafts by default", () => {
    expect(parseReleaseArgs(["patch"])).toEqual({
      bump: "patch",
      dryRun: false,
      skipVerify: false,
      publish: false,
      uploadOnly: null,
    });
    expect(parseReleaseArgs(["--dry-run", "minor", "--publish"])).toMatchObject({
      bump: "minor",
      dryRun: true,
      publish: true,
    });
  });

  it("takes --upload-only with a tag and no bump", () => {
    expect(parseReleaseArgs(["--upload-only", "v0.7.14"])).toMatchObject({
      bump: null,
      uploadOnly: "v0.7.14",
    });
  });

  it.each([
    [[], /Usage/],
    [["tiny"], /Expected patch, minor, major/],
    [["patch", "minor"], /Unexpected argument/],
    [["patch", "--force"], /Unknown option --force/],
    [["--upload-only"], /needs a tag/],
    [["--upload-only", "0.7.14"], /needs a tag/],
    [["--upload-only", "v0.7.14", "patch"], /takes no bump/],
    [["--upload-only", "v0.7.14", "--publish"], /can't --publish/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseReleaseArgs(argv)).toThrow(message);
  });
});

describe("changelogSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "Pointer.",
    "",
    "## [0.7.11] - 2026-11-27",
    "",
    "### Fixed",
    "",
    "- **A.** B.",
    "",
    "## [0.7.10] - 2026-11-25",
    "",
    "- Old.",
  ].join("\n");

  it("returns one version's notes without its heading", () => {
    expect(changelogSection(changelog, "0.7.11")).toBe("### Fixed\n\n- **A.** B.");
    expect(changelogSection(changelog, "0.7.10")).toBe("- Old.");
  });

  it("refuses a version that isn't there", () => {
    expect(() => changelogSection(changelog, "0.7.12")).toThrow(/no section for 0.7.12/);
  });
});

describe("releaseArtifacts", () => {
  it("keeps this version's installers, blockmaps and update metadata only", () => {
    const files = [
      "Agent Rishi-Setup-0.7.11.exe",
      "Agent Rishi-Setup-0.7.11.exe.blockmap",
      "Agent Rishi-Setup-0.7.10.exe",
      "Agent Rishi-0.7.11-x86_64.AppImage",
      "agent_rishi_0.7.11_amd64.deb",
      "Agent Rishi-0.7.11-arm64.dmg",
      "Agent Rishi-0.7.11-arm64.zip",
      "latest.yml",
      "latest-linux.yml",
      "builder-debug.yml",
      "builder-effective-config.yaml",
      "win-unpacked",
      "agent-rishi-0.7.11-x64.nsis.7z",
    ];
    expect(releaseArtifacts(files, "0.7.11")).toEqual([
      "Agent Rishi-0.7.11-arm64.dmg",
      "Agent Rishi-0.7.11-arm64.zip",
      "Agent Rishi-0.7.11-x86_64.AppImage",
      "Agent Rishi-Setup-0.7.11.exe",
      "Agent Rishi-Setup-0.7.11.exe.blockmap",
      "agent_rishi_0.7.11_amd64.deb",
      "latest-linux.yml",
      "latest.yml",
    ]);
  });
});

describe("sha256sums", () => {
  let dir;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes sha256sum's format", () => {
    dir = mkdtempSync(join(tmpdir(), "agent-rishi-sums-"));
    writeFileSync(join(dir, "a.txt"), "abc");
    expect(sha256sums(dir, ["a.txt"])).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  a.txt\n",
    );
  });
});

describe("preflightProblems", () => {
  const ready = {
    branch: "main",
    dirty: false,
    behind: 0,
    ahead: 0,
    tag: "v0.7.11",
    tagExists: false,
    ghSignedIn: true,
    nsisProblem: null,
  };

  it("lets a clean, current main with a free tag release", () => {
    expect(preflightProblems(ready)).toEqual([]);
  });

  it("lists every reason not to release", () => {
    expect(
      preflightProblems({
        ...ready,
        branch: "feature",
        dirty: true,
        behind: 2,
        ahead: 1,
        tagExists: true,
        ghSignedIn: false,
        nsisProblem: "paths too long",
      }),
    ).toEqual([
      'on branch "feature", not main',
      "the working tree has uncommitted changes",
      "main is 2 commit(s) behind origin/main",
      "main has 1 unpushed commit(s)",
      "tag v0.7.11 already exists",
      "`gh` is not signed in (run `gh auth login`)",
      "paths too long",
    ]);
  });
});
