import { SPOT_CHECK_DARK_FACTORY_DEFAULT } from "@agent-rishi/contracts";
import { useId } from "react";
import { Field } from "@/components/automations/form-bits";
import { NumberField } from "@/components/common/number-field";

/** What the share does, for the field's help. */
const SPOT_CHECK_HELP =
  "A share of the pull requests the factory merges by itself is set aside for a quick look by a person, picked the same way every time for the same work. Merges of work let in from an untrusted author or allowed past the size limit are always included. One inbox item says how many wait; record Looks good or Found a problem on the factory panel's Spot-checks list. Nothing waits on a spot-check.";

/**
 * "Spot-check share of automatic merges" (`FactoryTuning.spotCheckPercent`): a percentage, or
 * empty for the mode's default (10% in a dark factory, off otherwise). 0 turns spot-checks off.
 */
export function SpotCheckField({
  value,
  dark,
  onChange,
}: {
  value: number | null;
  /** The project is (or becomes) a dark factory: the default is on. */
  dark: boolean;
  onChange: (spotCheckPercent: number | null) => void;
}) {
  const id = useId();
  return (
    <Field
      label="Spot-check share of automatic merges (%)"
      htmlFor={id}
      hint={SPOT_CHECK_HELP}
      help={`Empty: the default, ${SPOT_CHECK_DARK_FACTORY_DEFAULT}% in a dark factory and off otherwise. 0 turns spot-checks off.`}
    >
      <NumberField
        id={id}
        optional
        min={0}
        max={100}
        value={value}
        placeholder={dark ? `${SPOT_CHECK_DARK_FACTORY_DEFAULT} (default)` : "Off (default)"}
        onChange={onChange}
        className="text-[13px]"
      />
    </Field>
  );
}
