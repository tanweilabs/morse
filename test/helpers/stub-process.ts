import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Processes a `daemon.pid` can name in a test (ADR-083 review N3). Both only sleep; what differs is the
 * command line — which is how a command tells a Morse daemon from any other program:
 *
 *   - `daemonStub()`     reads like a Morse daemon: `node -e … /stub/anytoany/dist/cli.js start`
 *                        (the words after the script are its arguments: nothing is loaded from that path);
 *   - `unrelatedStub()`  any other program of the same user: `node -e …` — what a stale pid file names
 *                        once the daemon is gone and its pid was given to something else.
 */
const SLEEP = 'setInterval(() => {}, 1 << 30)';
const stubs: ChildProcess[] = [];

const started = (args: string[]): Promise<ChildProcess> =>
  new Promise((done, fail) => {
    const p = spawn(process.execPath, args, { stdio: 'ignore' });
    stubs.push(p);
    p.once('spawn', () => done(p));
    p.once('error', fail);
  });

export const DAEMON_STUB_ENTRY = '/stub/anytoany/dist/cli.js';
export const daemonStub = (...more: string[]): Promise<ChildProcess> => started(['-e', SLEEP, DAEMON_STUB_ENTRY, 'start', ...more]);
export const unrelatedStub = (): Promise<ChildProcess> => started(['-e', SLEEP]);
/** …started as the installed command is (`node /stub/bin/morse start`): what a search of the process table for "morse start" finds. */
export const morseStartStub = (): Promise<ChildProcess> => started(['-e', SLEEP, '/stub/bin/morse', 'start']);

export const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kill a stub and wait until its pid is gone. */
export const killStub = (p: ChildProcess): Promise<void> =>
  new Promise((done) => {
    if (p.exitCode !== null || p.signalCode !== null) return done();
    p.once('exit', () => done());
    p.kill('SIGKILL');
  });

/** Kill every stub this file started (afterAll). */
export const killStubs = (): Promise<void> => Promise.all(stubs.splice(0).map(killStub)).then(() => undefined);
