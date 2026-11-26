import type { ProviderCapabilities, ProviderInfo, Session } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DraftOptions } from "@/components/composer/draft-options";
import { SessionOptions } from "@/components/composer/session-options";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import {
  buildStartRequest,
  type DraftChoice,
  type DraftDefaults,
  emptyChoice,
  pickModel,
  resolveDraftChoice,
} from "@/lib/new-session";
import { snapshotKey } from "@/lib/queries";
import { renderWithClient } from "./utils";

/**
 * #531: Plan stays visible, disabled with a reason naming the provider, when the chosen
 * provider can't plan; the draft keeps the user's Plan choice and brings it back when they
 * switch to a provider that can plan.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

const caps = (planMode: boolean) => ({ planMode, reasoningEffort: false }) as ProviderCapabilities;
// The id and the label differ, so the reason can only name it from the runner's info.
const planner: ProviderInfo = {
  id: "planner",
  displayName: "Planner",
  capabilities: caps(true),
  models: [{ id: "p", label: "P", efforts: [], isDefault: true }],
};
const noPlan: ProviderInfo = {
  id: "no-plan",
  displayName: "Straight Ahead",
  capabilities: caps(false),
  models: [{ id: "s", label: "S", efforts: [], isDefault: true }],
};
const providers = [planner, noPlan];
const defaults: DraftDefaults = {
  providers,
  project: undefined,
  agent: null,
  defaultAutonomy: "auto",
};
const pick = (choice: DraftChoice, provider: string) =>
  pickModel(choice, { provider, model: null, effort: null });

/** The text of the elements that describe `el` (its `aria-describedby`). */
const description = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
    .join(" ");

describe("the New session draft's Plan across providers (#531)", () => {
  it("keeps Plan off the request on a provider that can't plan, and brings it back after", () => {
    const on: DraftChoice = { ...emptyChoice, provider: "planner", planMode: true };
    const away = pick(on, "no-plan");
    const resolvedAway = resolveDraftChoice(away, defaults);
    expect(resolvedAway.planMode).toBe(false);
    expect(buildStartRequest("p1", { text: "Go" }, resolvedAway, "")).not.toHaveProperty(
      "planMode",
    );

    const back = resolveDraftChoice(pick(away, "planner"), defaults);
    expect(back.planMode).toBe(true);
    expect(buildStartRequest("p1", { text: "Go" }, back, "")).toMatchObject({ planMode: true });
  });

  it("shows Plan disabled with a reason naming the provider, saying it is off when it was on", async () => {
    const onChange = vi.fn();
    const choice: DraftChoice = { ...emptyChoice, provider: "no-plan", planMode: true };
    renderWithClient(
      <DraftOptions
        providers={providers}
        checks={[]}
        choice={choice}
        resolved={resolveDraftChoice(choice, defaults)}
        projectId="p1"
        projectPath="/repo"
        onChange={onChange}
      />,
    );
    const plan = screen.getByRole("button", { name: "Plan mode" });
    expect(plan.getAttribute("aria-disabled")).toBe("true");
    expect(plan.getAttribute("aria-pressed")).toBe("false");
    expect(description(plan)).toMatch(/Straight Ahead can't plan first/);
    expect(description(plan)).toMatch(/off/i);
    // A click or a tap shows the reason too (the tooltip primitive ignores touch); it changes
    // nothing.
    fireEvent.click(plan);
    expect((await screen.findByRole("tooltip")).textContent).toMatch(
      /Straight Ahead can't plan first/,
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("a running session's Plan on a provider that can't plan (#531)", () => {
  it("shows Plan disabled with a reason naming the provider", async () => {
    const session: Session = makeSession({
      id: "s-codex",
      projectId: "p-storefront",
      role: "agent",
      status: "idle",
      provider: "codex",
      model: "default",
      purpose: "Fix the flaky test",
      workKey: "issue:1",
    });
    const client = createMockClient();
    const updateSession = vi.spyOn(client, "updateSession");
    const { queryClient } = renderWithClient(
      <SessionOptions session={session} running={false} />,
      client,
    );
    await waitFor(() => expect(queryClient.getQueryData(snapshotKey)).toBeTruthy());
    const plan = await screen.findByRole("button", { name: "Plan mode" });
    expect(plan.getAttribute("aria-disabled")).toBe("true");
    expect(description(plan)).toMatch(/Codex can't plan first/);
    fireEvent.click(plan);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
