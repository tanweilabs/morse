import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearPid, commandLineOf, isAlive, isMorseDaemon, looksLikeMorseDaemon, readPid, runningDaemonPid, writePid } from '../src/daemon/pidfile.js';
import { dataDir } from '../src/home.js';
import { DAEMON_STUB_ENTRY, daemonStub, killStub, killStubs, unrelatedStub } from './helpers/stub-process.js';

const testHome = mkdtempSync(join(tmpdir(), 'morse-pidfile-'));
const pidFilePath = () => join(dataDir(), 'daemon.pid');

beforeAll(() => {
  process.env.ANYTOANY_HOME = testHome;
});
afterAll(async () => {
  await killStubs();
  delete process.env.ANYTOANY_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

describe('daemon.pid read / write / clear', () => {
  beforeEach(() => clearPid());

  it('writes the pid as plain text, creating the data folder', () => {
    rmSync(dirname(pidFilePath()), { recursive: true, force: true });
    writePid(4242);
    expect(readFileSync(pidFilePath(), 'utf8')).toBe('4242');
    expect(readPid()).toBe(4242);
  });

  it('defaults to the current process', () => {
    writePid();
    expect(readPid()).toBe(process.pid);
  });

  it('reads null when the file is missing or not a number', () => {
    expect(readPid()).toBeNull();
    mkdirSync(dirname(pidFilePath()), { recursive: true });
    writeFileSync(pidFilePath(), 'not-a-pid');
    expect(readPid()).toBeNull();
    writeFileSync(pidFilePath(), ' 77\n');
    expect(readPid()).toBe(77);
  });

  it('clearPid(own) keeps a file that records somebody else', () => {
    writePid(1001);
    clearPid(2002);
    expect(readPid()).toBe(1001);
    clearPid(1001);
    expect(existsSync(pidFilePath())).toBe(false);
  });

  it('clearPid() removes the file whoever it names, and tolerates a missing one', () => {
    writePid(3003);
    clearPid();
    expect(readPid()).toBeNull();
    expect(() => clearPid()).not.toThrow();
    expect(() => clearPid(5)).not.toThrow();
  });

  it('isAlive probes the process table', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999_999)).toBe(false);
  });
});

/**
 * (ADR-083 review N3) A pid file outlives its daemon after a crash or a reboot, and the system gives the pid
 * to another program. A live pid alone therefore does not say "the Morse daemon is running": the process
 * must read like one — else the file is stale.
 */
describe('is the process a pid file names a Morse daemon? (ADR-083 review N3)', () => {
  /** Where the command line of a process can be read (not on Windows; not where `ps` is forbidden). */
  const readable = commandLineOf(process.pid) !== null;

  it('a Morse daemon’s command line: the morse entry (the `morse` / `anyd` command, the package’s cli.js, cli.ts in a source tree), then `start`', () => {
    for (const line of [
      'node /opt/homebrew/bin/morse start',
      '/usr/local/bin/node /usr/local/bin/anyd start --no-web',
      '/usr/bin/node /home/u/.npm-global/lib/node_modules/anytoany/dist/cli.js start',
      'node /Users/you/My Files/lib/node_modules/anytoany/dist/cli.js start --interval 500', // (a space in the path)
      'node --import tsx src/cli.ts start --no-lan --no-notify',
      '/usr/bin/node --enable-source-maps /srv/morse/dist/cli.js start',
      'C:\\nodejs\\node.exe C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\anytoany\\dist\\cli.js start',
      'morse start',
    ]) {
      expect(looksLikeMorseDaemon(line), line).toBe(true);
    }
  });

  it('any other program is not one — nor a Morse command that is not the daemon', () => {
    for (const line of [
      '',
      'node -e setInterval(() => {}, 1 << 30)',
      '/Applications/Safari.app/Contents/MacOS/Safari',
      '-zsh',
      'sleep 1000',
      'vim /Users/you/code/morse/start',
      'node /usr/local/bin/morse watch', // (a Morse command, not the daemon)
      'npm start',
      'node server.js start',
      'node start /opt/homebrew/bin/morse', // (`start` before the entry is not its command)
      '(node)',
      '[kworker/0:1]',
    ]) {
      expect(looksLikeMorseDaemon(line), line).toBe(false);
    }
    // (a line that names the entry and has `start` anywhere behind it counts — it errs towards "a daemon", which is what a live pid meant before)
    expect(looksLikeMorseDaemon('node /usr/local/bin/morse send bob start')).toBe(true);
  });

  it.runIf(readable)('the command line of a live process is read — of one that is gone it cannot be', async () => {
    const d = await daemonStub('--no-web');
    expect(commandLineOf(d.pid!)).toContain(`${DAEMON_STUB_ENTRY} start --no-web`);
    await killStub(d);
    expect(commandLineOf(d.pid!)).toBeNull();
    expect(commandLineOf(0)).toBeNull();
    expect(commandLineOf(-5)).toBeNull();
  });

  it.runIf(readable)('yes for a process that reads like the daemon, no for any other live process', async () => {
    const [d, other] = [await daemonStub(), await unrelatedStub()];
    expect(isMorseDaemon(d.pid!)).toBe('yes');
    expect(isMorseDaemon(other.pid!)).toBe('no');
  });

  it('unknown where the command line cannot be read — nothing is concluded', () => {
    expect(isMorseDaemon(process.pid, () => null)).toBe('unknown');
    expect(isMorseDaemon(process.pid, () => 'node /usr/local/bin/morse start')).toBe('yes');
    expect(isMorseDaemon(process.pid, () => 'sleep 100')).toBe('no');
  });

  it.runIf(readable)('the pid of the running daemon: the pid file’s, when that process is a Morse daemon', async () => {
    const d = await daemonStub();
    writePid(d.pid!);
    expect(runningDaemonPid()).toBe(d.pid);
    expect(readPid()).toBe(d.pid);
  });

  it.runIf(readable)('a pid file that names another live program is stale: no daemon is running, and the file is removed', async () => {
    const other = await unrelatedStub();
    writePid(other.pid!);
    expect(runningDaemonPid()).toBeNull();
    expect(readPid()).toBeNull();
    expect(isAlive(other.pid!)).toBe(true); // (the other program was not touched)
  });

  it('a pid file that names a process that is gone: no daemon (the file is left, as ever); no pid file: no daemon', async () => {
    const gone = await unrelatedStub();
    await killStub(gone);
    writePid(gone.pid!);
    expect(runningDaemonPid()).toBeNull();
    expect(readPid()).toBe(gone.pid);
    clearPid();
    expect(runningDaemonPid()).toBeNull();
  });

  it('where the command line cannot be read a live pid is the daemon, as before — and this process’s own pid is never asked about', async () => {
    const other = await unrelatedStub();
    writePid(other.pid!);
    expect(runningDaemonPid(() => null)).toBe(other.pid);
    expect(readPid()).toBe(other.pid);
    writePid(process.pid);
    expect(
      runningDaemonPid(() => {
        throw new Error('not asked');
      }),
    ).toBe(process.pid);
    clearPid();
  });
});
