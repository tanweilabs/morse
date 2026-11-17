import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CAP_LISTENER_PROOF, DAEMON_CAPABILITIES } from '../../src/daemon/capabilities.js';
import { LOCAL_TOKEN_HEADER } from '../../src/daemon/local-api.js';

/**
 * ADR-087 in tests: the daemon's local API answers only a caller that presents its token, and a command
 * talks only to the daemon its own home's daemon.json describes.
 *
 *   - `TEST_TOKEN`: the daemon token every console server of this suite is started with;
 *   - `authedFetch`: `fetch` with that token in the header (what the `morse` command does) — a test file that
 *     talks to a test server imports it AS `fetch`;
 *   - `daemonJson(home, port)`: this home's daemon.json — "the daemon of this home listens there" — so that
 *     the real CLI, run with that home, talks to the test's server (or stub) and to nothing else.
 */
export const TEST_TOKEN = '7e57'.repeat(12);

export const authedFetch = (input: string | URL, init: RequestInit = {}): Promise<Response> =>
  globalThis.fetch(input, { ...init, headers: { [LOCAL_TOKEN_HEADER]: TEST_TOKEN, ...((init.headers as Record<string, string> | undefined) ?? {}) } });

export interface DaemonJsonOptions {
  /** null = a daemon of a release before ADR-087: no token at all. */
  token?: string | null;
  /** Default: this test process (alive). A daemon.json WITHOUT a token is believed only for a pid that reads like a Morse daemon. */
  pid?: number;
  capabilities?: readonly string[];
  /**
   * The listener on `port` is a real console server of this suite (started with TEST_TOKEN): it can prove that it
   * holds the token, and daemon.json says so (`listener-proof`) — a command then asks for that proof before it
   * presents the token. Default false: a stub of a daemon cannot, so its daemon.json does not claim it.
   */
  proves?: boolean;
}
/** Ports on which a real console server of this suite listens (it can prove that it holds TEST_TOKEN). */
const proving = new Set<number>();
export const realServerOn = (port: number | string): void => void proving.add(Number(port));

export function daemonJson(home: string, port: number | string | null, o: DaemonJsonOptions = {}): void {
  if (o.proves === undefined && port !== null && proving.has(Number(port))) o = { ...o, proves: true };
  const dir = join(home, '.morse');
  mkdirSync(dir, { recursive: true });
  const token = o.token === undefined ? TEST_TOKEN : o.token;
  writeFileSync(
    join(dir, 'daemon.json'),
    `${JSON.stringify({ pid: o.pid ?? process.pid, port: port === null ? null : Number(port), capabilities: [...(o.capabilities ?? DAEMON_CAPABILITIES.filter((c) => o.proves || c !== CAP_LISTENER_PROOF))], ...(token ? { token } : {}) })}\n`,
    { mode: 0o600 },
  );
}
export const noDaemonJson = (home: string): void => rmSync(join(home, '.morse', 'daemon.json'), { force: true });

/** A port nobody listens on right now (the kernel picks it) — never a fixed number: two test runs may share this machine. */
export const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:net');
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
};

/**
 * (ADR-087 follow-up 2) A command given `--port <p>` talks to that port only when it IS the port its home's
 * daemon.json names. A test that points a command at a stub (or at a port nobody listens on) therefore says so
 * in the home's daemon.json for the length of that command — and puts back what was there.
 */
export async function withPortOf<T>(home: string, args: readonly string[], run: () => Promise<T>): Promise<T> {
  const i = args.indexOf('--port');
  if (i < 0 || i + 1 >= args.length) return run();
  const { existsSync, readFileSync } = await import('node:fs');
  const path = join(home, '.morse', 'daemon.json');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const port = Number(args[i + 1]);
  if (before === null) daemonJson(home, port);
  else {
    // (a daemon.json the test wrote is kept as it is — its pid, its token, what it says it can do: only the port follows)
    const was = JSON.parse(before) as { capabilities?: string[] };
    writeFileSync(path, `${JSON.stringify({ ...was, port, capabilities: (was.capabilities ?? []).filter((c) => proving.has(port) || c !== CAP_LISTENER_PROOF) })}\n`, { mode: 0o600 });
  }
  try {
    return await run();
  } finally {
    if (before === null) noDaemonJson(home);
    else writeFileSync(path, before, { mode: 0o600 });
  }
}
