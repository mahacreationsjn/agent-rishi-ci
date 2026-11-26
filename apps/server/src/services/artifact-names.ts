/**
 * Characters a stored file's name never holds: path separators, what Windows forbids in a name,
 * control characters, and the direction marks that can make a name read differently from what
 * it is (`invoice‮fdp.exe` shows as `invoiceexe.pdf`).
 */
const UNSAFE = /[<>:"/\\|?*\p{Cc}؜‎‏‪-‮⁦-⁩]/gu;

/**
 * Device names Windows reserves, with or without an extension (`CON`, `nul.txt`, `COM1.log`),
 * also with spaces before the dot (`CON .txt`, which Windows reads as `CON`), and the console
 * names `CONIN$` and `CONOUT$`.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$) *(\.|$)/i;

/** Longest stored name in UTF-8 bytes: well under the usual 255, leaving room for the path. */
const MAX_NAME_BYTES = 120;

/** Longest ending (`.tar.gz` counts as `.gz`) kept when a long name is cut. */
const MAX_EXTENSION_CHARS = 16;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Dots and spaces Windows drops from the end of a name. */
const trimEnd = (s: string) => s.replace(/[. ]+$/u, "");

/** `name` cut to `MAX_NAME_BYTES` on a character boundary, keeping a short extension. */
function shorten(name: string, fallback: string): string {
  if (bytes(name) <= MAX_NAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS ? name.slice(dot) : "";
  let budget = MAX_NAME_BYTES - bytes(extension);
  let stem = "";
  for (const char of name.slice(0, name.length - extension.length)) {
    budget -= bytes(char);
    if (budget < 0) break;
    stem += char;
  }
  return `${trimEnd(stem) || fallback}${extension}`;
}

/**
 * A file name that is safe to create in a folder Agent Rishi owns, from a name a user gave a file:
 * only its last segment (no folders, so no `..`), no character any of Windows, macOS or Linux
 * refuses, no trailing dots or spaces, no reserved device name, at most `MAX_NAME_BYTES`.
 * Letters of every script are kept as they are (NFC), so `отчёт.pdf` and `報告.docx` stay
 * readable; a name with nothing left becomes `fallback`.
 */
export function safeFileName(name: string, fallback = "attachment"): string {
  const last = name.toWellFormed().split(/[\\/]/).pop() ?? "";
  const cleaned = trimEnd(last.normalize("NFC").replace(UNSAFE, "_").trim());
  const short = shorten(cleaned || fallback, fallback);
  return RESERVED.test(short) ? `_${short}` : short;
}
