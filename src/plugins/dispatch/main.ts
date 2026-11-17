#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../adapters/claude.js';
import { createCodexAdapter } from '../../adapters/codex.js';
import { createKimiAdapter } from '../../adapters/kimi.js';
import { createRegisteredAdapter } from '../../adapters/registered.js';
import type { SessionInfo } from '../../adapters/types.js';
import { VERSION_MISMATCH } from '../../adapters/version-guard.js';
import { createZcodeAdapter } from '../../adapters/zcode.js';
import { buildDoorbellFrame, doorbellUseful, liveClaudeInboxes, ringInbox } from '../../daemon/claude-inbox.js';
import { isMonitored } from '../../daemon/monitor.js';
import { createNotifier } from '../../daemon/notify.js';
import { isSessionLive } from '../../daemon/session-liveness.js';
import { listAllSessions } from '../../directory/scanner.js';
import { createCliClient, finishCommands, morseCommand, runMorse, watchEvents } from '../../plugin/cli-client.js';
import { pidAlive } from '../../plugin/lane-lock.js';
import { isRegisteredSession } from '../../registry/external.js';
import { runDispatchCommand } from './commands.js';
import { createDispatcher, isOwnAgentMail, mayResumeLive, type DispatchDeps } from './deliver.js';
import { drainTurns, STOP_DRAIN_MS, WATCH_GONE_DRAIN_MS } from './drain.js';
import { createLaunchReader, DISPATCH_AGENT, type LaunchProfile } from './launch.js';
import { createSelfInboxReader, createSelfInboxRunner, isSelfInboxMail } from './self-inbox.js';
import { createDispatchState } from './state.js';

/**
 * morse-plugin-dispatch — the first official plugin (ADR-052): runs your own agents for
 * your own mail (same-machine session mail, your own devices). The daemon supervises it
 * (`morse plugin list | enable dispatch | disable dispatch`); it talks to the core only
 * through `morse plugin watch --json` and `morse plugin claim | ack | nack | reply`.
 *
 * No arguments (or `run`): the loop the daemon runs. `morse plugin dispatch session …`: the
 * dedicated sessions of launch profiles (ADR-056, commands.ts).
 */

const argv = process.argv.slice(2);
if (argv.length && argv[0] !== 'run') {
  runDispatchCommand(argv).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
} else void startLoop();

async function startLoop(): Promise<void> {
  const stamp = (l: string) => console.log(`[${new Date().toISOString()}] ${l}`);
  // (ADR-089) the daemon reads this plugin's output; when it is killed the pipe is gone while a turn is still
  // being finished here — a log line that cannot be written must never end the plugin
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
  const core = createCliClient({ by: 'plugin:dispatch' });
  const adapters = [createClaudeAdapter(), createCodexAdapter(), createZcodeAdapter(), createKimiAdapter()];
  const notifier = createNotifier({ enabled: process.env['MORSE_NOTIFY'] !== '0' });

  let cache: { at: number; sessions: SessionInfo[] } | null = null;
  const directory = async (): Promise<SessionInfo[]> => {
    if (!cache || Date.now() - cache.at > 30_000) {
      const { sessions } = await listAllSessions([...adapters, createRegisteredAdapter()]);
      cache = { at: Date.now(), sessions };
    }
    return cache.sessions;
  };

  // (ADR-089 review F3) the daemon that supervises this plugin: when it is gone — killed, crashed — nothing more
  // is claimed. Asked before every claim and once a second (`morse plugin watch` does not notice: it reads the
  // mailbox, not the daemon). Only when a daemon started us; run by hand, there is none to watch.
  const daemonPid = Number(process.env['MORSE_DAEMON_PID']) || 0;
  const daemonAlive = (): boolean => !daemonPid || pidAlive(daemonPid);

  const state = createDispatchState();
  const launchProfiles = createLaunchReader({ log: stamp });
  const deps: DispatchDeps = {
    core,
    adapters: new Map(adapters.map((a) => [a.agent, a])),
    directory,
    isMonitored: (sid) => isMonitored(sid),
    isSessionLive: (sid) => isSessionLive(sid),
    isPullOnly: (sid) => sid === 'inbox' || isRegisteredSession(sid),
    // ADR-054: the owner's per-agent launch settings (model, permissions, time limit …)
    launchProfiles,
    // ADR-055 / ADR-056: dedicated sessions, one turn per session
    state,
    log: stamp,
    daemonAlive,
    stopping: () => stopping,
    onEvent: (e) => {
      stamp(`${e.kind} ${e.messageId.slice(0, 8)} @${e.message.from.agent} → @${e.message.to.agent}:${e.message.to.sessionId.slice(0, 8)}${e.detail ? ` — ${e.detail}` : ''}`);
      if (e.kind === 'failed' && e.detail?.startsWith(VERSION_MISMATCH)) notifier.versionMismatch(e.message.to.agent, e.detail);
      // A dedicated session (@dispatch:<name>) is nobody's open window: its replies go back through
      // the channel that asked (WeChat …), so "reopen the session to see it" would only be noise.
      if (e.kind === 'delivered' && e.message.to.agent !== DISPATCH_AGENT) {
        const title = cache?.sessions.find((s) => s.sessionId === e.message.to.sessionId)?.title ?? e.message.to.sessionId.slice(0, 8);
        notifier.sessionActivity(e.message.to.agent, title, e.message.to.sessionId, 'received');
      }
    },
  };

  // ADR-027: ring a running Claude session's own inbox for mail it pulls by itself
  const readClaudeSettings = () => {
    try {
      return JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')) as Parameters<typeof doorbellUseful>[0];
    } catch {
      return null;
    }
  };
  const rung = new Set<string>();
  const ring = async (m: { id: string; to: { agent: string; sessionId: string }; from: { agent: string; sessionId: string } }) => {
    if (m.to.agent !== 'claude' || rung.has(m.id) || !doorbellUseful(readClaudeSettings())) return;
    const inbox = liveClaudeInboxes().get(m.to.sessionId);
    if (!inbox) return;
    // ADR-055: a whenLive "resume" profile runs it headless — the open session must not pull it too
    const s = (await directory().catch(() => [])).find((x) => x.agent === 'claude' && x.sessionId === m.to.sessionId);
    if (mayResumeLive(launchProfiles(), s ?? { agent: 'claude', sessionId: m.to.sessionId, cwd: '' }, (n) => state.dedicated(n)?.sessionId ?? null)) return;
    rung.add(m.id);
    const r = await ringInbox(inbox.socketPath, buildDoorbellFrame({ messageIds: [m.id], fromLabel: `@${m.from.agent}:${m.from.sessionId.slice(0, 8)}` }));
    stamp(`doorbell ${r.ok ? 'rung' : `ring-failed (${r.error ?? '?'})`} @claude:${m.to.sessionId.slice(0, 8)}`);
  };

  const dispatcher = createDispatcher(deps, { concurrency: Number(process.env['MORSE_DISPATCH_CONCURRENCY']) || 4, log: stamp });
  // ADR-061: your own mail to an agent's inbox gets a dedicated session per (my agent, sending agent)
  const selfInbox = createSelfInboxRunner({
    core,
    adapters: deps.adapters,
    state,
    launchProfiles,
    config: createSelfInboxReader({ log: stamp }),
    isSessionLive: (sid) => isSessionLive(sid),
    log: stamp,
    daemonAlive,
  });
  const drain = () => {
    dispatcher.kick();
    selfInbox.kick();
  };

  // ADR-056: each dedicated profile is addressable as @dispatch:<name> (a registration lasts 7 days)
  const morseCmd = morseCommand();
  const registered = new Map<string, string>();
  const registerProfiles = async (force = false) => {
    for (const p of launchProfiles().filter((x: LaunchProfile) => x.dedicated)) {
      const key = `${p.name}\0${p.cwd}`;
      if (!force && registered.get(p.name!) === key) continue;
      const r = await runMorse(['connect', '--agent', DISPATCH_AGENT, '--session', p.name!, '--title', p.name!, '--cwd', p.cwd!], morseCmd);
      if (r.code === 0) registered.set(p.name!, key);
      else stamp(`register @${DISPATCH_AGENT}:${p.name}: ${(r.err || r.out).trim().slice(0, 200)}`);
    }
  };

  // Stopping (SIGTERM from the daemon, Ctrl-C): no new work, the event stream is closed. ADR-089: a turn that
  // is running gets a bounded time to finish and report — a restart that lands in the middle of a turn then
  // costs nothing; a claim no agent was started for is handed back. A turn still running after that keeps
  // its lease (it is tied to the agent CLI's process: nobody takes the message while that runs). Then the
  // `morse` commands in flight finish, and exit.
  // (review F1) A SIGTERM that comes again while this is under way changes nothing: the daemon's shutdown used
  // to signal twice, and systemd signals the whole process group besides the daemon's own signal. Only the
  // deadline below, a SIGKILL, or a second Ctrl-C (a person at the terminal) ends it earlier.
  let stopping = false;
  let closeWatcher = (): void => undefined;
  const timers: NodeJS.Timeout[] = [];
  const wind = async (drainMs: number, code: number): Promise<never> => {
    for (const t of timers) clearInterval(t);
    const left = await drainTurns([dispatcher, selfInbox], drainMs, stamp);
    if (left) stamp(`${left} turn(s) still running — leaving them; their messages stay held until the turn ends`);
    await finishCommands();
    process.exit(code);
  };
  let interrupts = 0;
  const shutdown = (signal: NodeJS.Signals) => {
    if (signal === 'SIGINT' && ++interrupts > 1) process.exit(0);
    if (stopping) return;
    stopping = true;
    closeWatcher();
    void wind(Number(process.env['MORSE_DISPATCH_DRAIN_MS']) || STOP_DRAIN_MS, 0);
  };
  // the daemon is gone and this plugin is not: the turns that are running finish and report first (the mailbox
  // is a file — `morse plugin ack` needs no daemon); nothing new is started, a new daemon has its own plugin
  const daemonGone = (why: string) => {
    if (stopping) return;
    stopping = true;
    stamp(`${why} — stopping; the daemon restarts this plugin`);
    closeWatcher();
    void wind(Number(process.env['MORSE_DISPATCH_WATCH_GONE_DRAIN_MS']) || WATCH_GONE_DRAIN_MS, 1);
  };
  if (daemonPid) {
    const watchDaemon = setInterval(() => {
      if (!daemonAlive()) daemonGone(`the daemon (pid ${daemonPid}) is gone`);
    }, 1000);
    watchDaemon.unref();
    timers.push(watchDaemon);
  }

  const main = async () => {
    const back = await core.recover().catch(() => 0);
    stamp(`morse-plugin-dispatch started — own agents only (session mail here, your own devices)${back ? `; ${back} message(s) held by an earlier run back in line` : ''}`);
    const watcher = watchEvents(
      (e) => {
        if (e.type !== 'message' || e.processed || !isOwnAgentMail(e)) return; // never another person's
        if (isSelfInboxMail(e)) return selfInbox.kick();
        void ring(e);
        drain();
      },
      { onExit: (code) => {
        if (stopping) return; // we closed it
        daemonGone(`morse plugin watch exited (${code})`);
      } },
    );
    closeWatcher = () => void watcher.kill();
    process.on('exit', () => watcher.kill());
    if (stopping) return closeWatcher();
    // retries after a backoff, sessions that stopped being live, anything queued while we were down
    await registerProfiles(true);
    if (stopping) return;
    timers.push(
      setInterval(() => {
        void registerProfiles().then(drain);
      }, Number(process.env['MORSE_DISPATCH_INTERVAL_MS']) || 5000),
    );
    timers.push(setInterval(() => void registerProfiles(true), 6 * 3_600_000));
    drain();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  await main();
}
