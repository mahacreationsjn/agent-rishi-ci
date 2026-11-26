import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NumberField, parseNumber } from "@/components/common/number-field";

/** A labelled number field over React state, reporting each value it passes on. */
function Harness({
  initial,
  optional = false,
  min,
  max,
  decimal,
  onValue = () => {},
}: {
  initial: number | null;
  optional?: boolean;
  min?: number;
  max?: number;
  decimal?: boolean;
  onValue?: (v: number | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const set = (v: number | null) => {
    setValue(v);
    onValue(v);
  };
  const shared = { id: "n", value, min, max, decimal };
  return (
    <>
      <label htmlFor="n">Count</label>
      {optional ? (
        <NumberField {...shared} optional onChange={set} />
      ) : (
        <NumberField {...shared} onChange={set} />
      )}
      <button type="button">Elsewhere</button>
    </>
  );
}

const field = () => screen.getByLabelText("Count") as HTMLInputElement;

describe("NumberField", () => {
  it("can be cleared, so typing 3 gives 3 (not 03)", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={2} onValue={onValue} />);

    await user.clear(field());
    expect(field().value).toBe("");
    await user.type(field(), "3");
    expect(field().value).toBe("3");
    expect(onValue).toHaveBeenLastCalledWith(3);
    // Clearing a field that needs a number passes nothing on: the form keeps its last valid value.
    expect(onValue).not.toHaveBeenCalledWith(0);
  });

  it("drops leading zeros on blur", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={2} onValue={onValue} />);

    await user.clear(field());
    await user.type(field(), "05");
    await user.tab();
    expect(field().value).toBe("5");
    expect(onValue).toHaveBeenLastCalledWith(5);
  });

  it("selects its text on focus, so typing replaces the number", async () => {
    const user = userEvent.setup();
    render(<Harness initial={2} />);

    await user.click(field());
    await user.keyboard("7");
    expect(field().value).toBe("7");
  });

  it("goes back to the last valid number when left empty", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={4} onValue={onValue} />);

    await user.clear(field());
    await user.tab();
    expect(field().value).toBe("4");
    expect(screen.getByRole("status").textContent).toBe("It needs a number, so it's back to 4.");
    expect(onValue).not.toHaveBeenCalled();

    // Numbers passed on while typing don't count: it goes back to the one from before the edit.
    await user.clear(field());
    await user.type(field(), "15{Backspace}{Backspace}");
    expect(onValue).toHaveBeenLastCalledWith(1);
    await user.tab();
    expect(field().value).toBe("4");
    expect(onValue).toHaveBeenLastCalledWith(4);
  });

  it("shows an error when left empty with no number to go back to", async () => {
    const user = userEvent.setup();
    render(<Harness initial={null} />);

    await user.click(field());
    await user.tab();
    expect(field().value).toBe("");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number.");
    // Typing a number clears the error.
    await user.type(field(), "6");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves an optional field left empty as null", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={120} optional onValue={onValue} />);

    await user.clear(field());
    await user.tab();
    expect(field().value).toBe("");
    expect(onValue).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("clamps a number outside min and max on blur, with a note", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={2} min={1} max={8} onValue={onValue} />);

    await user.clear(field());
    await user.type(field(), "12");
    // Out of range while typing: nothing is passed on yet.
    expect(onValue).toHaveBeenLastCalledWith(1);
    await user.tab();
    expect(field().value).toBe("8");
    expect(onValue).toHaveBeenLastCalledWith(8);
    expect(screen.getByRole("status").textContent).toBe("The most is 8.");

    await user.clear(field());
    await user.type(field(), "0{Enter}");
    expect(field().value).toBe("1");
    expect(screen.getByRole("status").textContent).toBe("The least is 1.");
  });

  it("goes back to the last valid number after text that isn't a whole number", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness initial={3} onValue={onValue} />);

    await user.clear(field());
    await user.type(field(), "1.5");
    await user.tab();
    expect(field().value).toBe("3");
    expect(onValue).toHaveBeenLastCalledWith(3);
    expect(screen.getByRole("status").textContent).toBe(
      "That isn't a whole number, so it's back to 3.",
    );
  });

  it("takes a dot or a comma in a decimal field, and asks phones for the right keyboard", async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    const { unmount } = render(<Harness initial={null} optional decimal onValue={onValue} />);
    expect(field().inputMode).toBe("decimal");

    await user.type(field(), "2,5");
    await user.tab();
    expect(onValue).toHaveBeenLastCalledWith(2.5);
    await user.clear(field());
    await user.type(field(), "0.75");
    expect(onValue).toHaveBeenLastCalledWith(0.75);
    unmount();

    render(<Harness initial={1} />);
    expect(field().inputMode).toBe("numeric");
    expect(field().type).toBe("text");
  });
});

describe("parseNumber", () => {
  it("reads whole numbers, decimals and leading zeros, and rejects the rest", () => {
    expect(parseNumber("")).toEqual({ kind: "empty" });
    expect(parseNumber("  ")).toEqual({ kind: "empty" });
    expect(parseNumber("05")).toEqual({ kind: "number", value: 5 });
    expect(parseNumber(" 12 ")).toEqual({ kind: "number", value: 12 });
    expect(parseNumber("-3")).toEqual({ kind: "number", value: -3 });
    expect(parseNumber("-0")).toEqual({ kind: "number", value: 0 });
    for (const bad of ["1.5", "1,5", "abc", "1e3", "1 000", "-", "+2"]) {
      expect(parseNumber(bad)).toEqual({ kind: "invalid" });
    }
    expect(parseNumber("1.5", true)).toEqual({ kind: "number", value: 1.5 });
    expect(parseNumber("1,5", true)).toEqual({ kind: "number", value: 1.5 });
    expect(parseNumber(".5", true)).toEqual({ kind: "number", value: 0.5 });
    expect(parseNumber("2.", true)).toEqual({ kind: "number", value: 2 });
    for (const bad of ["1.2.3", "1,000.5", ",", "1e3"]) {
      expect(parseNumber(bad, true)).toEqual({ kind: "invalid" });
    }
  });
});
