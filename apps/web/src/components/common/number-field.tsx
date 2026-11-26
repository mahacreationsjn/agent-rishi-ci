import { type ComponentProps, useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** What the text in a number field holds. */
export type ParsedNumber =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "number"; value: number };

/**
 * Reads the text of a number field: digits with an optional minus sign and, when `decimal`, one
 * decimal separator, a dot or a comma (whichever the user's keyboard types). Leading zeros are
 * fine ("05" is 5); anything else (letters, grouping, exponents) is invalid.
 */
export function parseNumber(text: string, decimal = false): ParsedNumber {
  const t = text.trim();
  if (t === "") return { kind: "empty" };
  const pattern = decimal ? /^-?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/ : /^-?\d+$/;
  if (!pattern.test(t)) return { kind: "invalid" };
  const value = Number(t.replace(",", "."));
  // `|| 0` turns -0 into 0.
  return Number.isFinite(value) ? { kind: "number", value: value || 0 } : { kind: "invalid" };
}

/** The user's decimal separator, so a fraction reads the way they type it. */
const DECIMAL =
  new Intl.NumberFormat().formatToParts(1.5).find((p) => p.type === "decimal")?.value === ","
    ? ","
    : ".";

/** A number as the field shows it: no leading zeros, no grouping, the user's decimal separator. */
export function formatNumber(value: number | null | undefined, decimal = false): string {
  if (value === null || value === undefined) return "";
  return decimal ? String(value).replace(".", DECIMAL) : String(value);
}

type InputProps = Omit<
  ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step" | "inputMode"
>;

type NumberFieldProps = InputProps & {
  /** The current valid number; null or undefined shows an empty field. */
  value: number | null | undefined;
  /** The lowest number the field takes; lower entries are raised to it on blur. */
  min?: number;
  /** The highest number the field takes; higher entries are lowered to it on blur. */
  max?: number;
  /** Takes fractions (a dot or a comma) and shows the decimal keyboard; whole numbers otherwise. */
  decimal?: boolean;
  /** Classes for the wrapper around the input and its message (`className` styles the input). */
  wrapperClassName?: string;
} & (
    | {
        /** An empty field is a valid value, such as "no limit": it saves as null. */
        optional: true;
        /** Each valid number as it is typed, and the settled one on blur or Enter. */
        onChange: (value: number | null) => void;
      }
    | {
        optional?: false;
        /** Each valid number as it is typed, and the settled one on blur or Enter. */
        onChange: (value: number) => void;
      }
  );

type Message = { text: string; error: boolean };

/**
 * The one number input of the app. While the user edits it keeps their text, so the field can be
 * empty and a new number replaces the old one; it passes each valid number in range on as it is
 * typed. On blur or Enter it settles the text: leading zeros go, a number outside `min`/`max`
 * is clamped with a short note, and an empty or unreadable entry goes back to the number from
 * before the edit, with a note (or, with nothing to go back to, shows an error and stays empty).
 * Empty is a valid entry only in an `optional` field. The form only ever holds valid numbers.
 * It selects its text on focus, so typing replaces it, and asks phones for a number keyboard.
 */
export function NumberField(props: NumberFieldProps) {
  const {
    value,
    min,
    max,
    decimal = false,
    optional = false,
    onChange,
    wrapperClassName,
    className,
    onFocus,
    onBlur,
    onKeyDown,
    onMouseDown,
    onMouseUp,
    ...rest
  } = props;
  const emit = onChange as (value: number | null) => void;
  const messageId = useId();
  // The user's text while they edit; null shows `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  // The number the field held when the edit began: an empty or unreadable entry goes back to it.
  const before = useRef<number | null>(null);
  // A click that focuses the field keeps the selection made on focus.
  const keepSelection = useRef(false);

  const inRange = (n: number) => (min === undefined || n >= min) && (max === undefined || n <= max);
  const send = (next: number | null) => {
    if (next !== (value ?? null)) emit(next);
  };
  const show = (n: number) => formatNumber(n, decimal);
  const needsNumber: Message = {
    text: decimal ? "Enter a number." : "Enter a whole number.",
    error: true,
  };

  const edit = (text: string) => {
    if (draft === null) before.current = value ?? null;
    setDraft(text);
    setMessage(null);
    const parsed = parseNumber(text, decimal);
    if (parsed.kind === "number" && inRange(parsed.value)) send(parsed.value);
    else if (parsed.kind === "empty" && optional) send(null);
  };

  const settle = () => {
    if (draft === null) {
      // Left empty without an edit: a field that needs a number says so.
      if (!optional && (value === null || value === undefined)) setMessage(needsNumber);
      return;
    }
    const parsed = parseNumber(draft, decimal);
    if (parsed.kind === "number") {
      let next = parsed.value;
      if (max !== undefined && next > max) {
        next = max;
        setMessage({ text: `The most is ${show(max)}.`, error: false });
      } else if (min !== undefined && next < min) {
        next = min;
        setMessage({ text: `The least is ${show(min)}.`, error: false });
      }
      send(next);
      setDraft(null);
    } else if (parsed.kind === "empty" && optional) {
      send(null);
      setDraft(null);
    } else {
      // Empty where a number is needed, or not a number: back to the number before the edit
      // (or the last one typed in it), or an error when there is none and the field needs one.
      const back = before.current ?? value ?? null;
      if (back === null && !optional) {
        setMessage(needsNumber);
        return;
      }
      const why =
        parsed.kind === "empty"
          ? "It needs a number"
          : decimal
            ? "That isn't a number"
            : "That isn't a whole number";
      setMessage({
        text:
          back === null ? `${why}, so it's empty again.` : `${why}, so it's back to ${show(back)}.`,
        error: false,
      });
      send(back);
      setDraft(null);
    }
  };

  return (
    <div className={cn("min-w-0", wrapperClassName)}>
      <Input
        {...rest}
        type="text"
        inputMode={decimal ? "decimal" : "numeric"}
        autoComplete="off"
        enterKeyHint="done"
        value={draft ?? formatNumber(value, decimal)}
        aria-invalid={message?.error || undefined}
        aria-describedby={cn(rest["aria-describedby"], message && messageId) || undefined}
        className={className}
        onChange={(e) => edit(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.select();
          onFocus?.(e);
        }}
        onMouseDown={(e) => {
          keepSelection.current = document.activeElement !== e.currentTarget;
          onMouseDown?.(e);
        }}
        onMouseUp={(e) => {
          if (keepSelection.current) e.preventDefault();
          keepSelection.current = false;
          onMouseUp?.(e);
        }}
        onBlur={(e) => {
          settle();
          onBlur?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") settle();
          onKeyDown?.(e);
        }}
      />
      {message && (
        <p
          id={messageId}
          role={message.error ? "alert" : "status"}
          className={cn(
            "mt-1 text-3xs leading-snug",
            message.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
