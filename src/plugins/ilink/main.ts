#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPlugin } from './bridge.js';
import { finishCommands, morseCommand, runMorse } from '../../plugin/cli-client.js';
import { isInside, readIlinkConfig, type IlinkConfig } from './config.js';
import { createIlink } from './ilink.js';
import { login, readAccount } from './login.js';
import { ILINK_SESSION, SIMULATE_SESSION, createMorseSide } from './morse.js';
import { checkSendPath, extractSendMarkers, sendInstruction } from './outbound.js';
import { createStore, preview, type Store } from './store.js';
import { importBridgeState } from './import.js';

/**
 * morse-plugin-ilink (ADR-053): protocol conversion between WeChat (Tencent's iLink bot
 * API) and Morse. Optional, off by default. Commands:
 *
 *   run                         the loop (what the daemon runs: morse plugin enable ilink)
 *   login [--qr <png>] [--no-wait] [--force]
 *   status [--json]
 *   simulate "<text>" [--timeout <sec>]   a fake inbound text, no WeChat: prints what would go back
 *   import --from <weixin-bridge dir> [--profile <name>] [--force]   reuse an existing binding (no re-scan)
 *                               and continue the bridge's Claude session in the profile's dedicated one
 *   instructions                print the [[send-file]] guidance for the answering agent
 */

const usage = 'usage: morse plugin ilink run | login [--qr <png>] [--no-wait] [--force] | status [--json] | simulate "<text>" [--timeout <sec>] | import --from <dir> [--profile <name>] [--force] | instructions';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const open = (config: IlinkConfig, echo = false): Store => createStore(config.stateDir, echo ? { echo: (l) => console.log(l) } : {});

function pidAlive(pid: number): boolean {
  try {
    return pid > 0 && (process.kill(pid, 0), true);
  } catch {
    return false;
  }
}

function takeLock(store: Store): () => void {
  const file = store.path('run.pid');
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (pid !== process.pid && pidAlive(pid)) throw new Error(`already running (pid ${pid}) — one poller per WeChat binding`);
  }
  store.writeFile('run.pid', `${process.pid}\n`);
  return () => store.remove('run.pid');
}

const accountStamp = (store: Store) => {
  try {
    return String(statSync(store.path('account.json')).mtimeMs);
  } catch {
    return '';
  }
};

async function cmdRun(): Promise<number> {
  const { config, errors } = readIlinkConfig();
  const store = open(config, true);
  for (const e of errors) store.log('config-error', { message: e });
  const unlock = takeLock(store);
  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (stop.signal.aborted) process.exit(1);
      stop.abort();
    });
  }
  const morse = createMorseSide();
  try {
    while (!stop.signal.aborted) {
      const account = readAccount(store);
      const stamp = accountStamp(store);
      if (account) {
        const code = await runPlugin({ ilink: createIlink(), store, morse, account, config, signal: stop.signal, log: store.log });
        if (code !== 2 || stop.signal.aborted) return code;
      } else {
        store.writeJson('status.json', { state: 'not-bound', at: new Date().toISOString(), lastError: 'not bound yet — morse plugin ilink login (or morse plugin ilink import)' });
        store.log('not-bound', {});
      }
      // not bound, or the binding went stale: wait for a new one instead of polling in vain
      while (!stop.signal.aborted && accountStamp(store) === stamp) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, 5_000);
          stop.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
        });
      }
    }
    return 0;
  } finally {
    unlock();
  }
}

async function cmdLogin(args: string[]): Promise<number> {
  const { config } = readIlinkConfig();
  const store = open(config);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  const qr = flag(args, '--qr');
  const r = await login({ api: createIlink(), store, log: store.log, wait: !args.includes('--no-wait'), force: args.includes('--force'), signal: stop.signal, ...(qr ? { qrPath: resolve(qr) } : {}) });
  return ['bound', 'already-bound', 'qr-issued'].includes(r.status) ? 0 : 1;
}

function cmdStatus(args: string[]): number {
  const { config, errors } = readIlinkConfig();
  const store = open(config);
  const account = readAccount(store);
  const st = store.readJson<Record<string, unknown>>('status.json', {});
  const inbox = store.readJson<{ cursor?: string; pending?: unknown[] }>('inbox.json', {});
  const pid = Number(existsSync(store.path('run.pid')) ? readFileSync(store.path('run.pid'), 'utf8') : 0);
  const view = {
    bound: Boolean(account),
    botId: account?.botId ?? null,
    boundAt: account?.boundAt ?? null,
    running: pidAlive(pid) ? pid : null,
    state: st['state'] ?? null,
    lastError: st['lastError'] ?? null,
    lastPollAt: st['lastPollAt'] ?? null,
    cursor: Boolean(inbox.cursor),
    queued: inbox.pending?.length ?? 0,
    identity: `@ilink:${ILINK_SESSION}`,
    target: config.target,
    profile: config.profile,
    agentCwd: config.agentCwd,
    notifyOthers: config.notifyOthers,
    sendRoot: config.sendRoot,
    mediaDir: config.mediaDir,
    stateDir: config.stateDir,
    configErrors: errors,
    warnings: [] as string[],
  };
  // ADR-057: a headless Claude cannot approve reading files outside its working directory
  if (config.agentCwd && !isInside(config.mediaDir, config.agentCwd)) {
    view.warnings.push(`mediaDir ${config.mediaDir} is outside the answering agent's working directory ${config.agentCwd} — a headless Claude cannot read received files there; move it inside (or leave mediaDir unset)`);
  } else if (!config.agentCwd && config.target) {
    view.warnings.push('the answering agent\'s working directory is not in plugins.dispatch.launch — make sure mediaDir is inside it, or received files cannot be read');
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(view, null, 2));
    return 0;
  }
  console.log(`iLink (WeChat): ${view.bound ? `bound${view.boundAt ? ` since ${view.boundAt}` : ''}` : 'not bound — morse plugin ilink login'}${view.running ? `, running (pid ${view.running})` : ', not running'}${view.state ? ` — ${String(view.state)}` : ''}`);
  if (view.lastError) console.log(`  last error: ${String(view.lastError)}`);
  console.log(`  Morse identity: ${view.identity} → target: ${view.target ?? '(not set: plugins.ilink.target)'}${view.profile ? ` (launch profile "${view.profile}", its own session${view.agentCwd ? ` in ${view.agentCwd}` : ''})` : ''}`);
  console.log(`  mail from other addresses: ${view.notifyOthers ? 'a one-line notice (who, how many)' : 'never forwarded'} · files: ${view.sendRoot ?? 'off (plugins.ilink.sendRoot)'} · media: ${view.mediaDir}`);
  console.log(`  queued from WeChat: ${view.queued}${view.lastPollAt ? ` · last poll ${String(view.lastPollAt)}` : ''}`);
  for (const e of errors) console.log(`  config: ${e}`);
  for (const w of view.warnings) console.log(`  warning: ${w}`);
  return 0;
}

async function cmdSimulate(args: string[]): Promise<number> {
  const text = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--timeout').join(' ').trim();
  if (!text) throw new Error('usage: morse plugin ilink simulate "<text>"');
  const { config } = readIlinkConfig();
  if (!config.target) throw new Error('set plugins.ilink.target first (your agent that answers WeChat)');
  const store = open(config);
  const morse = createMorseSide();
  const timeoutMs = (Number(flag(args, '--timeout')) || 300) * 1000;
  await morse.register(SIMULATE_SESSION, 'wechat-simulate');
  try {
    const sent = await morse.send(config.target, text, `@ilink:${SIMULATE_SESSION}`);
    store.log('simulate', { morse: sent.id.slice(0, 8), ...preview(text) });
    console.error(`sent to ${config.target} as @ilink:${SIMULATE_SESSION} (${sent.id}) — waiting for the answer (the dispatch plugin runs the agent)…`);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const { messages } = await morse.todo();
      const reply = messages.find((m) => m.to.agent === 'ilink' && m.to.sessionId === SIMULATE_SESSION && m.contextId === sent.contextId);
      if (reply) {
        const held = await morse.claim(reply.id);
        const { text: body, paths } = extractSendMarkers(reply.text);
        console.log(body || '(no text)');
        for (const p of paths) {
          try {
            const f = checkSendPath(p, { root: config.sendRoot, stateDir: config.stateDir, mediaDir: config.mediaDir, morseDir: config.morseDir, maxBytes: config.maxMediaBytes });
            console.log(`[would send file] ${f.path} (${f.size} bytes)`);
          } catch (e) {
            console.log(`[would refuse file] ${p}: ${(e as { code?: string }).code ?? 'refused'}`);
          }
        }
        if (held) await morse.ack(reply.id);
        return 0;
      }
      const mine = await morse.read(sent.id);
      if (mine?.status === 'dead') {
        console.error(`the agent run failed: ${mine.lastError ?? 'unknown'}`);
        return 1;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.error(`no answer within ${Math.round(timeoutMs / 1000)} s — is the daemon running with the dispatch plugin on (morse plugin list)?`);
    return 1;
  } finally {
    await morse.unregister(SIMULATE_SESSION).catch(() => undefined);
  }
}

async function cmdImport(args: string[]): Promise<number> {
  const from = flag(args, '--from');
  if (!from) throw new Error('usage: morse plugin ilink import --from <weixin-bridge directory> [--profile <name>] [--force]');
  const { config } = readIlinkConfig();
  const store = open(config);
  const profile = flag(args, '--profile') ?? config.profile;
  const r = importBridgeState({ from: resolve(from), store, force: args.includes('--force'), profile });
  for (const line of r.lines) console.log(line);
  if (!r.ok) return 1;
  // ADR-056: the profile's dedicated session continues the bridge's conversation (through the dispatch plugin's command)
  if (profile && r.claudeSession) {
    const seeded = await runMorse(['dispatch', 'session', profile, '--set', r.claudeSession, '--from', 'weixin-bridge', '--json'], morseCommand());
    if (seeded.code === 0) console.log(`@dispatch:${profile} continues the bridge's Claude session ${r.claudeSession} — the conversation goes on`);
    else {
      console.log(`could not seed @dispatch:${profile}: ${(seeded.err || seeded.out).trim().split('\n').pop()}`);
      console.log(`  when the launch profile is in place: morse plugin dispatch session ${profile} --set ${r.claudeSession}`);
      return 1;
    }
  }
  console.log(`next: ${config.target ? '' : 'set plugins.ilink (target, profile …) in ~/.morse/config.json, then '}morse plugin enable ilink`);
  return 0;
}

function cmdInstructions(): number {
  const { config } = readIlinkConfig();
  if (!config.sendRoot) {
    console.error('plugins.ilink.sendRoot is not set: files cannot be sent back, nothing to tell the agent');
    return 1;
  }
  console.log(sendInstruction({ root: config.sendRoot }));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'run') return cmdRun();
  if (command === 'login') return cmdLogin(rest);
  if (command === 'status') return cmdStatus(rest);
  if (command === 'simulate') return cmdSimulate(rest);
  if (command === 'import') return await cmdImport(rest);
  if (command === 'instructions') return cmdInstructions();
  console.error(usage);
  return 64;
}

main(process.argv.slice(2)).then(
  // no `morse` command of ours outlives us (nothing is in flight after a one-shot command)
  (code) => finishCommands().then(() => process.exit(code)),
  (e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const { config } = readIlinkConfig();
      createStore(config.stateDir).log('error', { message: String((e as Error)?.message ?? e).slice(0, 300) });
    } catch {
      /* best effort */
    }
    process.exit(1);
  },
);

