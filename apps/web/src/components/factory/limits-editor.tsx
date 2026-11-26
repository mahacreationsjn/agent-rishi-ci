import type { FactoryLimits, FactoryTuning, MergePolicy } from "@agent-rishi/contracts";
import { useId, useState } from "react";
import { Field } from "@/components/automations/form-bits";
import { NumberField } from "@/components/common/number-field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type AgentsDraft, AgentsTuning } from "./agents-tuning";
import { BudgetFields } from "./budget-fields";
import { WIP_HELP } from "./meta";
import { type ScoutDraft, ScoutTuning } from "./scout-tuning";
import { SpotCheckField } from "./spot-check-tuning";

/**
 * The tuning knobs the editor exposes. It saves them as a patch, so the rest (review areas, the
 * idle grace) keep their saved values.
 */
export type TuningDraft = AgentsDraft &
  ScoutDraft &
  Pick<
    FactoryTuning,
    | "requireCi"
    | "maxChangedLines"
    | "maxChangedFiles"
    | "auditCommand"
    | "maxFixAttempts"
    | "watchTimeoutMin"
    | "maxOpenPrs"
    | "learnFromReviews"
    | "specApproval"
    | "spotCheckPercent"
  >;

/** The editable tuning knobs of a saved tuning. */
export function tuningDraft(t: FactoryTuning): TuningDraft {
  return {
    maxOpenPrs: t.maxOpenPrs,
    requireCi: t.requireCi,
    maxChangedLines: t.maxChangedLines,
    maxChangedFiles: t.maxChangedFiles,
    auditCommand: t.auditCommand,
    maxFixAttempts: t.maxFixAttempts,
    watchTimeoutMin: t.watchTimeoutMin,
    learnFromReviews: t.learnFromReviews,
    specApproval: t.specApproval,
    spotCheckPercent: t.spotCheckPercent,
    minBacklog: t.minBacklog,
    discoveryIntervalMin: t.discoveryIntervalMin,
    discoveryPerRound: t.discoveryPerRound,
    maxIssuesPerRound: t.maxIssuesPerRound,
    scoutProvider: t.scoutProvider,
    scoutModel: t.scoutModel,
    builderProvider: t.builderProvider,
    builderModel: t.builderModel,
    docsBuilderProvider: t.docsBuilderProvider,
    docsBuilderModel: t.docsBuilderModel,
    reviewerProvider: t.reviewerProvider,
    reviewerModel: t.reviewerModel,
    reviewerFallback: t.reviewerFallback,
  };
}

/** One GitHub login per line (a leading @ is fine), as the limits store them. */
export function parseLogins(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((l) => l.trim().replace(/^@/, ""))
        .filter((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(l)),
    ),
  ];
}

const SELECT =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] disabled:opacity-60";

/** What each merge policy does with a queued pull request that is behind the default branch. */
const MERGE_POLICY_HELP: Record<MergePolicy, string> = {
  fast: "A pull request behind the default branch merges on its own green CI as long as GitHub reports no conflict. It is re-tested first only when it and the new commits both changed dependency files or both changed migrations, or while the default branch is red.",
  strict:
    "A pull request behind the default branch is always brought up to date and waits for CI to pass again before it merges, one pull request at a time.",
};

const MERGE_POLICY_HINT =
  "Re-testing every pull request after each merge costs a full CI run per merge, so pull requests wait minutes instead of seconds. Fast skips it: GitHub reports conflicts, CI on the default branch is still watched after every merge, and a merge that breaks it is reverted.";

/** True when the limits carry the daily budget factory modes require. */
export function hasBudget(limits: FactoryLimits): boolean {
  return Boolean(limits.dailyBudget.usd || limits.dailyBudget.tokens);
}

/**
 * Factory settings (§10.1), enforced by the server rather than left to agents: who the factory
 * works for (trusted authors) and whether it merges by itself, a daily budget and an optional
 * per-item cap, the agent pool,
 * merges per day, the failure streak that pauses the loop, protected paths and deploys.
 * Optionally the merge-check tuning and, for a dark factory, the scout's limits.
 */
export function LimitsEditor({
  limits,
  onChange,
  tuning,
  onTuningChange,
  githubLogin,
  dark = false,
}: {
  limits: FactoryLimits;
  onChange: (l: FactoryLimits) => void;
  tuning?: TuningDraft;
  onTuningChange?: (t: TuningDraft) => void;
  /** The account Agent Rishi uses on GitHub (always trusted), when known. */
  githubLogin?: string | null;
  /** Show the dark factory's scout limits. */
  dark?: boolean;
}) {
  const id = useId();
  const [authors, setAuthors] = useState(() => limits.trustedAuthors.join("\n"));
  return (
    <div className="space-y-4" data-testid="limits-editor">
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.autoMerge}
          aria-label="Merge automatically"
          onCheckedChange={(autoMerge) => onChange({ ...limits, autoMerge })}
          className="mt-0.5"
        />
        <span>
          Merge automatically when every check passes
          <span className="block text-3xs text-muted-foreground">
            Off (recommended to start): every pull request waits for you to review and merge it.
            Work let in from an untrusted author always waits for you.
          </span>
        </span>
      </div>
      {limits.autoMerge && (
        <Field
          label="Merge policy"
          htmlFor={`${id}-policy`}
          hint={MERGE_POLICY_HINT}
          help={MERGE_POLICY_HELP[limits.mergePolicy]}
        >
          <select
            id={`${id}-policy`}
            className={SELECT}
            value={limits.mergePolicy}
            onChange={(e) => onChange({ ...limits, mergePolicy: e.target.value as MergePolicy })}
          >
            <option value="fast">Fast: merge on its own CI unless GitHub reports a conflict</option>
            <option value="strict">Strict: always re-test against the default branch</option>
          </select>
        </Field>
      )}
      {tuning && onTuningChange && (
        <SpotCheckField
          value={tuning.spotCheckPercent}
          dark={dark}
          onChange={(spotCheckPercent) => onTuningChange({ ...tuning, spotCheckPercent })}
        />
      )}
      {!dark && tuning && onTuningChange && (
        <div className="flex items-start gap-2.5 text-xs">
          <Switch
            checked={tuning.specApproval}
            aria-label="Approve specs before building"
            onCheckedChange={(specApproval) => onTuningChange({ ...tuning, specApproval })}
            className="mt-0.5"
          />
          <span>
            Approve specs before building
            <span className="block text-3xs text-muted-foreground">
              A feature stops after Analyze until you approve its spec or ask for changes, so a
              misunderstood request costs a short spec instead of a build and a review. Off: the
              agent builds its spec at once. A dark factory never waits, so it skips this.
            </span>
          </span>
        </div>
      )}
      <Field
        label="Trusted authors"
        htmlFor={`${id}-authors`}
        help={`GitHub logins, one per line. The factory only takes on issues they open${githubLogin ? `, plus @${githubLogin} (the account Agent Rishi uses)` : " and the account Agent Rishi uses"}. On a public repository anyone can open an issue: everyone else's are ignored until you let one in.`}
      >
        <Textarea
          id={`${id}-authors`}
          value={authors}
          placeholder={"octocat\nmy-teammate"}
          onChange={(e) => {
            setAuthors(e.target.value);
            onChange({ ...limits, trustedAuthors: parseLogins(e.target.value) });
          }}
          className="min-h-16 font-mono text-[12.5px]"
        />
      </Field>
      <BudgetFields limits={limits} onChange={onChange} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Agents at once"
          htmlFor={`${id}-conc`}
          help="The swarm: builders, reviewers and the scout share it."
        >
          <NumberField
            id={`${id}-conc`}
            min={1}
            value={limits.maxConcurrentSessions}
            onChange={(maxConcurrentSessions) => onChange({ ...limits, maxConcurrentSessions })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Auto-merges per day"
          htmlFor={`${id}-merges`}
          hint="With auto-merge on, the most pull requests Agent Rishi merges by itself in a day. Once it's reached, more work waits for tomorrow."
        >
          <NumberField
            id={`${id}-merges`}
            min={0}
            value={limits.maxMergesPerDay}
            onChange={(maxMergesPerDay) => onChange({ ...limits, maxMergesPerDay })}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Pause after failures"
          htmlFor={`${id}-fails`}
          hint="The factory pauses after this many failed merge checks or reverts in a row, so a broken setup doesn't keep spending. Resume it from the factory panel."
        >
          <NumberField
            id={`${id}-fails`}
            min={1}
            value={limits.pauseAfterConsecutiveFailures}
            onChange={(pauseAfterConsecutiveFailures) =>
              onChange({ ...limits, pauseAfterConsecutiveFailures })
            }
            className="text-[13px]"
          />
        </Field>
      </div>
      {tuning && onTuningChange && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="PRs open at most"
            htmlFor={`${id}-open-prs`}
            hint={WIP_HELP}
            help="Empty: the same as Agents at once."
          >
            <NumberField
              id={`${id}-open-prs`}
              optional
              min={1}
              value={tuning.maxOpenPrs}
              placeholder={`${limits.maxConcurrentSessions} (Agents at once)`}
              onChange={(maxOpenPrs) => onTuningChange({ ...tuning, maxOpenPrs })}
              className="text-[13px]"
            />
          </Field>
        </div>
      )}
      <Field
        label="Protected paths"
        htmlFor={`${id}-paths`}
        help="One glob per line, on top of the vision's protected areas. Changes there always go to you."
      >
        <Textarea
          id={`${id}-paths`}
          value={limits.protectedPaths.join("\n")}
          placeholder={"**/auth/**\ninfra/**"}
          onChange={(e) =>
            onChange({
              ...limits,
              protectedPaths: e.target.value
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
            })
          }
          className="min-h-20 font-mono text-[12.5px]"
        />
      </Field>
      <div className="flex items-start gap-2.5 text-xs">
        <Switch
          checked={limits.allowDeploys}
          aria-label="Allow deploys"
          onCheckedChange={(allowDeploys) => onChange({ ...limits, allowDeploys })}
          className="mt-0.5"
        />
        <span>
          Allow deploy and release changes
          <span className="block text-3xs text-muted-foreground">
            Off: workflows, Dockerfiles and hosting configs count as protected.
          </span>
        </span>
      </div>
      {dark && tuning && onTuningChange && (
        <ScoutTuning tuning={tuning} onChange={onTuningChange} />
      )}
      {tuning && onTuningChange && (
        <div className="space-y-3 border-t border-border pt-4" data-testid="merge-check-tuning">
          <div>
            <p className="text-[13px] font-medium">Merge checks</p>
            <p className="text-3xs text-muted-foreground">
              What a pull request must meet before it is ready to merge.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Largest change (lines)"
              htmlFor={`${id}-lines`}
              help="Lockfiles and generated files don't count. Leave empty for no limit."
            >
              <NumberField
                id={`${id}-lines`}
                optional
                min={1}
                value={tuning.maxChangedLines}
                placeholder="No limit"
                onChange={(maxChangedLines) => onTuningChange({ ...tuning, maxChangedLines })}
                className="text-[13px]"
              />
            </Field>
            <Field
              label="Most files changed"
              htmlFor={`${id}-files`}
              help="Leave empty for no limit."
            >
              <NumberField
                id={`${id}-files`}
                optional
                min={1}
                value={tuning.maxChangedFiles}
                placeholder="No limit"
                onChange={(maxChangedFiles) => onTuningChange({ ...tuning, maxChangedFiles })}
                className="text-[13px]"
              />
            </Field>
          </div>
          <p className="text-3xs text-muted-foreground">
            Over the limit, the project manager splits the work or allows it as one change (an
            initial scaffold, say). Nothing waits on you.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Revise rounds"
              htmlFor={`${id}-fixes`}
              hint="How many times the builder may revise a pull request after the reviewer asks for changes or a merge check fails. After that the item fails, and you can run it again from its page."
            >
              <NumberField
                id={`${id}-fixes`}
                min={0}
                value={tuning.maxFixAttempts}
                onChange={(maxFixAttempts) => onTuningChange({ ...tuning, maxFixAttempts })}
                className="text-[13px]"
              />
            </Field>
            <Field
              label="Watch main CI (minutes)"
              htmlFor={`${id}-watch`}
              hint="After an automatic merge, how long the factory watches CI on the default branch. A failure while it watches reverts the merge; CI still running after this long counts as done."
            >
              <NumberField
                id={`${id}-watch`}
                min={1}
                value={tuning.watchTimeoutMin}
                onChange={(watchTimeoutMin) => onTuningChange({ ...tuning, watchTimeoutMin })}
                className="text-[13px]"
              />
            </Field>
          </div>
          <div className="flex items-start gap-2.5 text-xs">
            <Switch
              checked={tuning.requireCi}
              aria-label="Require CI"
              onCheckedChange={(requireCi) => onTuningChange({ ...tuning, requireCi })}
            />
            <span>
              Require CI
              <span className="block text-3xs text-muted-foreground">
                Off: a repository without CI can still merge automatically.
              </span>
            </span>
          </div>
          <div className="flex items-start gap-2.5 text-xs">
            <Switch
              checked={tuning.learnFromReviews}
              aria-label="Learn from reviews"
              onCheckedChange={(learnFromReviews) =>
                onTuningChange({ ...tuning, learnFromReviews })
              }
            />
            <span>
              Learn from reviews
              <span className="block text-3xs text-muted-foreground">
                Reviewers record general lessons, and new builders and reviewers get them in their
                briefs. Off: none are asked for, kept or briefed.
              </span>
            </span>
          </div>
          <Field
            label="Audit command"
            htmlFor={`${id}-audit`}
            help="Optional security or dependency scan, run in the builder's worktree."
          >
            <Input
              id={`${id}-audit`}
              value={tuning.auditCommand ?? ""}
              placeholder="pnpm audit --prod"
              onChange={(e) =>
                onTuningChange({ ...tuning, auditCommand: e.target.value.trim() || null })
              }
              className="font-mono text-[12.5px]"
            />
          </Field>
        </div>
      )}
      {tuning && onTuningChange && (
        <AgentsTuning value={tuning} onChange={(a) => onTuningChange({ ...tuning, ...a })} />
      )}
    </div>
  );
}
