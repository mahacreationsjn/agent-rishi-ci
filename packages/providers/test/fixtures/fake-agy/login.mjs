// Fake login prompt for manual terminal checks. It only reports input metadata.
import { stdin, stdout } from "node:process";

const expected = "fake-login-".repeat(15);
if (!stdin.isTTY) throw new Error("Run the fake login in a terminal");

stdin.setRawMode(true);
stdout.write("Fake login. Paste the fixture text and press Enter.\r\n");
let input = Buffer.alloc(0);
stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  const cr = input.includes(13);
  const lf = input.includes(10);
  if (!cr && !lf) return;

  const end = input.findIndex((byte) => byte === 13 || byte === 10);
  const length = end;
  const esc = input.includes(27);
  const accepted = input.subarray(0, end).equals(Buffer.from(expected));
  stdout.write(`bytes=${length} ESC=${esc} CR=${cr} LF=${lf} accepted=${accepted}\r\n`);
  stdin.setRawMode(false);
  stdin.pause();
  process.exitCode = accepted ? 0 : 1;
});
