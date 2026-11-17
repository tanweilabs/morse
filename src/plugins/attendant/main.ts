#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * morse-plugin-attendant (ADR-059 / ADR-060 / ADR-066): when a contact who is not you writes
 * to one of your agents, your agent reads it in a session of its own per contact and
 * decides whether to reply — with their group's (or their own) profile under
 * `plugins.attendant` (its directory and tools; destructive or outward-facing actions wait
 * for your approval), or else the conversation-only default (no tools). Built in, on by
 * default: `morse plugin disable attendant` turns it off. It talks to the core only
 * through `morse plugin watch --json` and `morse message [<who>] | reply | done | send`.
 *
 *   run                 the loop the daemon runs (also: no arguments)
 *   status | approvals | approve <id> | reject <id>      see commands.ts
 *   hook pretool --run <id>                              Claude's PreToolUse hook
 */

const argv = process.argv.slice(2);
if (argv.length && argv[0] !== 'run') {
  // commands (and the hook) load only what they need — the hook runs before every tool call
  import('./commands.js')
    .then(({ runAttendantCommand }) => runAttendantCommand(argv))
    .then(
      (code) => process.exit(code),
      (e: unknown) => {
        console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      },
    );
} else void startLoop();

async function startLoop(): Promise<void> {
  const { realExec } = await import('../../adapters/exec.js');
  const { postNotification } = await import('../../daemon/notify.js');
  const { dataDir } = await import('../../home.js');
  const { finishCommands, watchEvents } = await import('../../plugin/cli-client.js');
  const { createApprovalStore } = await import('./approvals.js');
  const { readAttendantConfig } = await import('./config.js');
  const { createCliCore } = await import('./core.js');
  const { createEngine } = await import('./engine.js');
  const { attendantStateDir, createAttendantState } = await import('./state.js');

  const stamp = (l: string) => console.log(`[${new Date().toISOString()}] ${l}`);
  const stateDir = attendantStateDir();
  // the settings, re-read when config.json changes; errors logged once per change
  let cache: { text: string; value: ReturnType<typeof readAttendantConfig> } | null = null;
  const configFile = join(dataDir(), 'config.json');
  const current = () => {
    let text = '';
    try {
      text = readFileSync(configFile, 'utf8');
    } catch {
      /* none */
    }
    if (!cache || cache.text !== text) {
      cache = { text, value: readAttendantConfig() };
      const s = cache.value.settings;
      for (const e of s.errors) stamp(`config: ${e}`);
      stamp(`profiles: ${[...Object.keys(s.groups).map((g) => `group ${g}`), ...Object.entries(s.contacts).filter(([, p]) => p).map(([c]) => `contact ${c}`)].join(', ') || 'none'}; other accepted contacts: ${s.defaultProfile ? `conversation only (no tools, ${s.defaultProfile.launch.model ?? 'default model'})` : 'stored only'}`);
    }
    return cache.value;
  };

  const core = createCliCore();
  const engine = createEngine({
    core,
    exec: realExec,
    state: createAttendantState(stateDir),
    approvals: createApprovalStore(stateDir),
    settings: () => current().settings,
    ilinkEnabled: () => current().ilinkEnabled,
    pluginArgv: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)],
    stateDir,
    home: homedir(),
    // where the core keeps received files (cluster/morse.ts inboxFilesDir)
    inboxFilesDir: join(dataDir(), 'inbox-files'),
    log: stamp,
    osNotify: (title, body) => {
      if (process.env['MORSE_NOTIFY'] !== '0') postNotification(title, body);
    },
  });

  await core.register().catch((e: Error) => stamp(`register @attendant:approvals: ${e.message}`));
  engine.recover();
  stamp('morse-plugin-attendant started — contacts get their profile, or the conversation-only default; requests and blocked contacts are never answered');
  const watcher = watchEvents(
    (e) => {
      if (e.type === 'message' && e.direction === 'in' && !e.processed) engine.kick();
    },
    {
      onExit: (code) => {
        if (stopping) return; // we closed it
        stamp(`morse plugin watch exited (${code}) — stopping; the daemon restarts this plugin`);
        process.exit(1);
      },
    },
  );
  process.on('exit', () => watcher.kill());
  // Stopping (SIGTERM from the daemon, Ctrl-C): no new work, the event stream is closed, the
  // `morse` commands in flight finish — then exit. A second signal exits at once.
  let stopping = false;
  const shutdown = () => {
    if (stopping) process.exit(0);
    stopping = true;
    clearInterval(timer);
    watcher.kill();
    void finishCommands().then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // approvals decided in a terminal, retries after a backoff, anything that arrived while we were down
  const timer = setInterval(() => engine.kick(), Number(process.env['MORSE_ATTENDANT_INTERVAL_MS']) || 3000);
  engine.kick();
}
