import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { withoutAddressSelectors } from '../address-env.js';

/**
 * Plugin manager (ADR-052): the daemon starts each enabled plugin command, restarts it
 * when it exits (1 s, 2 s, 4 s … at most 60 s; back to 1 s after a minute of running),
 * stops it when disabled, and logs its output. That is all — the plugin talks to the
 * core through the plugin interface (docs/PLUGINS.md), never through the manager.
 *
 * ~/.morse/config.json: { "plugins": { "<name>": { "command": "…", "enabled": true } } }
 * The built-in `dispatch` plugin (your own agents) and `attendant` (your contacts,
 * ADR-066) need no entry: each is on unless `plugins.<name>.enabled` is false.
 */

export interface PluginConfigEntry {
  command?: string;
  enabled?: boolean;
}
export interface PluginSpec {
  name: string;
  /** argv; a configured string command runs through /bin/sh -c */
  argv: string[];
  enabled: boolean;
  builtin: boolean;
}

export const BUILTIN_DISPATCH = 'dispatch';
/** ADR-053: the iLink (WeChat) protocol plugin ships built in but is OFF unless enabled. */
export const BUILTIN_ILINK = 'ilink';
/** ADR-059 / ADR-066: the attendant (your agent answers your contacts) ships built in, ON unless disabled. */
export const BUILTIN_ATTENDANT = 'attendant';

export function pluginSpecs(cfg: Record<string, PluginConfigEntry> | undefined, builtin: { dispatch: string[]; ilink?: string[]; attendant?: string[] }): PluginSpec[] {
  const entries = cfg && typeof cfg === 'object' ? cfg : {};
  const out: PluginSpec[] = [{ name: BUILTIN_DISPATCH, argv: builtin.dispatch, enabled: entries[BUILTIN_DISPATCH]?.enabled !== false, builtin: true }];
  // a command of the owner's own under "ilink" replaces the built-in one
  const ownIlink = typeof entries[BUILTIN_ILINK]?.command === 'string' && Boolean(entries[BUILTIN_ILINK]?.command?.trim());
  if (builtin.ilink && !ownIlink) out.push({ name: BUILTIN_ILINK, argv: builtin.ilink, enabled: entries[BUILTIN_ILINK]?.enabled === true, builtin: true });
  const ownAttendant = typeof entries[BUILTIN_ATTENDANT]?.command === 'string' && Boolean(entries[BUILTIN_ATTENDANT]?.command?.trim());
  if (builtin.attendant && !ownAttendant) out.push({ name: BUILTIN_ATTENDANT, argv: builtin.attendant, enabled: entries[BUILTIN_ATTENDANT]?.enabled !== false, builtin: true });
  for (const [name, e] of Object.entries(entries)) {
    if (name === BUILTIN_DISPATCH || !e || typeof e.command !== 'string' || !e.command.trim()) continue;
    out.push({ name, argv: ['/bin/sh', '-c', e.command], enabled: e.enabled !== false, builtin: false });
  }
  return out;
}

export interface PluginStatus {
  name: string;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  lastExit: { code: number | null; at: number } | null;
}

export interface PluginManagerOptions {
  specs: () => PluginSpec[];
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Written on every change, read by `morse plugin list`. */
  statusFile?: string;
  intervalMs?: number;
  now?: () => number;
  /** How long a plugin gets to stop after SIGTERM before it is killed (default PLUGIN_STOP_GRACE_MS). */
  stopGraceMs?: number;
}

/**
 * ADR-089: a plugin that is told to stop lets a running agent turn finish for up to 10 s (dispatch), then
 * finishes its `morse` commands — so it gets 15 s before it is killed. A plugin with nothing running exits
 * at once, as before. (launchd gives the daemon itself 20 s by default.)
 */
export const PLUGIN_STOP_GRACE_MS = 15_000;

export interface PluginManager {
  reconcile(): void;
  status(): PluginStatus[];
  stop(): Promise<void>;
}

export function startPluginManager(opts: PluginManagerOptions): PluginManager {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? Date.now;
  interface Run {
    child: ChildProcess | null;
    startedAt: number | null;
    restarts: number;
    backoffMs: number;
    nextStart: number;
    lastExit: PluginStatus['lastExit'];
    argvKey: string;
  }
  const runs = new Map<string, Run>();
  let stopped = false;
  const grace = opts.stopGraceMs ?? PLUGIN_STOP_GRACE_MS;
  /**
   * (ADR-089 review F1) A plugin is told to stop ONCE: one SIGTERM, then SIGKILL if it is still there after
   * the grace. Asking again — the daemon's shutdown used to call `stop()` twice, `reconcile()` asks on every
   * tick — sends nothing more: a second SIGTERM made the dispatch plugin give up the turn it was waiting for.
   */
  const asked = new WeakSet<ChildProcess>();
  const askToStop = (c: ChildProcess): boolean => {
    if (asked.has(c)) return false;
    asked.add(c);
    const t = setTimeout(() => c.kill('SIGKILL'), grace);
    t.unref();
    c.once('exit', () => clearTimeout(t));
    c.kill('SIGTERM');
    return true;
  };
  let stopping: Promise<void> | null = null;

  const writeStatus = () => {
    if (!opts.statusFile) return;
    try {
      mkdirSync(dirname(opts.statusFile), { recursive: true });
      writeFileSync(opts.statusFile, `${JSON.stringify({ at: now(), plugins: manager.status() }, null, 2)}\n`);
    } catch {
      /* best effort */
    }
  };

  const start = (spec: PluginSpec, run: Run) => {
    // (ADR-088 §4) a plugin works for every address here: MORSE_ADDRESS of whatever started the daemon is not handed on.
    // MORSE_DAEMON_PID (ADR-089): who supervises it — a plugin stops taking work the moment this process is gone.
    const child = spawn(spec.argv[0]!, spec.argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...withoutAddressSelectors({ ...process.env, ...opts.env }), MORSE_DAEMON_PID: String(process.pid) } });
    run.child = child;
    run.startedAt = now();
    run.argvKey = spec.argv.join('\0');
    log(`plugin ${spec.name}: started (pid ${child.pid ?? '?'})`);
    for (const stream of [child.stdout, child.stderr]) {
      if (stream) createInterface({ input: stream }).on('line', (l) => log(`plugin ${spec.name}: ${l}`));
    }
    child.on('error', (e) => log(`plugin ${spec.name}: could not start: ${e.message}`));
    child.on('exit', (code, signal) => {
      const ranMs = now() - (run.startedAt ?? now());
      run.child = null;
      run.lastExit = { code, at: now() };
      if (!stopped) {
        run.backoffMs = ranMs > 60_000 ? 1000 : Math.min(60_000, run.backoffMs ? run.backoffMs * 2 : 1000);
        run.nextStart = now() + run.backoffMs;
        run.restarts++;
        log(`plugin ${spec.name}: exited (${signal ?? code}) — restarting in ${Math.round(run.backoffMs / 1000)} s`);
      }
      writeStatus();
    });
    writeStatus();
  };

  const manager: PluginManager = {
    reconcile() {
      if (stopped) return;
      const specs = opts.specs();
      for (const spec of specs) {
        const run = runs.get(spec.name) ?? { child: null, startedAt: null, restarts: 0, backoffMs: 0, nextStart: 0, lastExit: null, argvKey: '' };
        runs.set(spec.name, run);
        if (!spec.enabled) {
          if (run.child && askToStop(run.child)) log(`plugin ${spec.name}: disabled — stopping`);
          continue;
        }
        if (run.child && run.argvKey !== spec.argv.join('\0')) {
          if (askToStop(run.child)) log(`plugin ${spec.name}: command changed — restarting`);
          run.nextStart = 0;
          continue;
        }
        if (!run.child && now() >= run.nextStart) start(spec, run);
      }
      for (const [name, run] of runs) {
        if (!specs.some((s) => s.name === name) && run.child && askToStop(run.child)) log(`plugin ${name}: removed — stopping`);
      }
    },
    status() {
      return [...runs].map(([name, r]) => ({ name, pid: r.child?.pid ?? null, startedAt: r.child ? r.startedAt : null, restarts: r.restarts, lastExit: r.lastExit }));
    },
    stop() {
      // idempotent: every caller waits for the same stop
      stopping ??= (async () => {
        stopped = true;
        clearInterval(timer);
        const alive = [...runs.values()].map((r) => r.child).filter((c): c is ChildProcess => Boolean(c));
        await Promise.all(
          alive.map(
            (c) =>
              new Promise<void>((resolve) => {
                c.once('exit', () => resolve());
                askToStop(c);
              }),
          ),
        );
        writeStatus();
      })();
      return stopping;
    },
  };
  const timer = setInterval(() => manager.reconcile(), opts.intervalMs ?? 2000);
  timer.unref();
  manager.reconcile();
  return manager;
}

export function readPluginStatus(file: string): { at: number; plugins: PluginStatus[] } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { at: number; plugins: PluginStatus[] };
  } catch {
    return null;
  }
}
