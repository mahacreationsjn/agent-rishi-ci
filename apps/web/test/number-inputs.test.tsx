import type { Project } from "@agent-rishi/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutonomyDialog } from "@/components/factory/autonomy-dialog";
import { createMockClient } from "@/lib/api/mock";
import { projects } from "@/lib/api/mock/fixtures/world";
import { renderWithClient } from "./utils";

const storefront = projects.find((p) => p.id === "p-storefront") as Project;

/**
 * Issue #327: clearing a number field left "0", so typing a digit gave "02". The input events
 * are what a browser sends: the field's whole new text after each keystroke.
 */
describe("number fields in the factory settings", () => {
  async function openSettings() {
    renderWithClient(
      <AutonomyDialog project={storefront} open onOpenChange={() => {}} />,
      createMockClient(),
      { withRouter: true },
    );
    const backlog = (await screen.findByLabelText("Review when fewer than")) as HTMLInputElement;
    await waitFor(() => expect(backlog.value).toBe("2"));
    return backlog;
  }

  it("can be cleared while editing", async () => {
    const backlog = await openSettings();

    // Backspace over the only digit.
    fireEvent.change(backlog, { target: { value: "" } });
    expect(backlog.value).toBe("");
  });

  it("never keeps a leading zero", async () => {
    await openSettings();
    const areas = screen.getByLabelText("Review areas per round") as HTMLInputElement;

    // The field shows "0" (as it does once cleared); the caret sits after it and the user types 2.
    fireEvent.change(areas, { target: { value: "0" } });
    fireEvent.change(areas, { target: { value: "02" } });
    fireEvent.blur(areas);
    expect(areas.value).toBe("2");
  });
});
