import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createShutdown, SHUTDOWN_DEADLINE_MS } from '../src/daemon/shutdown.js';
import { PLUGIN_STOP_GRACE_MS } from '../src/plugin/manager.js';
import { TEXT } from '../src/plugins/ilink/bridge.js';
import { ensureServiceFileTimeouts, patchLaunchdPlist, patchSystemdUnit, serviceFilePath } from '../src/update/service-file.js';
import { OUTPUT_GRACE_MS, realExec, spawnWatch } from '../src/adapters/exec.js';
import { detectServiceJob, jobIsThisHomes, serviceJobFile, startCommand, startThroughServiceManager, type ServiceManager } from '../src/update/updater.js';

/**
 * ADR-089, third review round: what an EXISTING install needs so that a stop waits for an agent turn (N1 —
 * the service file is fixed in place), the daemon's own stop under a hard deadline (N5), and the pieces of
 * `morse stop --restart`. Everything here works on temp files: never the real LaunchAgents directory, never
 * a real service.
 */

const repo = resolve(__dirname, '..');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'morse-service-file-'));
  dirs.push(d);
  return d;
};

/** What site/install.sh writes today (its `plist()` / `unit()` templates, variables filled in). */
const installer = readFileSync(join(repo, 'site', 'install.sh'), 'utf8');
const template = (open: string, close: string): string => {
  const from = installer.indexOf(open) + open.length;
  return installer
    .slice(from, installer.indexOf(`\n${close}\n`, from) + 1)
    .replace(/\$\{LABEL\}/g, 'talk.morse.daemon')
    .replace(/\$\{NODE_BIN\}/g, '/usr/local/bin/node')
    .replace(/\$\{ENTRY\}/g, '/usr/local/lib/node_modules/anytoany/dist/cli.js')
    .replace(/\$\{DAEMON_PATH\}/g, '/usr/local/bin:/usr/bin:/bin')
    .replace(/\$\{HOME\}/g, '/Users/you')
    .replace(/\$\{DATA_DIR\}/g, '/Users/you/.morse');
};
const PLIST_NOW = template('plist() {\n  cat <<PLIST\n', 'PLIST');
const UNIT_NOW = template('unit() {\n  cat <<UNIT\n', 'UNIT');
/** …and what it wrote before ADR-089. */
const PLIST_BEFORE = PLIST_NOW.replace('  <key>ExitTimeOut</key><integer>30</integer>\n', '');
const UNIT_BEFORE = UNIT_NOW.replace('KillMode=mixed\nTimeoutStopSec=30\n', '');

describe('an existing install gets the stop timeouts: our own service file, fixed in place (ADR-089 review N1)', () => {
  it('the templates are what this test thinks they are', () => {
    expect(PLIST_NOW).toContain('<key>Label</key><string>talk.morse.daemon</string>');
    expect(PLIST_NOW).toContain('<key>ExitTimeOut</key><integer>30</integer>');
    expect(PLIST_BEFORE).not.toContain('ExitTimeOut');
    expect(UNIT_NOW).toMatch(/\[Service\]\nExecStart=.* start\n/);
    expect(UNIT_BEFORE).not.toMatch(/KillMode|TimeoutStopSec/);
    expect(30_000).toBeGreaterThan(PLUGIN_STOP_GRACE_MS);
  });

  it('launchd: the older plist becomes exactly the one the installer writes now; one that has ExitTimeOut, or is not ours, is left alone', () => {
    expect(patchLaunchdPlist(PLIST_BEFORE)).toBe(PLIST_NOW);
    expect(patchLaunchdPlist(PLIST_NOW)).toBeNull(); // idempotent
    expect(patchLaunchdPlist(PLIST_NOW.replace('<integer>30</integer>', '<integer>90</integer>'))).toBeNull(); // the owner's own value stays
    expect(patchLaunchdPlist(PLIST_BEFORE.replace('talk.morse.daemon', 'com.example.other'))).toBeNull();
    // a plist without ThrottleInterval (hand-written): the key goes in before the end of the dictionary
    const bare = PLIST_BEFORE.replace('  <key>ThrottleInterval</key><integer>10</integer>\n', '');
    expect(patchLaunchdPlist(bare)).toBe(bare.replace('</dict>\n</plist>', '  <key>ExitTimeOut</key><integer>30</integer>\n</dict>\n</plist>'));
  });

  it('launchd: a plist rewritten by plutil / defaults (key and value on separate lines, tabs) stays valid — the new key never lands between a key and its value', () => {
    // what `plutil -convert xml1` writes: one element per line, tab-indented
    const multiline = PLIST_BEFORE.replace(/^( *)<key>([^<]+)<\/key>(<[^\n]+)$/gm, (_m, _sp, key: string, value: string) => `\t<key>${key}</key>\n\t${value}`);
    expect(multiline).toContain('<key>ThrottleInterval</key>\n\t<integer>10</integer>');
    const out = patchLaunchdPlist(multiline)!;
    expect(out).toContain('<key>ThrottleInterval</key>\n\t<integer>10</integer>\n');
    expect(out).not.toMatch(/<key>ThrottleInterval<\/key>\s*<key>/);
    // every key is directly followed by its value (no key-key pairs)
    expect(out.match(/<key>[^<]*<\/key>\s*<key>/g)).toBeNull();
    expect(out).toContain('<key>ExitTimeOut</key><integer>30</integer>');
    expect(patchLaunchdPlist(out)).toBeNull();
    // a dictionary nested inside (e.g. EnvironmentVariables) is not the end of the top-level one
    const nested = multiline.replace('\t<key>ThrottleInterval</key>\n\t<integer>10</integer>\n', '');
    const outNested = patchLaunchdPlist(nested)!;
    expect(outNested.match(/<key>[^<]*<\/key>\s*<key>/g)).toBeNull();
    expect(outNested.indexOf('<key>ExitTimeOut</key>')).toBeGreaterThan(outNested.lastIndexOf('</dict>', outNested.lastIndexOf('</dict>') - 1));
  });

  it('systemd: the older unit becomes exactly the one the installer writes now; only what is missing is added', () => {
    expect(patchSystemdUnit(UNIT_BEFORE)).toBe(UNIT_NOW);
    expect(patchSystemdUnit(UNIT_NOW)).toBeNull();
    const own = UNIT_BEFORE.replace('RestartSec=10\n', 'RestartSec=10\nKillMode=process\n'); // the owner chose a KillMode: kept
    expect(patchSystemdUnit(own)).toBe(own.replace('KillMode=process\n', 'KillMode=process\nTimeoutStopSec=30\n'));
    expect(patchSystemdUnit('[Unit]\nDescription=something else\n\n[Service]\nExecStart=/usr/bin/other\n')).toBeNull();
  });

  it('on disk: only the file under THIS home, written whole (same mode), once; nothing when there is none', () => {
    // macOS
    const mac = tmp();
    const plist = serviceFilePath({ platform: 'darwin', home: mac })!;
    expect(plist).toBe(join(mac, 'Library', 'LaunchAgents', 'talk.morse.daemon.plist'));
    expect(ensureServiceFileTimeouts({ platform: 'darwin', home: mac })).toEqual({ outcome: 'absent', file: plist });
    expect(existsSync(join(mac, 'Library'))).toBe(false); // nothing is created
    mkdirSync(join(mac, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, PLIST_BEFORE);
    chmodSync(plist, 0o600);
    const other = join(mac, 'Library', 'LaunchAgents', 'com.example.other.plist');
    writeFileSync(other, PLIST_BEFORE.replace('talk.morse.daemon', 'com.example.other'));
    let reloads = 0;
    expect(ensureServiceFileTimeouts({ platform: 'darwin', home: mac, reload: () => void reloads++ })).toEqual({ outcome: 'patched', file: plist });
    expect(readFileSync(plist, 'utf8')).toBe(PLIST_NOW);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(readFileSync(other, 'utf8')).not.toContain('ExitTimeOut');
    expect(reloads).toBe(0); // launchd is not asked anything: it reads the plist when it loads the job
    expect(ensureServiceFileTimeouts({ platform: 'darwin', home: mac })).toEqual({ outcome: 'ok', file: plist });
    // a file at that path that is not our job's
    writeFileSync(plist, PLIST_BEFORE.replace('talk.morse.daemon', 'com.example.other'));
    expect(ensureServiceFileTimeouts({ platform: 'darwin', home: mac }).outcome).toBe('not-ours');

    // Linux (XDG_CONFIG_HOME honoured, as the installer does)
    const linux = tmp();
    const unit = serviceFilePath({ platform: 'linux', home: linux, env: {} })!;
    expect(unit).toBe(join(linux, '.config', 'systemd', 'user', 'morse.service'));
    expect(serviceFilePath({ platform: 'linux', home: linux, env: { XDG_CONFIG_HOME: join(linux, 'cfg') } })).toBe(join(linux, 'cfg', 'systemd', 'user', 'morse.service'));
    mkdirSync(join(linux, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(unit, UNIT_BEFORE);
    expect(ensureServiceFileTimeouts({ platform: 'linux', home: linux, env: {}, reload: () => void reloads++ })).toEqual({ outcome: 'patched', file: unit });
    expect(readFileSync(unit, 'utf8')).toBe(UNIT_NOW);
    expect(reloads).toBe(1); // `systemctl --user daemon-reload`: re-reads unit files, restarts nothing
    expect(ensureServiceFileTimeouts({ platform: 'linux', home: linux, env: {}, reload: () => void reloads++ }).outcome).toBe('ok');
    expect(reloads).toBe(1);
    // Windows: no service file of ours
    expect(ensureServiceFileTimeouts({ platform: 'win32', home: linux })).toEqual({ outcome: 'absent', file: null });
  });

  it('a file that cannot be written is an outcome, not an exception', () => {
    const home = tmp();
    const plist = serviceFilePath({ platform: 'darwin', home })!;
    mkdirSync(plist, { recursive: true }); // a directory where the file should be
    expect(ensureServiceFileTimeouts({ platform: 'darwin', home }).outcome).toBe('error');
  });

  it('macOS: a patched plist that would not pass plutil -lint is never written — the file stays as it was', () => {
    const home = tmp();
    const plist = serviceFilePath({ platform: 'darwin', home })!;
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plist, PLIST_BEFORE);
    const seen: string[] = [];
    const r = ensureServiceFileTimeouts({ platform: 'darwin', home, lintPlist: (t) => (seen.push(t), false) });
    expect(r.outcome).toBe('error');
    expect(r.detail).toContain('plutil -lint');
    expect(seen).toEqual([PLIST_NOW]);
    expect(readFileSync(plist, 'utf8')).toBe(PLIST_BEFORE);
  });
});

describe('`morse stop --restart`: the service manager side (ADR-089 review N1)', () => {
  it('is the daemon\'s job set up at all? launchd: `launchctl print` of the target; systemd: `systemctl --user cat` of the unit', async () => {
    const calls: string[] = [];
    const ok = async (cmd: string, args: string[]) => (calls.push([cmd, ...args].join(' ')), '');
    const no = async () => Promise.reject(new Error('Could not find service'));
    expect(await detectServiceJob({ platform: 'darwin', uid: 501, run: ok })).toEqual({ kind: 'launchd', target: 'gui/501/talk.morse.daemon' });
    expect(await detectServiceJob({ platform: 'linux', run: ok })).toEqual({ kind: 'systemd', unit: 'morse.service' });
    expect(calls).toEqual(['/bin/launchctl print gui/501/talk.morse.daemon', 'systemctl --user cat morse.service']);
    expect(await detectServiceJob({ platform: 'darwin', uid: 501, run: no })).toBeNull();
    expect(await detectServiceJob({ platform: 'win32', run: ok })).toBeNull();
  });

  it('a job that is not running is started — never with -k', () => {
    expect(startCommand({ kind: 'launchd', target: 'gui/501/talk.morse.daemon' })).toEqual(['/bin/launchctl', ['kickstart', 'gui/501/talk.morse.daemon']]);
    expect(startCommand({ kind: 'systemd', unit: 'morse.service' })).toEqual(['systemctl', ['--user', '--no-block', 'start', 'morse.service']]);
  });

  it('the restart advice everywhere is `morse stop --restart`, not a hard restart through the service manager', () => {
    // skill-repo/ is its own repository (ADR-086): not in the public export, so only checked where it is
    const files = ['skills/morse/SKILL.md', 'skill-repo/skills/morse/SKILL.md', 'docs/QUICKSTART.md', 'docs/QUICKSTART.en.md'];
    for (const f of files.filter((p) => !p.startsWith('skill-repo/') || existsSync(join(repo, p)))) {
      const text = readFileSync(join(repo, f), 'utf8');
      expect(text, f).toContain('morse stop --restart');
      expect(text.replace(/Do not use `launchctl kickstart -k …`|不要再用 `launchctl kickstart -k …`/g, ''), f).not.toMatch(/kickstart -k|systemctl --user restart/);
    }
    expect(installer).not.toMatch(/after fixing it: launchctl kickstart/);
  });
});

describe('the daemon\'s own stop: once, and under a hard deadline (ADR-089 reviews F1, N5)', () => {
  const make = (over: Partial<Parameters<typeof createShutdown>[0]> = {}) => {
    const exits: number[] = [];
    const log: string[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const ran: string[] = [];
    let release!: () => void;
    const waited = new Promise<void>((r) => (release = r));
    const s = createShutdown({
      steps: [() => void ran.push('a'), () => void ran.push('b')],
      wait: () => waited,
      exit: (c) => void exits.push(c),
      log: (l) => log.push(l),
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      ...over,
    });
    return { s, exits, log, timers, ran, release, settle: () => new Promise((r) => setTimeout(r, 5)) };
  };

  it('runs once; exits 0 when what it waits for is done; a request after that just ends the process', async () => {
    const t = make();
    t.s.request();
    t.s.request(); // a second signal while plugins finish their turns
    expect(t.ran).toEqual(['a', 'b']);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(SHUTDOWN_DEADLINE_MS);
    expect(SHUTDOWN_DEADLINE_MS).toBeGreaterThan(PLUGIN_STOP_GRACE_MS + 5000);
    expect(t.exits).toEqual([]);
    t.release();
    await t.settle();
    expect(t.exits).toEqual([0]);
    expect(t.s.state()).toBe('stopped');
    t.timers[0]!.fn(); // the deadline passing later changes nothing
    expect(t.exits).toEqual([0]);
    t.s.request(); // (the service manager's restart signal after an update)
    expect(t.exits).toEqual([0, 0]);
  });

  it('a step that throws does not stop the others — and what never finishes is ended by the deadline, non-zero (the service manager starts it again)', async () => {
    const t = make({
      steps: [
        () => {
          throw new Error('running.stop is not a function');
        },
        () => undefined,
      ],
    });
    const ran: string[] = [];
    const u = make({ steps: [() => { throw new Error('boom'); }, () => void ran.push('second')] });
    u.s.request();
    expect(ran).toEqual(['second']);
    expect(u.log).toEqual(['stopping: boom']);

    t.s.request();
    await t.settle();
    expect(t.exits).toEqual([]); // plugins never came back
    t.s.request(); // later signals are still ignored while it is stopping …
    expect(t.exits).toEqual([]);
    t.timers[0]!.fn(); // … but the deadline armed FIRST ends it
    expect(t.exits).toEqual([1]);
    expect(t.log.join('\n')).toMatch(/running\.stop is not a function[\s\S]*the orderly stop did not finish within 30 s — exiting now/);
  });

  it('a wait that throws or rejects still ends in an exit; an update\'s restart takes over instead of the exit', async () => {
    const a = make({ wait: () => { throw new Error('lan.stop blew up'); } });
    a.s.request();
    await a.settle();
    expect(a.exits).toEqual([0]);
    expect(a.log).toEqual(['stopping: lan.stop blew up']);
    let restarted = 0;
    const b = make({ wait: async () => undefined, after: () => (restarted++, true) });
    b.s.request();
    await b.settle();
    expect(restarted).toBe(1);
    expect(b.exits).toEqual([]); // the service manager's signal ends it …
    b.s.request();
    expect(b.exits).toEqual([0]); // … like this
  });
});

describe('what the WeChat user is told about a message that was given up (ADR-089 review N4)', () => {
  it('says plainly that it may have been handled completely, only not confirmed — and to look before sending it again', () => {
    expect(TEXT.gaveUp).toContain('可能已经处理完了');
    expect(TEXT.gaveUp).toContain('没能确认');
    expect(TEXT.gaveUp).toContain('重发之前请先看一下');
    expect(TEXT.gaveUp).not.toContain('没有处理完');
  });
});

describe('follow-up M5: a service-manager job counts only when it was loaded from THIS home\'s file', () => {
  const launchd: ServiceManager = { kind: 'launchd', target: 'gui/501/talk.morse.daemon' };
  const systemd: ServiceManager = { kind: 'systemd', unit: 'morse.service' };
  const print = (path: string) => `gui/501/talk.morse.daemon = {\n\tactive count = 1\n\tpath = ${path}\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /usr/local/bin/node\n\tpid = 4242\n}\n`;

  it('the file a job was loaded from: launchd says `path = …`, systemd the unit\'s FragmentPath', async () => {
    const calls: string[] = [];
    const run = (out: string) => async (cmd: string, args: string[]) => (calls.push([cmd, ...args].join(' ')), out);
    expect(await serviceJobFile(launchd, run(print('/Users/you/Library/LaunchAgents/talk.morse.daemon.plist')))).toBe('/Users/you/Library/LaunchAgents/talk.morse.daemon.plist');
    expect(await serviceJobFile(systemd, run('/home/you/.config/systemd/user/morse.service\n'))).toBe('/home/you/.config/systemd/user/morse.service');
    expect(calls).toEqual(['/bin/launchctl print gui/501/talk.morse.daemon', 'systemctl --user show -p FragmentPath --value morse.service']);
    expect(await serviceJobFile(launchd, run('gui/501/talk.morse.daemon = {\n\tstate = running\n}\n'))).toBeNull();
    expect(await serviceJobFile(systemd, run('\n'))).toBeNull();
    expect(await serviceJobFile(launchd, async () => Promise.reject(new Error('Could not find service')))).toBeNull();
  });

  it('this home\'s file IS the loaded one (also through a symlink): ours. Another home with a service file of its own, no file here, or a manager that says nothing: not ours', async () => {
    const real = tmp();
    const mine = join(real, 'Library', 'LaunchAgents', 'talk.morse.daemon.plist');
    mkdirSync(join(real, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(mine, PLIST_NOW);
    const says = (path: string) => ({ run: async () => print(path) });
    expect(await jobIsThisHomes(launchd, mine, says(mine))).toBe(true);
    const link = join(tmp(), 'home-link');
    symlinkSync(real, link);
    expect(await jobIsThisHomes(launchd, join(link, 'Library', 'LaunchAgents', 'talk.morse.daemon.plist'), says(mine))).toBe(true);
    // a second home that has a plist of its own at the same relative place: the loaded job is the real home's
    const second = tmp();
    const theirs = join(second, 'Library', 'LaunchAgents', 'talk.morse.daemon.plist');
    mkdirSync(join(second, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(theirs, PLIST_NOW);
    expect(await jobIsThisHomes(launchd, theirs, says(mine))).toBe(false);
    expect(await jobIsThisHomes(launchd, join(tmp(), 'Library', 'LaunchAgents', 'talk.morse.daemon.plist'), says(mine))).toBe(false); // no file in this home
    expect(await jobIsThisHomes(launchd, null, says(mine))).toBe(false);
    expect(await jobIsThisHomes(launchd, mine, { run: async () => 'gui/501/talk.morse.daemon = {\n}\n' })).toBe(false);
    expect(await jobIsThisHomes(launchd, mine, says('/nonexistent/talk.morse.daemon.plist'))).toBe(false);
  });
});

describe('follow-up M1: `morse start` where a service manager runs the daemon', () => {
  const launchd: ServiceManager = { kind: 'launchd', target: 'gui/501/talk.morse.daemon' };
  const make = (over: Partial<Parameters<typeof startThroughServiceManager>[0]> = {}) => {
    const ran: string[] = [];
    const asked: string[] = [];
    const o: Parameters<typeof startThroughServiceManager>[0] = {
      env: {},
      pid: 777,
      jobOf: async () => (asked.push('jobOf'), null),
      job: async () => (asked.push('job'), launchd),
      ours: async () => (asked.push('ours'), true),
      running: () => null,
      run: async (cmd) => void ran.push(cmd.flat().join(' ')),
      ...over,
    };
    return { o, ran, asked };
  };

  it('by hand, the job is this home\'s and nothing runs: the service manager starts it (no -k) — not a second, unmanaged daemon', async () => {
    const t = make();
    expect(await startThroughServiceManager(t.o)).toMatchObject({ handled: true, how: 'started', job: launchd });
    expect(t.ran).toEqual(['/bin/launchctl kickstart gui/501/talk.morse.daemon']);
    const sd = make({ job: async () => ({ kind: 'systemd', unit: 'morse.service' }) });
    await startThroughServiceManager(sd.o);
    expect(sd.ran).toEqual(['systemctl --user --no-block start morse.service']);
  });

  it('this process IS the job (the service manager ran `morse start`): never handed over — by the manager\'s record of the pid, or by the job\'s environment, before anything is asked', async () => {
    const byPid = make({ jobOf: async () => launchd });
    expect(await startThroughServiceManager(byPid.o)).toEqual({ handled: false });
    expect(byPid.ran).toEqual([]);
    for (const env of [{ XPC_SERVICE_NAME: 'talk.morse.daemon' }, { SYSTEMD_EXEC_PID: '777' }]) {
      const t = make({ env });
      expect(await startThroughServiceManager(t.o)).toEqual({ handled: false });
      expect(t.asked).toEqual([]); // not even a launchctl call
      expect(t.ran).toEqual([]);
    }
    // somebody else's job environment is not ours (a terminal app started by launchd, a child of another unit)
    for (const env of [{ XPC_SERVICE_NAME: 'application.com.apple.Terminal.1' }, { SYSTEMD_EXEC_PID: '12' }, { INVOCATION_ID: 'abc' }]) expect((await startThroughServiceManager(make({ env }).o)).handled).toBe(true);
  });

  it('no job, or a job that is another home\'s: `morse start` goes on as it always did (foreground) — nothing is asked of the service manager', async () => {
    const none = make({ job: async () => null });
    expect(await startThroughServiceManager(none.o)).toEqual({ handled: false });
    const other = make({ ours: async () => false });
    expect(await startThroughServiceManager(other.o)).toEqual({ handled: false });
    expect([...none.ran, ...other.ran]).toEqual([]);
  });

  it('already running: said, nothing started; a start the service manager refuses: said as a failure — still no second daemon', async () => {
    const up = make({ running: () => 4242 });
    expect(await startThroughServiceManager(up.o)).toEqual({ handled: true, how: 'already-running', pid: 4242 });
    expect(up.ran).toEqual([]);
    const no = make({ run: async () => Promise.reject(new Error('Operation not permitted')) });
    expect(await startThroughServiceManager(no.o)).toMatchObject({ handled: true, how: 'failed', error: 'Operation not permitted' });
  });

  it('no hint in the code says `morse stop && morse start` any more — every one says `morse stop --restart`', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') && files.push(join(dir, e.name)));
    };
    walk(join(repo, 'src'));
    const left = files.filter((f) => /morse stop && morse start/.test(readFileSync(f, 'utf8')));
    expect(left).toEqual([]);
    const hints = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /restart[^\n]*morse stop --restart/.test(l)));
    expect(hints.length).toBeGreaterThanOrEqual(9); // (ADR-091) the hints of `agent` / `pair` went with them
  });
});

describe('follow-up M3: how an agent CLI ended is told at its EXIT, not when its output pipes close', () => {
  it('a CLI that is killed while a child of its own still holds the pipes: `ended` at once, the call answers after a short grace with the output so far — not at the time limit', async () => {
    const ends: Array<{ at: number; how: unknown }> = [];
    const t0 = Date.now();
    const watcher = { spawned: (pid: number) => void setTimeout(() => process.kill(pid, 'SIGTERM'), 600), ended: (_pid: number, how: unknown) => void ends.push({ at: Date.now() - t0, how }) };
    // the "agent CLI": prints, starts a child that inherits its stdout and lives for 8 s, then waits to be killed
    const script = `
      const { spawn } = require('child_process');
      process.stdout.write('partial answer\\n');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      setInterval(() => {}, 1000);`;
    const r = await spawnWatch.run(watcher, () => realExec(process.execPath, ['-e', script], { timeoutMs: 60_000 }));
    const took = Date.now() - t0;
    expect(ends).toHaveLength(1);
    expect(ends[0]!.how).toEqual({ code: null, signal: 'SIGTERM', timedOut: false });
    expect(ends[0]!.at).toBeLessThan(2000); // at the exit — it used to come with `close`, 8 s later (or at the time limit)
    expect(took).toBeGreaterThanOrEqual(600 + OUTPUT_GRACE_MS - 100);
    expect(took).toBeLessThan(600 + OUTPUT_GRACE_MS + 2500);
    expect(r.stdout).toBe('partial answer\n');
    expect(r.stderr).not.toContain('timeout');
  }, 30_000);

  it('the usual case is unchanged: output complete, answered when the pipes close, exit code kept', async () => {
    const t0 = Date.now();
    const r = await realExec(process.execPath, ['-e', 'console.log("x".repeat(200000)); process.exitCode = 3'], { timeoutMs: 20_000 });
    expect(r.code).toBe(3);
    expect(r.stdout.length).toBe(200001);
    expect(Date.now() - t0).toBeLessThan(OUTPUT_GRACE_MS);
  });
});
