import type { FactoryTuning } from "@agent-rishi/contracts";
import { useId } from "react";
import { Field } from "@/components/automations/form-bits";
import { InfoHint } from "@/components/common/info-hint";
import { NumberField } from "@/components/common/number-field";
import { AgentPicker } from "./agents-tuning";
import { REVIEW_AREAS_HELP, SCOUT_HELP } from "./meta";

/** The scout's knobs (dark factory). */
export type ScoutDraft = Pick<
  FactoryTuning,
  | "minBacklog"
  | "discoveryIntervalMin"
  | "discoveryPerRound"
  | "maxIssuesPerRound"
  | "scoutProvider"
  | "scoutModel"
>;

/** What the backlog threshold means, for its hint and the scout's description. */
export function backlogHelp(minBacklog: number): string {
  return minBacklog === 0
    ? "0: scheduled rounds are off. The scout only runs when you click Run scout now on the factory panel."
    : `The scout starts a scheduled round only when ${queueLow(minBacklog)} to be classified or for a free agent, and the interval has passed. 0 turns scheduled rounds off: then only Run scout now starts one.`;
}

/** "fewer than 3 issues wait", or "no issue waits" for a threshold of 1. */
function queueLow(minBacklog: number): string {
  return minBacklog === 1 ? "no issue waits" : `fewer than ${minBacklog} issues wait`;
}

/** The dark factory's scout limits in the factory settings. */
export function ScoutTuning<T extends ScoutDraft>({
  tuning,
  onChange,
}: {
  tuning: T;
  onChange: (t: T) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="scout-tuning">
      <div>
        <p className="flex items-center gap-1 text-[13px] font-medium">
          The scout
          <InfoHint label="the scout">{SCOUT_HELP}</InfoHint>
        </p>
        <p className="text-3xs text-muted-foreground">
          It reviews the app against the vision{" "}
          {tuning.minBacklog === 0
            ? "when you click Run scout now"
            : `on a schedule, when ${queueLow(tuning.minBacklog)}`}
          , using a few long-lived area reviewers (one reviewer agent per review area, such as
          security or UX), and files the work worth doing.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Review when fewer than"
          htmlFor={`${id}-backlog`}
          hint={backlogHelp(tuning.minBacklog)}
          help={
            tuning.minBacklog === 0
              ? "Off: only Run scout now starts a round."
              : `issue${tuning.minBacklog === 1 ? "" : "s"} wait for an agent.`
          }
        >
          <NumberField
            id={`${id}-backlog`}
            min={0}
            value={tuning.minBacklog}
            onChange={(minBacklog) => onChange({ ...tuning, minBacklog })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Every (hours)"
          htmlFor={`${id}-every`}
          hint={`How often the scout runs a review round: it plans what to look at, its area reviewers review, and it files issues. ${tuning.minBacklog === 0 ? "Scheduled rounds are off while the threshold is 0." : `It also waits until ${queueLow(tuning.minBacklog)}.`}`}
        >
          <NumberField
            id={`${id}-every`}
            min={1}
            value={Math.round(tuning.discoveryIntervalMin / 60)}
            onChange={(hours) => onChange({ ...tuning, discoveryIntervalMin: hours * 60 })}
            className="text-[13px]"
          />
        </Field>
        <Field label="Review areas per round" htmlFor={`${id}-areas`} hint={REVIEW_AREAS_HELP}>
          <NumberField
            id={`${id}-areas`}
            min={0}
            max={8}
            value={tuning.discoveryPerRound}
            onChange={(discoveryPerRound) => onChange({ ...tuning, discoveryPerRound })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Issues per round"
          htmlFor={`${id}-issues`}
          hint="The most issues the scout files from one round. It files only what is most worth doing, so a round can file fewer or none."
        >
          <NumberField
            id={`${id}-issues`}
            min={1}
            value={tuning.maxIssuesPerRound}
            onChange={(maxIssuesPerRound) => onChange({ ...tuning, maxIssuesPerRound })}
            className="text-[13px]"
          />
        </Field>
        <AgentPicker
          id={`${id}-agent`}
          label="Scout"
          provider={tuning.scoutProvider}
          model={tuning.scoutModel}
          hint="Runs the scout and its area reviewers, long-lived agents that read a lot of code each round. Automatic: the project's provider. A scout or area reviewer on another provider or model starts afresh at its next round."
          meanwhile="the scout starts on another available provider"
          onChange={(scoutProvider, scoutModel) =>
            onChange({ ...tuning, scoutProvider, scoutModel })
          }
        />
      </div>
    </div>
  );
}
