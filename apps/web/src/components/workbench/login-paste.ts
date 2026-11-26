/** A login prompt takes one line. Keep Enter separate from the clipboard text. */
export function loginPaste(text: string): string {
  const code = text.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "").trim();
  // Reject multi-line input and any other control characters.
  return [...code].some((char) => {
    const point = char.charCodeAt(0);
    return point < 32 || (point >= 127 && point <= 159) || point === 0x2028 || point === 0x2029;
  })
    ? ""
    : code;
}
