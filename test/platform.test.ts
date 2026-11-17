import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AclError, checkOwnerOnly, currentUser, parseSddl, protectDataDir, type Exec } from '../src/platform/acl.js';
import { AUTOSTART_TASK, autostartStatus, disableAutostart, enableAutostart, runCommandLine, taskXml } from '../src/platform/autostart.js';
import { describePlatformLimits, isWindows, offLine, offReason, platformLimits, platformOff } from '../src/platform/platform.js';
import { renameWithRetry } from '../src/platform/rename.js';
import { findExecutable } from '../src/platform/which.js';
import { windowsDoctorChecks } from '../src/platform/doctor-win.js';
import { daemonLockState, holdDaemonLock } from '../src/platform/daemon-lock.js';
import { isMorseDaemon, runningDaemonPid } from '../src/daemon/pidfile.js';
import { windowsStatusLines } from '../src/platform/status.js';

/**
 * Windows support, phase 1 (ADR-080). Everything Windows-specific takes the platform and the
 * system commands (icacls, whoami, schtasks, reg) as arguments, so the Windows branches run
 * here on macOS / Linux against fakes. None of this proves the real commands behave as the
 * fakes do — that is the real-machine checklist (docs/guides/windows.zh-CN.md).
 */

const tmp = mkdtempSync(join(tmpdir(), 'morse-platform-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => join(tmp, `${n++}-${name}`);

describe('renameWithRetry — a rename over a file another process has open', () => {
  const fail = (code: string) => Object.assign(new Error(code), { code });

  it('on Windows: EPERM / EBUSY / EACCES are retried with growing waits, then it succeeds', () => {
    const waits: number[] = [];
    let calls = 0;
    renameWithRetry('a', 'b', {
      platform: 'win32',
      rename: () => {
        if (calls++ < 3) throw fail(['EPERM', 'EBUSY', 'EACCES'][calls - 1]!);
      },
      sleep: (ms) => waits.push(ms),
    });
    expect(calls).toBe(4);
    expect(waits).toEqual([5, 10, 20]);
  });

  it('on Windows: gives up after about two seconds with the last error', () => {
    const waits: number[] = [];
    expect(() =>
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: () => {
          throw fail('EBUSY');
        },
        sleep: (ms) => waits.push(ms),
      }),
    ).toThrow('EBUSY');
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1500);
    expect(total).toBeLessThanOrEqual(2500);
  });

  it('on Windows: any other error is thrown at once', () => {
    let calls = 0;
    expect(() =>
      renameWithRetry('a', 'b', {
        platform: 'win32',
        rename: () => {
          calls++;
          throw fail('ENOENT');
        },
        sleep: () => undefined,
      }),
    ).toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('on macOS / Linux nothing is retried: EPERM there is a real permission problem', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      let calls = 0;
      expect(() =>
        renameWithRetry('a', 'b', {
          platform,
          rename: () => {
            calls++;
            throw fail('EPERM');
          },
          sleep: () => {
            throw new Error('must not wait');
          },
        }),
      ).toThrow('EPERM');
      expect(calls).toBe(1);
    }
  });

  it('really renames (default rename)', () => {
    const from = fresh('from');
    const to = fresh('to');
    writeFileSync(from, 'x');
    writeFileSync(to, 'old');
    renameWithRetry(from, to);
    expect(readFileSync(to, 'utf8')).toBe('x');
    expect(existsSync(from)).toBe(false);
  });
});

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OWNER_ONLY = `D:PAI(A;OICI;FA;;;${ME})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
const WIN_ENV = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

/** A stand-in for whoami.exe and icacls.exe: `acl` is what the directory's ACL reads back as. */
function fakeWindows(o: { acl?: string; grantCode?: number; saveCode?: number; whoami?: string; save?: 'utf16' | 'utf16-bom' | 'utf8' } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (file, args) => {
    calls.push([win32.basename(file), ...args]);
    expect(win32.isAbsolute(file), `${file} must be an absolute path (never looked up on PATH)`).toBe(true);
    const exe = win32.basename(file).toLowerCase();
    if (exe === 'whoami.exe') return { code: 0, stdout: o.whoami ?? `"desktop-x\\me","${ME}"\r\n`, stderr: '' };
    if (exe === 'icacls.exe') {
      const save = args.indexOf('/save');
      if (save >= 0) {
        if (o.saveCode) return { code: o.saveCode, stdout: '', stderr: 'Access is denied.' };
        const text = `${win32.basename(args[0]!)}\r\n${o.acl ?? OWNER_ONLY}\r\n`;
        // real icacls (Windows 11, checked 2026-11-15) writes UTF-16LE WITHOUT a byte-order mark
        const utf16 = Buffer.from(text, 'utf16le');
        writeFileSync(args[save + 1]!, o.save === 'utf8' ? text : o.save === 'utf16-bom' ? Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]) : utf16);
        return { code: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files', stderr: '' };
      }
      return o.grantCode ? { code: o.grantCode, stdout: '', stderr: 'The parameter is incorrect.' } : { code: 0, stdout: 'processed file', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${file}` };
  };
  return { exec, calls };
}

describe('the data directory is private to the owner on Windows (icacls; chmod does nothing there)', () => {
  it('parses an SDDL string: who is allowed, and whether inheritance is cut', () => {
    expect(parseSddl(OWNER_ONLY)).toMatchObject({ protected: true, allowed: [ME, 'SY', 'BA'] });
    expect(parseSddl('O:BAG:SYD:AI(A;ID;FA;;;BU)(D;;FA;;;WD)(A;OICIID;0x1200a9;;;AU)')).toMatchObject({ protected: false, allowed: ['BU', 'AU'], readOnly: ['AU'] });
    expect(parseSddl('D:P')).toMatchObject({ protected: true, allowed: [] });
    // read-only = read / execute and nothing else, in every entry of that trustee
    expect(parseSddl('D:(A;;FR;;;AU)(A;;FRFX;;;BU)(A;;0x1200a9;;;S-1-5-21-1-2-3-1017)(A;;0x1301bf;;;WD)(A;;FR;;;LG)(A;;FW;;;LG)')!.readOnly).toEqual(['AU', 'BU', 'S-1-5-21-1-2-3-1017']);
    expect(parseSddl('nonsense')).toBeNull();
    expect(parseSddl('')).toBeNull();
  });

  it('fails closed on what it cannot read: an entry with nested parentheses (a conditional ACE) is read, never skipped — nor is anything after it', () => {
    // review finding: `\([^()]*\)` stopped at the first nested parenthesis and silently dropped the rest of the list
    const conditional = `D:P(A;;FA;;;${ME})(XA;;FR;;;AU;(@User.Department=="Sales"))(A;;FA;;;WD)`;
    expect(parseSddl(conditional)).toMatchObject({ protected: true, allowed: [ME, 'AU', 'WD'] });
    expect(parseSddl('D:(XA;OICI;FA;;;BU;((@User.A==1) && (@Resource.B=="x")))(A;;FA;;;SY)')).toMatchObject({ allowed: ['BU', 'SY'] });
    // a SACL after the DACL is not part of it
    expect(parseSddl(`D:P(A;;FA;;;${ME})S:(AU;SA;FA;;;WD)`)).toMatchObject({ allowed: [ME] });
    // anything else left over is a refusal, not "nobody else"
    for (const bad of [`D:P(A;;FA;;;${ME})garbage`, `D:P(A;;FA;;;${ME})(A;;FA;;;WD`, `D:P(A;;FA;;;${ME}))`, 'D:P(A;;FA)', `D:P(A;;FA;;;${ME})x(A;;FA;;;WD)`]) expect(parseSddl(bad), bad).toBeNull();
  });

  it('the check built on it fails too: a conditional entry for Everyone behind the owner\'s is "also open to", an unreadable list is an error', () => {
    const file = fresh('cond.pem');
    writeFileSync(file, 'k');
    expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: `D:P(A;;FA;;;${ME})(XA;;FA;;;WD;(@User.X==1))` }).exec, env: WIN_ENV })).toMatchObject({ ok: false, others: ['WD'] });
    expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: `D:P(A;;FA;;;${ME})(A;;FA;;;WD` }).exec, env: WIN_ENV })).toMatchObject({ ok: false, error: expect.stringContaining('could not be read') });
  });

  it('who am I: the SID and the account name from whoami /user', () => {
    const w = fakeWindows();
    expect(currentUser({ exec: w.exec, env: WIN_ENV })).toEqual({ sid: ME, account: 'desktop-x\\me' });
    expect(w.calls[0]).toEqual(['whoami.exe', '/user', '/fo', 'csv', '/nh']);
    expect(() => currentUser({ exec: fakeWindows({ whoami: 'garbage' }).exec, env: WIN_ENV })).toThrow(/whoami/);
  });

  it('on macOS / Linux it does nothing at all — no command is run, no marker written', () => {
    const dir = fresh('unix-home');
    const w = fakeWindows();
    protectDataDir(dir, { platform: 'darwin', exec: w.exec });
    protectDataDir(dir, { platform: 'linux', exec: w.exec });
    expect(w.calls).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('on Windows: inheritance removed, only the owner / SYSTEM / Administrators granted — by SID, never by a localised name; then read back; then never run again', () => {
    const dir = fresh('win-home');
    const w = fakeWindows();
    protectDataDir(dir, { platform: 'win32', exec: w.exec, env: WIN_ENV });
    const grant = w.calls.find((c) => c[0] === 'icacls.exe' && c.includes('/inheritance:r'))!;
    expect(grant.slice(1)).toEqual([dir, '/inheritance:r', '/grant:r', `*${ME}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/grant:r', '*S-1-5-32-544:(OI)(CI)F', '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545']);
    expect(w.calls.some((c) => c[0] === 'icacls.exe' && c.includes('/save'))).toBe(true);
    expect(existsSync(join(dir, '.owner-only'))).toBe(true);
    // a second call (same process, or a later one that finds the marker) starts nothing
    const again = fakeWindows();
    protectDataDir(dir, { platform: 'win32', exec: again.exec, env: WIN_ENV });
    expect(again.calls).toEqual([]);
  });

  it('the marker is not trusted for ever: at daemon start (recheck) the ACL is read again, and a directory restored without its ACL is protected again', () => {
    // review finding: a data directory copied / restored WITH .owner-only but WITHOUT its ACL was never looked at again
    const dir = fresh('restored-home');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.owner-only'), '{}');
    // (1) what an ordinary command does: the marker is enough, nothing is run
    const quiet = fakeWindows();
    protectDataDir(dir, { platform: 'win32', exec: quiet.exec, env: WIN_ENV });
    expect(quiet.calls).toEqual([]);
    // (2) the daemon: reads the ACL — still right: nothing is changed
    const fine = fakeWindows({ acl: OWNER_ONLY });
    protectDataDir(dir, { platform: 'win32', exec: fine.exec, env: WIN_ENV, recheck: true });
    expect(fine.calls.some((c) => c.includes('/save'))).toBe(true);
    expect(fine.calls.some((c) => c.includes('/inheritance:r'))).toBe(false);
    // (3) the daemon, on a restored copy: the ACL inherits from its new parent (Users can read) → protected again
    let acl = `D:AI(A;ID;FA;;;${ME})(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)`;
    const base = fakeWindows();
    const calls: string[][] = [];
    const restored: Exec = (file, args) => {
      calls.push(args);
      if (args.includes('/inheritance:r')) acl = OWNER_ONLY; // the grant does its work
      return fakeWindows({ acl }).exec(file, args);
    };
    void base;
    protectDataDir(dir, { platform: 'win32', exec: restored, env: WIN_ENV, recheck: true });
    expect(calls.some((c) => c.includes('/inheritance:r'))).toBe(true);
    // (4) right trustees but inheritance not cut (the copy sits in the profile): cut again, so a later change above cannot open it
    acl = `D:AI(A;ID;FA;;;${ME})(A;ID;FA;;;SY)(A;ID;FA;;;BA)`;
    calls.length = 0;
    protectDataDir(dir, { platform: 'win32', exec: restored, env: WIN_ENV, recheck: true });
    expect(calls.some((c) => c.includes('/inheritance:r'))).toBe(true);
    // (5) it cannot be made private: the daemon refuses to start, as at first creation
    const stuck = fakeWindows({ acl: `${OWNER_ONLY}(A;OICI;FA;;;WD)` });
    expect(() => protectDataDir(dir, { platform: 'win32', exec: stuck.exec, env: WIN_ENV, recheck: true })).toThrow(AclError);
  });

  it('fails closed: icacls refusing, an unreadable answer, or anybody else left in the ACL throws — and leaves no marker', () => {
    const cases: Array<[string, Parameters<typeof fakeWindows>[0], RegExp]> = [
      ['icacls exits non-zero', { grantCode: 87 }, /icacls.*exit 87.*The parameter is incorrect/s],
      ['the ACL cannot be read back', { saveCode: 5 }, /Access is denied/],
      ['the answer is not SDDL', { acl: 'what is this' }, /could not be read.*what is this/s],
      ['Users can still read it', { acl: `${OWNER_ONLY}(A;OICI;0x1200a9;;;BU)` }, /also open to BU/],
      ['Everyone can', { acl: `D:(A;;FA;;;${ME})(A;;FR;;;WD)` }, /also open to WD/],
      ['another account can', { acl: `D:P(A;;FA;;;${ME})(A;;FA;;;S-1-5-21-9-9-9-1002)` }, /also open to S-1-5-21-9-9-9-1002/],
    ];
    for (const [what, world, message] of cases) {
      const dir = fresh('closed');
      let thrown: unknown;
      try {
        protectDataDir(dir, { platform: 'win32', exec: fakeWindows(world).exec, env: WIN_ENV });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, what).toBeInstanceOf(AclError);
      expect((thrown as Error).message, what).toMatch(message);
      expect((thrown as Error).message, what).toContain('will not write private keys');
      expect(existsSync(join(dir, '.owner-only')), what).toBe(false);
    }
  });

  it('checkOwnerOnly (morse status --check): reads the ACL every time — UTF-16 without a byte-order mark (what icacls writes), with one, or UTF-8 — and names who else is in it', () => {
    const file = fresh('key.pem');
    writeFileSync(file, 'k');
    expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: `D:AI(A;ID;FA;;;${ME})(A;ID;FA;;;SY)(A;ID;FA;;;BA)` }).exec, env: WIN_ENV })).toMatchObject({ ok: true, others: [] });
    for (const save of ['utf16', 'utf16-bom', 'utf8'] as const) {
      expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: `D:AI(A;ID;FA;;;${ME})(A;ID;FR;;;AU)`, save }).exec, env: WIN_ENV }), save).toMatchObject({ ok: false, others: ['AU'] });
      expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: OWNER_ONLY, save }).exec, env: WIN_ENV }), save).toMatchObject({ ok: true, others: [] });
    }
    expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ saveCode: 5 }).exec, env: WIN_ENV })).toMatchObject({ ok: false, error: expect.stringContaining('Access is denied') });
    // the built-in Administrator account is written "LA" in SDDL, not as its SID — it is still the owner
    const admin = 'S-1-5-21-1-2-3-500';
    const asAdmin = fakeWindows({ whoami: `"pc\\administrator","${admin}"\r\n`, acl: 'D:P(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }).exec;
    expect(checkOwnerOnly(file, { platform: 'win32', exec: asAdmin, env: WIN_ENV })).toMatchObject({ ok: true, others: [] });
    expect(checkOwnerOnly(file, { platform: 'win32', exec: fakeWindows({ acl: 'D:P(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)' }).exec, env: WIN_ENV })).toMatchObject({ ok: false, others: ['LA'] });
  });
});

describe('the Codex sandbox group on the data directory (seen on a real Windows 11)', () => {
  // what the directory read back as after the Codex desktop app's sandbox had been used: Codex added its
  // sandbox group (a local group, CodexSandboxUsers) with read + execute, inherited by key.pem
  const SANDBOX = 'S-1-5-21-1111111111-2222222222-3333333333-1017';
  const WITH_CODEX = `D:PAI(A;OICI;0x1200a9;;;${SANDBOX})(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`;
  /** icacls / whoami as before, plus PowerShell resolving a SID to its account name. */
  const withNames = (acl: string, names: Record<string, string>) => {
    const base = fakeWindows({ acl }).exec;
    const asked: string[] = [];
    const exec: Exec = (file, args) => {
      if (win32.basename(file).toLowerCase() === 'powershell.exe') {
        expect(win32.isAbsolute(file)).toBe(true);
        const sid = /S-1-[0-9-]+/.exec(args.join(' '))![0];
        asked.push(sid);
        return names[sid] ? { code: 0, stdout: `${names[sid]}\r\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'IdentityNotMappedException' };
      }
      return base(file, args);
    };
    return { exec, asked };
  };
  const file = fresh('codex-key.pem');
  writeFileSync(file, 'k');

  it('read-only access of the group named CodexSandboxUsers is not "somebody else can read your keys": reported apart, the check passes', () => {
    const w = withNames(WITH_CODEX, { [SANDBOX]: 'COMPUTER\\CodexSandboxUsers' });
    expect(checkOwnerOnly(file, { platform: 'win32', exec: w.exec, env: WIN_ENV })).toMatchObject({ ok: true, others: [], readers: ['COMPUTER\\CodexSandboxUsers'] });
    expect(w.asked).toEqual([SANDBOX]);
  });

  it('anything else stays a failure: the same group with WRITE access, another account that only reads, a name that does not resolve', () => {
    const write = withNames(WITH_CODEX.replace('0x1200a9', '0x1301bf'), { [SANDBOX]: 'COMPUTER\\CodexSandboxUsers' });
    expect(checkOwnerOnly(file, { platform: 'win32', exec: write.exec, env: WIN_ENV })).toMatchObject({ ok: false, others: [SANDBOX] });
    const other = withNames(WITH_CODEX, { [SANDBOX]: 'COMPUTER\\somebody' });
    expect(checkOwnerOnly(file, { platform: 'win32', exec: other.exec, env: WIN_ENV })).toMatchObject({ ok: false, others: [SANDBOX] });
    const unknown = withNames(WITH_CODEX, {});
    expect(checkOwnerOnly(file, { platform: 'win32', exec: unknown.exec, env: WIN_ENV })).toMatchObject({ ok: false, others: [SANDBOX] });
  });

  it('no name is looked up when there is nobody unexpected (the usual case costs nothing more)', () => {
    const w = withNames(OWNER_ONLY, {});
    expect(checkOwnerOnly(file, { platform: 'win32', exec: w.exec, env: WIN_ENV })).toMatchObject({ ok: true, others: [] });
    expect(w.asked).toEqual([]);
  });

  it('protecting a directory Codex has already put its group on does not refuse to write keys', () => {
    const dir = fresh('codex-home');
    protectDataDir(dir, { platform: 'win32', exec: withNames(WITH_CODEX, { [SANDBOX]: 'COMPUTER\\CodexSandboxUsers' }).exec, env: WIN_ENV });
    expect(existsSync(join(dir, '.owner-only'))).toBe(true);
  });

  it('morse status --check says it in words, and passes', () => {
    const home = fresh('codex-doctor');
    mkdirSync(join(home, '.morse'), { recursive: true });
    const names = withNames(WITH_CODEX, { [SANDBOX]: 'COMPUTER\\CodexSandboxUsers' }).exec;
    const exec: Exec = (f, a) => (/schtasks|reg\.exe/i.test(f) ? { code: 0, stdout: '', stderr: '' } : names(f, a));
    const c = windowsDoctorChecks({ home, dataDir: join(home, '.morse'), env: { ...WIN_ENV, PATH: 'C:\\Windows' }, exec }).find((x) => x.name.startsWith('private keys'))!;
    expect(c.ok).toBe(true);
    expect(c.note).toMatch(/readable \(not writable\) by .*CodexSandboxUsers/);
    expect(c.note).toContain('private keys included');
  });
});

describe('findExecutable — where is claude / codex (no `which` on Windows)', () => {
  const files = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\tools\\codex.exe', 'C:\\Users\\me\\.local\\bin\\claude.exe']);
  const exists = (p: string) => files.has(p);
  const env = { ...WIN_ENV, PATH: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('walks PATH with PATHEXT, in order', () => {
    expect(findExecutable('codex', { platform: 'win32', env, exists })).toBe('C:\\tools\\codex.exe');
    expect(findExecutable('claude', { platform: 'win32', env, exists })).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    expect(findExecutable('kimi', { platform: 'win32', env, exists })).toBeNull();
  });

  it('then the places the official installers use without touching PATH', () => {
    expect(findExecutable('claude', { platform: 'win32', env: { ...env, PATH: 'C:\\Windows' }, exists, extraDirs: ['C:\\Users\\me\\.local\\bin'] })).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
  });

  it('PATH is read whatever its case (Windows calls it Path)', () => {
    const { PATH, ...rest } = env;
    expect(findExecutable('codex', { platform: 'win32', env: { ...rest, Path: PATH }, exists })).toBe('C:\\tools\\codex.exe');
  });
});

describe('autostart — the daemon starts when the user logs on (a scheduled task; the Run registry value when that is refused)', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const cli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\anytoany\\dist\\cli.js';

  it('the task: this user at logon, not elevated, never stopped by the 72-hour limit or by running on battery', () => {
    const xml = taskXml({ node, cli, workdir: 'C:\\Users\\me', sid: ME, account: 'desktop-x\\me' });
    expect(xml).toContain('<LogonTrigger><Enabled>true</Enabled><UserId>desktop-x\\me</UserId></LogonTrigger>');
    expect(xml).toContain(`<UserId>${ME}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>`);
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain(`<Command>${node}</Command><Arguments>"${cli}" start --background --no-wait</Arguments><WorkingDirectory>C:\\Users\\me</WorkingDirectory>`);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
  });

  it('the task XML escapes what XML needs escaped; an account name that did not decode cleanly is replaced by the SID', () => {
    const xml = taskXml({ node: 'C:\\A&B\\node.exe', cli: 'C:\\x<y>\\cli.js', workdir: 'C:\\Users\\me', sid: ME, account: 'pc\\\ufffd\ufffd' });
    expect(xml).toContain('<Command>C:\\A&amp;B\\node.exe</Command>');
    expect(xml).toContain('<Arguments>"C:\\x&lt;y&gt;\\cli.js" start');
    expect(xml).toContain(`<LogonTrigger><Enabled>true</Enabled><UserId>${ME}</UserId></LogonTrigger>`);
  });

  /** A stand-in for whoami / schtasks / reg; `task` and `run` are what is registered. */
  const world = (o: { taskDenied?: boolean; regDenied?: boolean } = {}) => {
    const state = { task: null as string | null, run: null as string | null };
    const calls: string[][] = [];
    const exec: Exec = (file, args) => {
      const exe = win32.basename(file).toLowerCase();
      calls.push([exe, ...args]);
      expect(win32.isAbsolute(file)).toBe(true);
      if (exe === 'whoami.exe') return { code: 0, stdout: `"desktop-x\\me","${ME}"\r\n`, stderr: '' };
      if (exe === 'schtasks.exe') {
        if (args[0] === '/Create') {
          if (o.taskDenied) return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
          const bytes = readFileSync(args[args.indexOf('/XML') + 1]!);
          expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]); // UTF-16LE with a BOM, as schtasks expects
          state.task = bytes.subarray(2).toString('utf16le');
          return { code: 0, stdout: 'SUCCESS', stderr: '' };
        }
        if (args[0] === '/Query') return state.task ? { code: 0, stdout: 'MorseDaemon Ready', stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
        if (args[0] === '/Delete') {
          const had = state.task !== null;
          state.task = null;
          return { code: had ? 0 : 1, stdout: '', stderr: '' };
        }
      }
      if (exe === 'reg.exe') {
        if (args[0] === 'add') {
          if (o.regDenied) return { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' };
          state.run = args[args.indexOf('/d') + 1]!;
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'query') return state.run ? { code: 0, stdout: state.run, stderr: '' } : { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'delete') {
          const had = state.run !== null;
          state.run = null;
          return { code: had ? 0 : 1, stdout: '', stderr: '' };
        }
      }
      return { code: 1, stdout: '', stderr: `unexpected ${file}` };
    };
    return { exec, calls, state, deps: { platform: 'win32' as const, exec, env: WIN_ENV, node, cli, workdir: 'C:\\Users\\me', tmpdir: tmp } };
  };

  it('enable: registers the task and removes a Run value left by an earlier fallback — never both', () => {
    const w = world();
    w.state.run = 'old';
    expect(enableAutostart(w.deps)).toMatchObject({ kind: 'task' });
    expect(w.state.task).toContain('start --background --no-wait');
    expect(w.state.run).toBeNull();
    expect(w.calls.find((c) => c[0] === 'schtasks.exe' && c[1] === '/Create')).toEqual(['schtasks.exe', '/Create', '/TN', AUTOSTART_TASK, '/XML', expect.any(String), '/F']);
    expect(autostartStatus(w.deps)).toEqual({ kind: 'task' });
  });

  it('enable: when the task is refused (no rights) it falls back to the Run value, and says why', () => {
    const w = world({ taskDenied: true });
    const r = enableAutostart(w.deps);
    expect(r.kind).toBe('run-key');
    expect(r.detail).toContain('Access is denied');
    expect(w.state.run).toBe(runCommandLine(node, cli));
    expect(w.state.run).toBe(`"${node}" "${cli}" start --background --no-wait`);
    expect(autostartStatus(w.deps)).toEqual({ kind: 'run-key' });
  });

  it('enable: both refused is an error that carries both answers', () => {
    const w = world({ taskDenied: true, regDenied: true });
    expect(() => enableAutostart(w.deps)).toThrow(/scheduled task.*Access is denied.*Run value.*Access is denied/s);
    expect(autostartStatus(w.deps)).toEqual({ kind: 'none' });
  });

  it('a Run value longer than 260 characters is not written (Windows would ignore it)', () => {
    const w = world({ taskDenied: true });
    expect(() => enableAutostart({ ...w.deps, cli: `C:\\${'d'.repeat(250)}\\cli.js` })).toThrow(/260/);
    expect(w.state.run).toBeNull();
  });

  it('disable removes whichever is there; on macOS / Linux every call refuses', () => {
    const w = world();
    enableAutostart(w.deps);
    expect(disableAutostart(w.deps)).toEqual({ removed: ['task'] });
    expect(autostartStatus(w.deps)).toEqual({ kind: 'none' });
    expect(disableAutostart(w.deps)).toEqual({ removed: [] });
    expect(() => enableAutostart({ ...w.deps, platform: 'darwin' })).toThrow(/only on Windows/);
    expect(autostartStatus({ ...w.deps, platform: 'linux' })).toEqual({ kind: 'none' });
  });
});

describe('what is off on Windows in this release (ADR-080): said out loud, never a silent failure', () => {
  it('macOS / Linux: nothing is off, nothing is printed', () => {
    for (const p of ['darwin', 'linux'] as const) {
      expect(isWindows(p)).toBe(false);
      expect(platformLimits(p)).toEqual([]);
      expect(describePlatformLimits(p)).toEqual([]);
      for (const k of ['lan', 'plugins', 'update'] as const) expect(platformOff(k, p)).toBe(false);
    }
  });

  it('Windows: LAN, plugins (dispatch, attendant) and auto-update — each named, with what to do instead', () => {
    expect(isWindows('win32')).toBe(true);
    expect(platformLimits('win32').map((l) => l.key)).toEqual(['lan', 'plugins', 'update']);
    for (const k of ['lan', 'plugins', 'update'] as const) expect(platformOff(k, 'win32')).toBe(true);
    const text = describePlatformLimits('win32').join('\n');
    expect(text).toMatch(/^windows: pull-only in this release/);
    expect(text).toContain('morse read');
    for (const word of ['LAN', 'dispatch', 'attendant', 'auto-update', 'install.ps1']) expect(text).toContain(word);
  });

  it('Windows: direct links (WebRTC) are on, as on macOS (ADR-080 #33, P5) — not listed as off, the usual direct: line says how they are', () => {
    expect(platformLimits('win32').some((l) => (l.key as string) === 'direct')).toBe(false);
    expect(describePlatformLimits('win32').join('\n')).not.toMatch(/direct/i);
    expect(offLine('direct' as never, 'win32')).toBeNull();
    // one line each for the daemon log and for a refused command
    expect(offLine('lan', 'win32')).toBe('LAN (Morse on the same network): not available on Windows in this release (ADR-080) — every message goes through the relay, end-to-end encrypted');
    expect(offReason('plugins', 'win32')).toMatch(/^not available on Windows in this release \(ADR-080\) — a message reaches an agent at its next prompt/);
    expect(offLine('lan', 'darwin')).toBeNull();
    expect(offReason('plugins', 'linux')).toBeNull();
  });
});

describe('morse status --check on Windows: no false alarms, and the Windows-only failures are visible', () => {
  const HOME = fresh('doctor-home');
  const DATA = join(HOME, '.morse');
  const NODE = 'C:\\Program Files\\nodejs\\node.exe';
  const CLI = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\anytoany\\dist\\cli.js';
  const launcher = join(DATA, 'bin', 'morse-hook.cmd');
  const put = (rel: string, body: unknown) => {
    mkdirSync(join(HOME, rel, '..'), { recursive: true });
    writeFileSync(join(HOME, rel), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const system = (o: { acl?: string; autostart?: 'task' | 'run' | 'none' } = {}): Exec => {
    const acl = fakeWindows({ acl: o.acl ?? OWNER_ONLY }).exec;
    return (file, args) => {
      const exe = win32.basename(file).toLowerCase();
      if (exe === 'schtasks.exe') return { code: (o.autostart ?? 'task') === 'task' ? 0 : 1, stdout: '', stderr: '' };
      if (exe === 'reg.exe') return { code: o.autostart === 'run' ? 0 : 1, stdout: '', stderr: '' };
      return acl(file, args);
    };
  };
  const byName = (checks: Array<{ name: string; ok: boolean; note: string }>) => Object.fromEntries(checks.map((c) => [c.name, c]));
  const env = { ...WIN_ENV, PATH: 'C:\\Windows' };

  it('a healthy install: everything passes although neither agent CLI is on PATH and no key file has "mode 600"', () => {
    put('.claude/projects/x', '');
    put('.claude/settings.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: NODE, args: [CLI, 'hook', 'claude-prompt-submit'] }] }] } });
    put('.codex/hooks.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${launcher} codex-prompt-submit`, commandWindows: `${launcher} codex-prompt-submit` }] }] } });
    put('.morse/bin/morse-hook.cmd', '@echo off');
    put('.morse/identity/key.pem', 'k');
    put('.morse/hook-runs.json', { 'claude-prompt-submit': 1_000_000 });
    const checks = windowsDoctorChecks({ home: HOME, dataDir: DATA, env, exec: system(), now: () => 1_000_000 + 120_000 });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const c = byName(checks);
    expect(c['claude CLI']!.note).toContain('not needed in this release');
    expect(c['codex sessions']!.note).toContain('fine if you do not use Codex');
    expect(c['private keys (Windows access control)']!.note).toContain('you, SYSTEM and Administrators only');
    expect(c['claude inbox hook']!.note).toContain('last ran 2 min ago');
    // registered and correct, but it has never run: not an error — it says what makes it run
    expect(c['codex inbox hook']!.note).toMatch(/has not run yet.*trust/);
    expect(c['daemon at logon']!.note).toContain('scheduled task');
  });

  it('what is really wrong is reported: keys others can read, POSIX-form hooks, a missing launcher, no logon start', () => {
    put('.claude/settings.json', { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `'/usr/bin/node' '/x/dist/cli.js' hook claude-prompt-submit` }] }] } });
    rmSync(launcher);
    const c = byName(windowsDoctorChecks({ home: HOME, dataDir: DATA, env, exec: system({ acl: `${OWNER_ONLY}(A;OICI;0x1200a9;;;BU)`, autostart: 'none' }) }));
    expect(c['private keys (Windows access control)']).toMatchObject({ ok: false, note: expect.stringMatching(/also open to BU.*icacls/s) });
    expect(c['claude inbox hook']).toMatchObject({ ok: false, note: expect.stringContaining('a form Windows cannot run') });
    expect(c['codex inbox hook']).toMatchObject({ ok: false, note: expect.stringContaining('morse-hook.cmd is missing') });
    expect(c['daemon at logon']).toMatchObject({ ok: false, note: expect.stringContaining('morse autostart enable') });
  });

  it('finds an agent CLI where its installer put it, and says when it is only an npm shim', () => {
    const files = new Set(['C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe', 'C:\\npm\\claude.cmd']);
    const c = byName(windowsDoctorChecks({ home: HOME, dataDir: DATA, env: { ...env, PATH: 'C:\\npm' }, exec: system(), exists: (p) => files.has(p) || existsSync(p) }));
    expect(c['codex CLI']!.note).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
    expect(c['claude CLI']!.note).toBe('C:\\npm\\claude.cmd (an npm shim)');
  });
});

describe('what morse status adds on Windows', () => {
  const exec = (o: { task?: boolean; run?: boolean }): Exec => (file) => {
    const exe = win32.basename(file).toLowerCase();
    return { code: (exe === 'schtasks.exe' && o.task) || (exe === 'reg.exe' && o.run) ? 0 : 1, stdout: '', stderr: '' };
  };

  it('nothing on macOS / Linux — no command is even run', () => {
    const never: Exec = () => {
      throw new Error('must not run');
    };
    expect(windowsStatusLines({ platform: 'darwin', exec: never })).toEqual([]);
    expect(windowsStatusLines({ platform: 'linux', exec: never })).toEqual([]);
  });

  it('on Windows: how the daemon starts at logon (or that it does not), then everything that is off', () => {
    const task = windowsStatusLines({ platform: 'win32', exec: exec({ task: true }), env: WIN_ENV });
    expect(task[0]).toMatch(/^autostart: scheduled task MorseDaemon — the daemon starts when you log on, and stops when you log off/);
    expect(task.slice(1)).toEqual(describePlatformLimits('win32'));
    expect(windowsStatusLines({ platform: 'win32', exec: exec({ run: true }), env: WIN_ENV })[0]).toMatch(/^autostart: registry Run value MorseDaemon/);
    expect(windowsStatusLines({ platform: 'win32', exec: exec({}), env: WIN_ENV })[0]).toBe('autostart: NOT set up — the daemon will not start when you log on; run: morse autostart enable');
  });
});

describe('is the daemon alive? — on Windows the lock answers, not the pid (ADR-080, for the checks of ADR-083)', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  it('macOS / Linux: no lock is taken, nothing is asked of one — the command line decides, as before', () => {
    const never = () => {
      throw new Error('must not open anything');
    };
    for (const platform of ['darwin', 'linux'] as const) {
      expect(holdDaemonLock(fresh('unix-lock'), { platform, open: never })).toBeNull();
      expect(daemonLockState(fresh('unix-lock'), { platform, open: never })).toBe('none');
    }
    // a command line that can be read decides alone — the lock is not even looked at
    const lockMustNotBeAsked = () => {
      throw new Error('must not ask the lock');
    };
    expect(isMorseDaemon(1, () => '/usr/bin/node /x/dist/cli.js start', lockMustNotBeAsked)).toBe('yes');
    expect(isMorseDaemon(1, () => '/usr/bin/vim notes.txt', lockMustNotBeAsked)).toBe('no');
    expect(isMorseDaemon(1, () => null, () => 'none')).toBe('unknown');
  });

  it('Windows: the daemon opens daemon.lock in exclusive sharing mode and keeps it', () => {
    const dir = fresh('win-lock');
    const calls: Array<[string, number | string]> = [];
    const fd = holdDaemonLock(dir, {
      platform: 'win32',
      open: (path, flags) => {
        calls.push([path, flags]);
        return 42;
      },
    });
    expect(fd).toBe(42);
    expect(calls[0]![0]).toBe(join(dir, 'daemon.lock'));
    expect((calls[0]![1] as number) & 0x10000000).toBe(0x10000000); // UV_FS_O_EXLOCK
    expect(existsSync(dir)).toBe(true);
  });

  it('Windows: a command that is just looking has the file open for an instant — the daemon waits that out; a lock that stays held means another daemon', () => {
    let n = 0;
    const waits: number[] = [];
    expect(
      holdDaemonLock(fresh('win-lock'), {
        platform: 'win32',
        open: () => {
          if (n++ < 3) throw err('EBUSY');
          return 7;
        },
        sleep: (ms) => waits.push(ms),
      }),
    ).toBe(7);
    expect(waits).toHaveLength(3);
    expect(
      holdDaemonLock(fresh('win-lock'), {
        platform: 'win32',
        open: () => {
          throw err('EBUSY');
        },
        sleep: () => undefined,
        waitMs: 200,
      }),
    ).toBe('busy');
    // anything else is a real error, not "somebody holds it"
    expect(() =>
      holdDaemonLock(fresh('win-lock'), {
        platform: 'win32',
        open: () => {
          throw err('EACCES');
        },
      }),
    ).toThrow('EACCES');
  });

  it('Windows: held (EBUSY) / free (opens, and is closed again) / none (no such file)', () => {
    const closed: number[] = [];
    const state = (open: () => number) => daemonLockState('C:\\Users\\me\\.morse', { platform: 'win32', open, close: (fd) => void closed.push(fd) });
    expect(
      state(() => {
        throw err('EBUSY');
      }),
    ).toBe('held');
    expect(state(() => 5)).toBe('free');
    expect(closed).toEqual([5]);
    expect(
      state(() => {
        throw err('ENOENT');
      }),
    ).toBe('none');
  });

  it('so a stale pid file is not a running daemon: pid alive + lock free = another program; lock held = the daemon; no lock file = cannot tell (an older release)', () => {
    const noCommandLine = () => null; // Windows: nothing to read
    expect(isMorseDaemon(4242, noCommandLine, () => 'held')).toBe('yes');
    expect(isMorseDaemon(4242, noCommandLine, () => 'free')).toBe('no');
    expect(isMorseDaemon(4242, noCommandLine, () => 'none')).toBe('unknown');
    // (runningDaemonPid with this process's own pid file: returned unasked, as on every platform)
    expect(typeof runningDaemonPid).toBe('function');
  });
});
