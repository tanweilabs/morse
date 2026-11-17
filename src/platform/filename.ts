import { posix } from 'node:path';

/**
 * Names Windows maps to devices, with or without an extension ("NUL.txt" still writes to the
 * null device). COM0 / LPT0 and the superscript digits are reserved too.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;

/** Windows keeps paths under 260 characters for many tools; the inbox directory takes ~100 of them. */
const MAX_WINDOWS = 120;
const MAX = 200;

const trimEnd = (s: string): string => s.replace(/[. ]+$/, '');

/**
 * A file name chosen by the SENDER, made safe to create here — and on a Windows computer the
 * file may be forwarded to, so the rules are the same on every platform (ADR-080):
 *   - no directories, no control characters, no leading dot (as before);
 *   - `:` (on NTFS "report.txt:x" writes a hidden stream of report.txt) and `< > " | ? *`
 *     (refused by Windows) become `_`;
 *   - trailing dots and spaces are dropped (Windows drops them silently, so "a.txt." would
 *     land on "a.txt");
 *   - reserved device names (CON, NUL, COM1 … — with any extension) get a `_` in front.
 * An ordinary name comes back unchanged.
 */
export function safeFileName(name: string, platform: NodeJS.Platform = process.platform): string {
  // posix basename on purpose: "C:evil.txt" is a name with a colon in it, not a drive to strip — the same everywhere
  let base = posix
    .basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/[<>:"|?*]/g, '_');
  base = trimEnd(base);
  base = trimEnd(base.slice(0, platform === 'win32' ? MAX_WINDOWS : MAX));
  if (!base) return 'file';
  // the device name is what stands before the first dot, trailing spaces ignored
  const stem = (base.split('.')[0] ?? '').replace(/ +$/, '');
  return RESERVED.test(stem) ? `_${base}` : base;
}

/**
 * A name that does not collide with one already taken in the same directory — told apart with a `_`
 * in front, never overwritten. "Collide" as the file system sees it on macOS and Windows: `A.txt` and
 * `a.txt` are one file there, and so are two spellings of the same accented letter. `used` holds what
 * was handed out (the caller keeps one set per directory).
 */
export function uniqueFileName(name: string, used: Set<string>): string {
  const key = (n: string): string => n.normalize('NFC').toLowerCase();
  let out = name;
  while (used.has(key(out))) out = `_${out}`;
  used.add(key(out));
  return out;
}
