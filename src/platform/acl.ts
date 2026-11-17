import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { isWindows, type Platform } from './platform.js';
import { envValue, system32 } from './which.js';

/**
 * Private keys on Windows (ADR-080). chmod changes nothing there but the read-only bit, so the
 * 0700 / 0600 modes every key file is written with protect nothing. Instead the DATA DIRECTORY
 * gets an ACL once: inheritance cut, full control for the owner, SYSTEM and Administrators and
 * nobody else — everything created inside inherits it. Windows OpenSSH asks the same of a key.
 *
 * It fails closed: if icacls cannot be run, refuses, or the ACL read back still names anybody
 * else, protectDataDir throws and the caller writes no key. There is no switch to skip it.
 *
 * Checked on a real Windows 11 (2026-11-15, docs/guides/windows-test-log.zh-CN.md): the icacls
 * arguments do what they should, and `/save` writes `<name>\r\n<SDDL>\r\n` in UTF-16LE without
 * a byte-order mark. The fakes in test/platform.test.ts write exactly that.
 */

/** Run a system command to its end. Synchronous: keys are created inside synchronous locks. */
export type Exec = (file: string, args: string[]) => { code: number; stdout: string; stderr: string };

export const systemExec: Exec = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { code: r.error ? 1 : (r.status ?? 1), stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
};

export interface AclDeps {
  platform?: Platform;
  exec?: Exec;
  env?: Record<string, string | undefined>;
  tmpdir?: string;
}

export interface ProtectOptions extends AclDeps {
  /**
   * Do not take the `.owner-only` marker's word: read the ACL again, and protect the directory again if
   * it is not private (or its inheritance is no longer cut). The daemon does this at every start — a data
   * directory copied or restored WITH its marker but WITHOUT its ACL would otherwise never be looked at.
   * Ordinary commands go by the marker (no process is started for them).
   */
  recheck?: boolean;
}

export class AclError extends Error {}

const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
/** Everyone, Authenticated Users, Users: explicit grants to these are removed. */
const BROAD = ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'];
/** SYSTEM and Administrators as SDDL writes them (two-letter alias, or the SID). */
const ALWAYS_ALLOWED = new Set(['SY', SYSTEM, 'BA', ADMINISTRATORS]);

export const OWNER_ONLY_MARKER = '.owner-only';

/** The user this process runs as: SID and account name (`whoami /user`). Throws when it cannot tell. */
export function currentUser(deps: AclDeps = {}): { sid: string; account: string } {
  const exec = deps.exec ?? systemExec;
  const r = exec(system32('whoami.exe', deps.env), ['/user', '/fo', 'csv', '/nh']);
  const sid = /S-1-\d+(?:-\d+)+/.exec(r.stdout)?.[0];
  if (r.code !== 0 || !sid) throw new AclError(`whoami /user did not name this account (exit ${r.code}): ${(r.stdout + r.stderr).trim() || 'no output'}`);
  const account = /^\s*"([^"]*)"/.exec(r.stdout)?.[1] ?? '';
  return { sid, account };
}

/**
 * Who a DACL in SDDL form lets in: the trustees of its ALLOW entries (SIDs or two-letter
 * aliases — never localised names), and whether inheritance from the parent is cut ("P").
 * null = not SDDL with a DACL.
 */
export function parseSddl(sddl: string): { protected: boolean; allowed: string[]; readOnly: string[] } | null {
  const head = /D:([A-Z]*)/.exec(sddl);
  if (!head) return null;
  const allowed: string[] = [];
  const writers = new Set<string>();
  // The entries are read one by one with the parentheses counted: a conditional entry
  // ("(XA;;FA;;;WD;(@User.X==1))") has parentheses inside, and a pattern that stops at the first
  // one would drop it AND every entry after it — "nobody else" where there is somebody. Whatever
  // is left over that is not an entry (and not the SACL that may follow) makes the whole ACL
  // unreadable: null, which every caller treats as a failure.
  let i = head.index + head[0].length;
  while (sddl[i] === '(') {
    let depth = 0;
    let end = -1;
    for (let j = i; j < sddl.length; j++) {
      if (sddl[j] === '(') depth++;
      else if (sddl[j] === ')' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) return null; // an entry that never closes
    // type;flags;rights;object;inherited object;trustee[;condition or attributes]
    const f = sddl.slice(i + 1, end).split(';');
    const type = f[0] ?? '';
    const trustee = f[5] ?? '';
    if (f.length < 6 || !trustee || /[()]/.test(trustee)) return null;
    i = end + 1;
    // D / XD / OD = deny; everything else (A, XA, OA …) lets the trustee in
    if (/^(D|XD|OD)$/.test(type)) continue;
    if (!allowed.includes(trustee)) allowed.push(trustee);
    if (!readOnlyRights(f[2] ?? '')) writers.add(trustee);
  }
  const rest = sddl.slice(i);
  if (rest !== '' && !/^S:/.test(rest)) return null;
  return { protected: (head[1] ?? '').includes('P'), allowed, readOnly: allowed.filter((t) => !writers.has(t)) };
}

/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE: what "(RX)" is in an access mask. */
const READ_EXECUTE = 0x1200a9;

/** Do these SDDL rights (a hex mask, or two-letter codes) allow reading / executing and nothing else? */
function readOnlyRights(rights: string): boolean {
  if (/^0x[0-9a-f]+$/i.test(rights)) return (Number.parseInt(rights, 16) & ~READ_EXECUTE) === 0;
  return rights.length > 0 && rights.length % 2 === 0 && (rights.match(/../g) ?? []).every((c) => c === 'FR' || c === 'FX' || c === 'GR' || c === 'GX');
}

/**
 * The text of a file `icacls /save` wrote. Real Windows 11 writes UTF-16LE WITHOUT a byte-order
 * mark (checked 2026-11-15); a mark, or UTF-8, is read too in case another build differs.
 */
function decodeSaved(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  // UTF-16LE of ASCII text: every second byte is zero
  let zeros = 0;
  for (let i = 1; i < bytes.length; i += 2) if (bytes[i] === 0) zeros++;
  if (bytes.length >= 2 && zeros * 4 >= bytes.length) return bytes.toString('utf16le');
  return bytes.toString('utf8').replace(/^\uFEFF/, '');
}

/** The DACL of `path` as SDDL (`icacls <path> /save <file>`; its last line is the SDDL). */
function readSddl(path: string, deps: AclDeps): { sddl: string } | { error: string } {
  const exec = deps.exec ?? systemExec;
  const out = join(deps.tmpdir ?? tmpdir(), `morse-acl-${randomBytes(6).toString('hex')}.txt`);
  try {
    const r = exec(system32('icacls.exe', deps.env), [path, '/save', out]);
    if (r.code !== 0) return { error: `icacls ${path} /save: exit ${r.code}: ${(r.stderr + r.stdout).trim() || 'no output'}` };
    const text = decodeSaved(readFileSync(out));
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { sddl: lines[lines.length - 1] ?? '' };
  } catch (e) {
    return { error: `icacls ${path} /save: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    rmSync(out, { force: true });
  }
}

export interface OwnerOnlyCheck {
  ok: boolean;
  /** Trustees other than the owner, SYSTEM and Administrators that the ACL lets in. */
  others: string[];
  /**
   * Account names that may READ (not write) and are expected: the Codex sandbox group. Not a
   * failure, but said — `morse status --check` names them.
   */
  readers?: string[];
  sddl?: string;
  /** Set when the ACL could not be read at all. */
  error?: string;
  /** Is inheritance from the parent directory cut ("P")? Unknown when the ACL could not be read. */
  protected?: boolean;
}

/** Does the ACL of `path` let in only its owner, SYSTEM and Administrators? Read fresh every time. */
export function checkOwnerOnly(path: string, deps: AclDeps = {}): OwnerOnlyCheck {
  let sid: string;
  try {
    sid = currentUser(deps).sid;
  } catch (e) {
    return { ok: false, others: [], error: e instanceof Error ? e.message : String(e) };
  }
  const r = readSddl(path, deps);
  if ('error' in r) return { ok: false, others: [], error: r.error };
  const acl = parseSddl(r.sddl);
  if (!acl) return { ok: false, others: [], sddl: r.sddl, error: `the ACL of ${path} could not be read (not SDDL): ${r.sddl || '(empty)'}` };
  // SDDL writes the built-in Administrator account (RID 500) as "LA" instead of its SID
  const me = new Set([sid, ...(sid.endsWith('-500') ? ['LA'] : [])]);
  const others: string[] = [];
  const readers: string[] = [];
  for (const t of acl.allowed) {
    if (me.has(t) || ALWAYS_ALLOWED.has(t)) continue;
    // Seen on a real Windows 11: the Codex desktop app's sandbox adds its local group, CodexSandboxUsers,
    // with read + execute to a directory its sandboxed agent reads. That is the owner's own agent (on
    // macOS a sandboxed agent can read ~/.morse too) — tolerated when it is exactly that: that name,
    // and no write access. Looked up only when somebody unexpected is there at all.
    const name = acl.readOnly.includes(t) ? accountName(t, deps) : null;
    if (name && /(^|\\)CodexSandboxUsers$/i.test(name)) readers.push(name);
    else others.push(t);
  }
  return { ok: others.length === 0, others, sddl: r.sddl, protected: acl.protected, ...(readers.length ? { readers } : {}) };
}

/** The account name of a SID (`MACHINE\\name`), null when it cannot be resolved. One PowerShell start: rare paths only. */
function accountName(sid: string, deps: AclDeps): string | null {
  if (!/^S-1-\d+(-\d+)+$/.test(sid)) return null;
  const exe = win32.join(envValue(deps.env ?? process.env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const r = (deps.exec ?? systemExec)(exe, ['-NoProfile', '-NonInteractive', '-Command', `([Security.Principal.SecurityIdentifier]'${sid}').Translate([Security.Principal.NTAccount]).Value`]);
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : null;
}

/** The command that makes a directory private, for messages (`morse status --check`). */
export function protectCommandLine(dir: string): string {
  return `icacls "${dir}" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r *${SYSTEM}:(OI)(CI)F /grant:r *${ADMINISTRATORS}:(OI)(CI)F /remove:g ${BROAD.map((s) => `*${s}`).join(' ')}`;
}

const done = new Set<string>();

/**
 * Make the data directory private to its owner, once. Called before any private key is
 * written and when the daemon starts. A no-op off Windows (the 0700 / 0600 modes do the job)
 * and on a directory already done (the `.owner-only` marker) — unless `recheck` asks to look again.
 * Throws AclError when it cannot.
 */
export function protectDataDir(dir: string, deps: ProtectOptions = {}): void {
  if (!isWindows(deps.platform)) return;
  if (done.has(dir) && !deps.recheck) return;
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, OWNER_ONLY_MARKER);
  if (existsSync(marker)) {
    if (!deps.recheck) {
      done.add(dir);
      return;
    }
    const now = checkOwnerOnly(dir, deps);
    if (now.ok && now.protected) {
      done.add(dir);
      return;
    }
    // not private any more (or it cannot be told): protected again below, or refused as at first creation
  }
  const refuse = (why: string): never => {
    throw new AclError(
      `cannot make ${dir} private to your Windows account — Morse will not write private keys or mail there.\n  ${why}\n  Keep the Morse data directory on an NTFS drive inside your user folder. If it already is, please send this whole message to the Morse maintainers.`,
    );
  };
  const exec = deps.exec ?? systemExec;
  let sid = '';
  try {
    sid = currentUser(deps).sid;
  } catch (e) {
    refuse(e instanceof Error ? e.message : String(e));
  }
  const args = [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', `*${SYSTEM}:(OI)(CI)F`, '/grant:r', `*${ADMINISTRATORS}:(OI)(CI)F`, '/remove:g', ...BROAD.map((s) => `*${s}`)];
  const r = exec(system32('icacls.exe', deps.env), args);
  if (r.code !== 0) refuse(`icacls ${args.slice(1).join(' ')}: exit ${r.code}: ${(r.stderr + r.stdout).trim() || 'no output'}`);
  const check = checkOwnerOnly(dir, deps);
  if (check.error) refuse(check.error);
  if (!check.ok) refuse(`after icacls the directory is also open to ${check.others.join(', ')} (ACL: ${check.sddl ?? '?'})`);
  writeFileSync(marker, `${JSON.stringify({ owner: sid, at: new Date().toISOString() })}\n`);
  done.add(dir);
}
