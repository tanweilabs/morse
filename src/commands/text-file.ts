import { readFileSync } from 'node:fs';

/**
 * The text of `morse send` / `morse reply`: the argument, or the content of `--text-file`
 * (ADR-080). A file reaches Morse untouched by the shell — on Windows a command line goes
 * through PowerShell and cmd.exe (npm's morse.cmd), which damage quotes, `%NAME%`, `& | < >`
 * and non-ASCII text, and is capped at 32,767 characters.
 *
 * The file is UTF-8. A byte-order mark is dropped, and UTF-16 with a byte-order mark (what
 * Windows PowerShell 5.1 writes with `>` / Out-File) is read as such; anything else that is
 * not valid UTF-8 is refused rather than sent as garbage. Exactly one trailing newline is
 * dropped (editors and `echo` add one). Throws an Error whose message is the line to print.
 *
 * On Windows, text as an ARGUMENT is refused when a program runs morse (stdin is not a
 * terminal: an agent, a script). Seen on a real machine: through npm's morse.cmd, cmd.exe
 * replaced `%PATH%` in the argument with the PATH itself before morse ever saw it — an agent
 * quoting somebody's `%SOME_SECRET%` into `morse reply <id> "…"` would send the secret. By the
 * time the text arrives here the damage is done and cannot be detected, so only the file is
 * accepted. A person typing in a terminal keeps the argument (and sees what they typed).
 */
export const TEXT_ARGUMENT_REFUSED =
  'on Windows a program must not pass the message text as an argument (cmd.exe rewrites %NAME%, quotes and & in it before morse sees it) — write the text to a UTF-8 file and use --text-file <file>';

export function messageTextFrom(arg: string | undefined, file: string | undefined, where: { platform?: NodeJS.Platform; stdinIsTTY?: boolean | undefined } = {}): string {
  if (file === undefined) {
    // the same words commander uses for a missing required argument
    if (arg === undefined) throw new Error("missing required argument 'message'");
    const platform = where.platform ?? process.platform;
    const tty = 'stdinIsTTY' in where ? where.stdinIsTTY : process.stdin.isTTY;
    if (platform === 'win32' && !tty) throw new Error(TEXT_ARGUMENT_REFUSED);
    return arg;
  }
  if (arg !== undefined) throw new Error('give the message as an argument or with --text-file, not both');
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw new Error(`cannot read --text-file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1))).swap16().toString('utf16le');
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`--text-file ${file} is not UTF-8 text — save it as UTF-8 (PowerShell: Set-Content -Encoding utf8, or [IO.File]::WriteAllText)`);
    }
  }
  text = text.replace(/\r?\n$/, '');
  if (!text) throw new Error(`--text-file ${file} is empty`);
  return text;
}
