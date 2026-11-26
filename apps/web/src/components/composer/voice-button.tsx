import { Loader2, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCombo } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import type { Dictation } from "./use-dictation";

/**
 * Dictation button (§11.3): toggles dictation (or hold the push-to-talk shortcut) and stays
 * honest when no engine is available. While the last segments are transcribed after stopping,
 * it shows a spinner until the text is in.
 */
export function VoiceButton({ dictation }: { dictation: Dictation }) {
  const { engine, phase, combo, pushToTalk, toggle } = dictation;
  const recording = phase === "listening";
  const finishing = phase === "finishing";

  const label = !engine.supported
    ? "Dictation isn't available in this browser. Choose Local (Whisper) in Settings > Voice."
    : finishing
      ? "Transcribing…"
      : recording
        ? "Stop dictation"
        : `Dictate · ${formatCombo(combo)}${pushToTalk ? ` · hold ${formatCombo(pushToTalk)}` : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!engine.supported || finishing}
            onClick={toggle}
            aria-label={label}
            aria-pressed={recording}
            className={cn(
              "relative text-muted-foreground",
              recording &&
                "bg-status-failed/12 text-status-failed hover:bg-status-failed/20 hover:text-status-failed",
            )}
          >
            {finishing ? (
              <Loader2 className="animate-spin" />
            ) : engine.supported ? (
              <Mic />
            ) : (
              <MicOff />
            )}
            {recording && (
              <span className="absolute inset-0 animate-ping rounded-[inherit] border border-status-failed/40 [animation-duration:1.6s]" />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
