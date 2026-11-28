import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VaultSettings } from "@/components/settings/sections-vault";
import type { AgentRishiClient } from "@/lib/api";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled;

describe("Settings › Vault", () => {
  it("saves an API key without ever showing it again, and grants it", async () => {
    const user = userEvent.setup();
    const { container } = renderWithClient(<VaultSettings />);
    expect(await screen.findByText("No secrets yet.")).toBeTruthy();

    await user.type(screen.getByLabelText("Secret name"), "Anthropic key");
    await user.type(screen.getByLabelText("Secret value"), "short");
    expect(screen.getByRole("alert").textContent).toMatch(/At least 8 characters/);
    const save = screen.getByRole("button", { name: /Save/ });
    expect(isDisabled(save)).toBe(true);
    await user.type(screen.getByLabelText("Secret value"), "-0123456789abcdefghij");
    await user.click(save);

    const row = await screen.findByTestId("vault-item");
    expect(row.textContent).toMatch(/Anthropic key/);
    expect(row.textContent).toMatch(/API key · Anthropic/);
    expect((screen.getByLabelText("Secret value") as HTMLInputElement).value).toBe("");
    expect(container.innerHTML).not.toContain("0123456789abcdefghij");

    await user.click(within(row).getByRole("button", { name: /Anthropic key/ }));
    expect(await within(row).findByText(/None yet/)).toBeTruthy();
    await user.selectOptions(within(row).getByLabelText("Grant role"), "agent");
    await user.selectOptions(within(row).getByLabelText("Grant ends"), "7d");
    await user.click(within(row).getByRole("button", { name: "Grant" }));
    const grant = await within(row).findByTestId("vault-grant");
    expect(grant.textContent).toMatch(/role agent · any project · any destination · until/);

    const activity = await screen.findAllByTestId("vault-activity");
    expect(activity.map((a) => a.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Granted/), expect.stringMatching(/Saved/)]),
    );
  });

  it("imports a .env file and says which lines it left out", async () => {
    const user = userEvent.setup();
    renderWithClient(<VaultSettings />);
    const box = await screen.findByLabelText(".env contents");
    await user.click(box);
    await user.paste(`DATABASE_URL=postgres://app:s3cretpass@db/app\nPIN=1234\n`);
    await user.click(screen.getByRole("button", { name: "Import" }));
    const result = await screen.findByTestId("vault-import-result");
    expect(result.textContent).toMatch(/Saved 1 secret\./);
    expect(result.textContent).toMatch(/delete it/);
    expect(result.textContent).toMatch(/Line 2 \(PIN\)/);
    expect(result.textContent).not.toMatch(/1234|s3cretpass/);
    await waitFor(() =>
      expect(screen.getByTestId("vault-item").textContent).toMatch(/DATABASE_URL/),
    );
  });

  it("says why when the Vault is locked, and offers no way to add", async () => {
    const client = createMockClient();
    const locked: AgentRishiClient = {
      ...client,
      vault: {
        ...client.vault,
        status: async () => ({
          state: "locked",
          reason: "The Vault's key is missing from the OS keychain.",
          items: 1,
        }),
      },
    };
    renderWithClient(<VaultSettings />, locked);
    const alert = await screen.findByTestId("vault-status");
    expect(alert.textContent).toMatch(/The Vault is locked/);
    expect(alert.textContent).toMatch(/missing from the OS keychain/);
    expect(screen.queryByLabelText("Secret value")).toBeNull();
    expect(screen.queryByLabelText(".env contents")).toBeNull();
  });
});
