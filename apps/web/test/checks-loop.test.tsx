import type {
  CheckRunData,
  ItemOf,
  ProviderCapabilities,
  ProviderInfo,
} from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CheckRunCard } from "@/components/thread/cards/check-run-card";
import { createMockClient } from "@/lib/api/mock";
import { buildStartRequest, emptyChoice, resolveDraftChoice } from "@/lib/new-session";
import { checkRunOf, checksRunning } from "@/lib/transcript/checks";
import { emptyTranscript } from "@/lib/transcript/reducer";
import { renderWithClient } from "./utils";

/** #371: "Keep going until checks pass": the draft's setting, the check-run card and Stop. */

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const provider: ProviderInfo = {
  id: "fake",
  displayName: "Fake",
  capabilities: { planMode: false, reasoningEffort: false } as ProviderCapabilities,
  models: [{ id: "m", label: "M", efforts: [] }],
};
const defaults = {
  providers: [provider],
  project: undefined,
  agent: null,
  defaultAutonomy: "auto" as const,
};

const data: CheckRunData = {
  round: 1,
  maxRounds: 3,
  checks: [
    { command: "pnpm typecheck", status: "passed", exitCode: 0, durationMs: 1200 },
    {
      command: "pnpm test",
      status: "failed",
      exitCode: 1,
      durationMs: 5300,
      output: "FAIL src/a.test.ts",
    },
    { command: "pnpm lint", status: "running", exitCode: null },
  ],
};
const card = (status: "in_progress" | "completed"): ItemOf<"notice"> => ({
  id: "checks-t1",
  kind: "notice",
  status,
  level: "info",
  code: "check_run",
  message: "Running 3 checks (2 of 3 done)",
  data,
});

describe("keep going until checks pass in the New session draft", () => {
  it("sends the setting with the first message, but never at Read-only", () => {
    const on = resolveDraftChoice(
      { ...emptyChoice, untilChecksPass: true, checkRounds: 5 },
      defaults,
    );
    expect(buildStartRequest("p1", { text: "Go" }, on, "")).toMatchObject({
      untilChecksPass: true,
      checkRounds: 5,
    });
    const readOnly = resolveDraftChoice(
      { ...emptyChoice, untilChecksPass: true, autonomy: "read_only" },
      defaults,
    );
    expect(buildStartRequest("p1", { text: "Go" }, readOnly, "")).not.toHaveProperty(
      "untilChecksPass",
    );
    // A draft saved before the setting existed starts with it off, at the default cap.
    expect(resolveDraftChoice(emptyChoice, defaults)).toMatchObject({
      untilChecksPass: false,
      checkRounds: 3,
    });
  });
});

describe("the check-run card", () => {
  it("shows each check with how it ended, its output on demand and Stop while running", async () => {
    const client = createMockClient();
    const interrupt = vi.spyOn(client, "interrupt").mockResolvedValue();
    renderWithClient(
      <CheckRunCard item={card("in_progress")} data={data} sessionId="s1" />,
      client,
    );
    expect(screen.getByText("Round 1 of 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "pnpm typecheck: Passed" })).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    const failed = screen.getByRole("button", { name: "pnpm test: Failed" });
    expect(screen.queryByText("FAIL src/a.test.ts")).toBeNull();
    fireEvent.click(failed);
    expect(screen.getByText("FAIL src/a.test.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(interrupt).toHaveBeenCalledWith("s1"));
  });

  it("has no Stop once the run ended", () => {
    renderWithClient(<CheckRunCard item={card("completed")} data={data} sessionId="s1" />);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  });

  it("knows a running check run from the latest turn's card", () => {
    const state = emptyTranscript("s1");
    state.threads.t = {
      id: "t",
      parentThreadId: null,
      parentItemId: null,
      title: null,
      agentType: null,
      itemIds: ["checks-t1"],
      turnIds: ["t1"],
    };
    state.items["checks-t1"] = { item: card("in_progress"), turnId: "t1", threadId: "t" };
    expect(checksRunning(state, "t")).toBe(true);
    state.items["checks-t1"] = { item: card("completed"), turnId: "t1", threadId: "t" };
    expect(checksRunning(state, "t")).toBe(false);
    expect(checkRunOf({ ...card("completed"), code: "other" })).toBeNull();
  });
});
