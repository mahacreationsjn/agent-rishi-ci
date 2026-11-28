import type { ClaudeSdkStatus, SetupCheck, SetupStatus } from "@agent-rishi/contracts";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupChecklist } from "@/components/setup/checklist";
import { createMockClient } from "@/lib/api/mock";
import { SetupPage } from "@/routes/setup";
import { renderWithClient } from "./utils";

afterEach(() => vi.restoreAllMocks());

const sdk = (state: ClaudeSdkStatus["state"]): ClaudeSdkStatus => ({
  state,
  version: "0.3.318",
  source: "deps",
  location: "~/.agent-rishi/deps",
  progress: null,
  error: null,
});

/** Only Claude Code, signed in but not verified yet: setup is not ready. */
function signedInOnly(): SetupStatus {
  const claude: SetupCheck = {
    id: "claude",
    label: "Claude Code",
    state: "warning",
    installed: true,
    version: "2.1.320",
    executablePath: "/usr/bin/claude",
    loggedIn: true,
    authMethod: "claude.ai",
    account: null,
    loginExpiresAt: null,
    message: "Signed in, not verified yet",
    fix: { kind: "login", command: "/usr/bin/claude auth login" },
    durationMs: 10,
    level: "credential_found",
    verifiedAt: null,
  };
  return {
    checkedAt: new Date().toISOString(),
    setupCompleted: false,
    ready: false,
    checks: [claude],
    warnings: [],
  };
}

describe("connection levels in first-run setup", () => {
  it("tags a verified provider with its time and a signed-in one as not verified", async () => {
    renderWithClient(<SetupChecklist />);
    const tags = await screen.findAllByTestId("verified-tag");
    const rows = tags.map((t) => t.closest("[data-check]")?.getAttribute("data-check"));
    expect(rows).toContain("claude");
    expect(rows).not.toContain("gemini");
    expect(tags[0]?.textContent).toMatch(/^verified /);
    const gemini = screen.getByText("Signed in, not verified yet").closest("[data-check]");
    expect(gemini?.getAttribute("data-check")).toBe("gemini");
    expect(gemini?.textContent).toContain("not verified");
  });

  it("waits for a verified provider: a signed-in one is not enough", async () => {
    const client = createMockClient();
    vi.spyOn(client, "getSetupStatus").mockResolvedValue(signedInOnly());
    vi.spyOn(client, "getClaudeSdkStatus").mockResolvedValue(sdk("ready"));
    renderWithClient(<SetupPage />, client, { withRouter: true });
    const next = await screen.findByRole("button", { name: /Waiting for a verified provider/ });
    expect((next as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets a signed-in Claude Code continue to install Claude Code support, which its check needs", async () => {
    const client = createMockClient();
    vi.spyOn(client, "getSetupStatus").mockResolvedValue(signedInOnly());
    vi.spyOn(client, "getClaudeSdkStatus").mockResolvedValue(sdk("missing"));
    renderWithClient(<SetupPage />, client, { withRouter: true });
    const next = await screen.findByRole("button", { name: /^Continue/ });
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false));
  });
});
