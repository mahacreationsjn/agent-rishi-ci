import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConnectionSettings } from "@/components/settings/sections-connections";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled;

describe("Settings › Connections", () => {
  it("needs a Vault key, then saves and verifies a provider connection", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    await client.vault.create({
      kind: "api-credential",
      name: "My Anthropic key",
      provider: "anthropic",
      value: "sk-ant-test-0123456789",
    });
    await client.vault.create({
      kind: "api-credential",
      name: "My OpenAI key",
      provider: "openai",
      value: "sk-openai-test-0123456789",
    });
    renderWithClient(<ConnectionSettings />, client, { withRouter: true });
    expect(await screen.findByText("No connections yet.")).toBeTruthy();

    const save = screen.getByRole("button", { name: "Save and check" });
    expect(isDisabled(save)).toBe(true);
    // Only Anthropic keys are offered for Anthropic.
    const keySelect = screen.getByLabelText("Connection key");
    await waitFor(() =>
      expect(
        within(keySelect)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Choose a key", "My Anthropic key"]),
    );
    await user.selectOptions(keySelect, "My Anthropic key");
    await user.click(save);

    const row = await screen.findByTestId("connection");
    expect(within(row).getByTestId("connection-level").textContent).toBe("Verified");
    expect(row.textContent).toMatch(/Anthropic · 2 models · Listed 2 models/);
  });

  it("takes a local server by its base URL, without a key", async () => {
    const user = userEvent.setup();
    renderWithClient(<ConnectionSettings />, createMockClient(), { withRouter: true });
    await user.selectOptions(
      await screen.findByLabelText("Connection provider"),
      "openai-compatible",
    );
    const save = screen.getByRole("button", { name: "Save and check" });
    expect(isDisabled(save)).toBe(true);
    await user.type(screen.getByLabelText("Base URL"), "http://127.0.0.1:11434/v1");
    await user.click(save);
    const row = await screen.findByTestId("connection");
    expect(within(row).getByTestId("connection-level").textContent).toBe("Verified");
  });

  it("shows a server without a model list as not verified, and keeps models added by hand", async () => {
    const user = userEvent.setup();
    const client = createMockClient();
    const key = await client.vault.create({
      kind: "api-credential",
      name: "Host key",
      provider: "local",
      value: "host-test-0123456789",
    });
    await client.connections.create({
      name: "Host",
      provider: "openai-compatible",
      baseUrl: "https://llm.example.test/no-models",
      vaultItemId: key.id,
    });
    renderWithClient(<ConnectionSettings />, client, { withRouter: true });
    const row = await screen.findByTestId("connection");
    expect(within(row).getByTestId("connection-level").textContent).toBe("Key found, not verified");

    await user.click(within(row).getByRole("button", { name: /Host/ }));
    expect(within(row).getByTestId("connection-check").textContent).toMatch(/by hand/);
    await user.type(within(row).getByLabelText("Models added by hand"), "model-a, model-b");
    await user.click(within(row).getByRole("button", { name: "Save models" }));
    await waitFor(() =>
      expect(within(row).getByTestId("connection-models").textContent).toBe("model-amodel-b"),
    );
  });
});
