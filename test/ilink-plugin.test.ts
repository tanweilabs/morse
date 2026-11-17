import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stopProcess } from './helpers/stop-process.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, GAVE_UP_INTERRUPTED, type Mailbox } from '../src/mailbox/mailbox.js';
import { viewOf } from '../src/plugin/local-client.js';
import { runPlugin, TEXT } from '../src/plugins/ilink/bridge.js';
import { readIlinkConfig, type IlinkConfig } from '../src/plugins/ilink/config.js';
import { createIlink } from '../src/plugins/ilink/ilink.js';
import { importBridgeState } from '../src/plugins/ilink/import.js';
import type { Account } from '../src/plugins/ilink/login.js';
import { createMorseSide, ILINK_SESSION, type MorseSide } from '../src/plugins/ilink/morse.js';
import { createStore, type Store } from '../src/plugins/ilink/store.js';
import { OWNER, startFakeIlink, TOKEN, wxText, type FakeIlink } from './helpers/fake-ilink.js';

/**
 * ADR-053: morse-plugin-ilink — WeChat (the owner himself) <-> Morse. Everything runs
 * against a fake iLink server and a temporary HOME; the real iLink servers, ~/.morse and
 * ~/.claude are never touched.
 */

const repo = resolve(__dirname, '..');
const TSX = join(repo, 'node_modules/tsx/dist/loader.mjs');
const MORSE_CMD = [process.execPath, '--import', TSX, join(repo, 'src/cli.ts')];
const SID = 'cccc2222-0000-4000-8000-00000000000c';
const homes: string[] = [];
const children: ChildProcess[] = [];
afterAll(async () => {
  // wait until they are gone: a process still running would write into the homes removed next
  await Promise.all(children.map((c) => stopProcess(c, { signal: 'SIGKILL' })));
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 30_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A port nobody listens on, so `morse send` never reaches a real daemon. */
const closedPort = () =>
  new Promise<number>((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

interface Home {
  home: string;
  work: string;
  env: NodeJS.ProcessEnv;
  open: () => Mailbox;
  config: (extra?: Record<string, unknown>) => IlinkConfig;
  store: () => Store;
}

async function newHome(ilink: Record<string, unknown> = {}, dispatchLaunch?: unknown[]): Promise<Home> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'morse-ilink-')));
  homes.push(home);
  const work = join(home, 'work');
  mkdirSync(join(home, '.morse'), { recursive: true });
  mkdirSync(work, { recursive: true });
  const port = await closedPort();
  const write = (extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(home, '.morse', 'config.json'),
      JSON.stringify({
        relay: { handle: 'me', agent: 'mini' },
        plugins: { ilink: { target: `@claude:${SID}`, sendRoot: work, mediaDir: join(work, 'wechat-media'), port, ...ilink, ...extra }, ...(dispatchLaunch ? { dispatch: { launch: dispatchLaunch } } : {}) },
      }),
    );
  write();
  // a Claude session of the owner's (in this temp HOME only)
  const proj = join(home, '.claude', 'projects', '-work');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${SID}.jsonl`), `${JSON.stringify({ type: 'user', cwd: work, message: { content: 'wechat' } })}\n`);
  const env = { ...process.env, HOME: home, MORSE_HOME: home, MORSE_NOTIFY: '0', MORSE_CMD_JSON: JSON.stringify(MORSE_CMD) };
  const open = () => {
    const ctx = homeContactContext(home);
    return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
  };
  const config = (extra?: Record<string, unknown>) => {
    if (extra) write(extra);
    const { config: c, errors } = readIlinkConfig(env);
    expect(errors).toEqual([]);
    return c;
  };
  return { home, work, env, open, config, store: () => createStore(config().stateDir) };
}

const account = (): Account => ({ token: TOKEN, botId: 'bot-1', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: OWNER, allowedSender: OWNER, boundAt: 'x' });

/** The Morse side over the CLI, with this HOME. */
const morseFor = (h: Home, cfg: IlinkConfig): MorseSide => createMorseSide({ cmd: MORSE_CMD, port: cfg.port, env: h.env });

function start(h: Home, fake: FakeIlink, cfg: IlinkConfig, opts: { watch?: boolean } = {}) {
  const ctrl = new AbortController();
  const store = createStore(cfg.stateDir);
  const done = runPlugin({ ilink: createIlink({ fetchImpl: fake.fetchImpl }), store, morse: morseFor(h, cfg), account: account(), config: cfg, signal: ctrl.signal, log: store.log, fetchImpl: fake.fetchImpl, sweepIntervalMs: 300, watch: opts.watch ?? false });
  return { ctrl, store, done, stop: async () => (ctrl.abort(), done) };
}

/** Acts as the owner's agent: answers every new message to the target session (as the dispatch plugin would). */
function fakeAgent(mb: Mailbox, answer: (text: string) => string) {
  const seen = new Set<string>();
  const t = setInterval(() => {
    for (const m of mb.todo()) {
      if (m.to.sessionId !== SID || seen.has(m.id)) continue;
      seen.add(m.id);
      mb.markProcessed([m.id], 'test-agent');
      mb.reply(m.id, answer(m.parts.map((p) => p.text).join('\n')), 'auto');
    }
  }, 100);
  return { stop: () => clearInterval(t), seen };
}

describe('iLink plugin: WeChat <-> Morse (ADR-053)', () => {
  it('a WeChat text from the bound user becomes Morse mail from you to the target; the answer goes back with that context token, chunked; strangers are ignored', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const cfg = h.config();
    const mb = h.open();
    const agent = fakeAgent(mb, (t) => `答：${t}\n${'长'.repeat(2000)}`);
    const run = start(h, fake, cfg);
    try {
      fake.push(wxText('你好', { context: 'ctx-A' }), wxText('I am a stranger', { from: 'stranger@im.wechat' }));
      await until(() => fake.sent.length >= 2, 30_000, 'the answer in WeChat');
      const toAgent = mb.inbox({ all: true }).filter((m) => m.to.sessionId === SID);
      expect(toAgent.map((m) => m.parts[0]!.text)).toEqual(['你好']); // the stranger never reached Morse
      const inbound = viewOf(mb, toAgent[0]!);
      expect(inbound).toMatchObject({ direction: 'internal', foreign: false, from: { agent: 'ilink', sessionId: ILINK_SESSION }, to: { agent: 'claude', sessionId: SID }, contact: { id: 'self', group: 'self', self: true } });
      expect(fake.sent.map((s) => [s.to, s.contextToken, s.text!.length])).toEqual([
        [OWNER, 'ctx-A', expect.any(Number)],
        [OWNER, 'ctx-A', expect.any(Number)],
      ]);
      expect(fake.sent[0]!.text).toMatch(/^答：你好/);
      expect(fake.sent.every((s) => s.text!.length <= 1800)).toBe(true);
      expect(fake.calls).toContain('sendtyping');
      // the answer is processed by the plugin, and only WeChat hosts were ever contacted
      const answer = mb.inbox({ all: true }).find((m) => m.to.agent === 'ilink')!;
      await until(() => mb.getMessage(answer.id)?.processedBy === 'plugin:ilink', 10_000, 'ack');
      expect([...fake.hosts].sort()).toEqual(['ilinkai.weixin.qq.com']);
      const log = readFileSync(join(cfg.stateDir, 'ilink.log'), 'utf8');
      expect(log).not.toContain(TOKEN);
      expect(log).not.toContain('长长长长长长长长长长长长长长长长长长长长长');
      expect(statSync(join(cfg.stateDir, 'morse.json')).mode & 0o777).toBe(0o600);
    } finally {
      agent.stop();
      await run.stop();
      await fake.close();
    }
  }, 60_000);

  it('other people\'s Morse mail is never forwarded — not even when it is addressed to the plugin; notify_others sends one line (who, how many), never the content', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const mb = h.open();
    const fromBob = (text: string) => mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'ilink', sessionId: 'inbox' }, text, fromTier: 'peer' });
    const a = fromBob('SECRET-CONTENT-1');
    mb.contacts.set('c:bob', { remark: 'Bob', group: 'self' }); // labelled self by the owner: still not the owner
    // and one of your own agents writing to the plugin: forwarded, with who wrote it
    const mine = mb.send({ from: { agent: 'codex', sessionId: 'c-1' }, to: { agent: 'ilink', sessionId: ILINK_SESSION }, text: 'build finished' });
    // and something sent from the command line with no --from: forwarded with no "[@user]" label
    const byHand = mb.send({ from: { agent: 'user', sessionId: 'cli' }, to: { agent: 'ilink', sessionId: ILINK_SESSION }, text: 'note from the command line' });
    let run = start(h, fake, h.config());
    try {
      fake.push(wxText('hi', { context: 'ctx-B' })); // gives the plugin a context token
      await until(() => fake.sent.some((s) => s.text?.includes('build finished')), 30_000, 'own agent mail');
      expect(fake.sent.find((s) => s.text?.includes('build finished'))!.text).toBe('[@codex] build finished');
      await until(() => fake.sent.some((s) => s.text?.includes('note from the command line')), 30_000, 'command-line mail');
      expect(fake.sent.find((s) => s.text?.includes('note from the command line'))!.text).toBe('note from the command line');
      await until(() => mb.getMessage(byHand.id)?.processedBy === 'plugin:ilink', 30_000, 'command-line mail marked processed');
      await new Promise((r) => setTimeout(r, 1500));
      expect(fake.sent.some((s) => s.text?.includes('SECRET'))).toBe(false);
      expect(mb.getMessage(a.id)?.processedAt).toBeUndefined(); // left for the owner in morse inbox
      expect(mb.getMessage(mine.id)?.processedBy).toBe('plugin:ilink');
      await run.stop();

      const cfg = h.config({ notify_others: true });
      fromBob('SECRET-CONTENT-2');
      run = start(h, fake, cfg);
      await until(() => fake.sent.some((s) => s.text?.startsWith('Morse：')), 30_000, 'the notice');
      await new Promise((r) => setTimeout(r, 1200));
      const notices = fake.sent.filter((s) => s.text?.startsWith('Morse：'));
      expect(notices.map((n) => n.text)).toEqual(['Morse：Bob 给你发来 2 条消息（内容只在 Morse 里，用 morse read 查看）。']);
      expect(fake.sent.some((s) => s.text?.includes('SECRET'))).toBe(false);
      expect(mb.todo().filter((m) => m.contactId === 'c:bob')).toHaveLength(2);
    } finally {
      await run.stop();
      await fake.close();
    }
  }, 60_000);

  it('restart: nothing queued is lost or replayed — Morse mail that came while it was down goes out once; one held mid-send is handed back, a half-sent one is never sent twice', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const cfg = h.config();
    const mb = h.open();
    const store = createStore(cfg.stateDir);
    const own = (text: string) => mb.send({ from: { agent: 'codex', sessionId: 'c-1' }, to: { agent: 'ilink', sessionId: ILINK_SESSION }, text });
    const queued = own('queued while down');
    const held = own('held, nothing sent yet');
    const half = own('held, half sent');
    // a crashed earlier run: both claimed, one with 1 of 2 parts already in WeChat
    expect(mb.claimById(held.id)).not.toBeNull();
    expect(mb.claimById(half.id)).not.toBeNull();
    store.writeJson('morse.json', { lastContextToken: 'ctx-old', holding: { [held.id]: { claimed: true, sent: 0, total: 1 }, [half.id]: { claimed: true, sent: 1, total: 2 } } });
    // and WeChat messages accepted before the crash, one of them mid-flight
    store.writeJson('inbox.json', { cursor: 'cursor-7', active: '900', seen: ['900', '901'], pending: [{ id: '900', from: OWNER, text: 'was mid-flight', contextToken: 'c900' }, { id: '901', from: OWNER, text: 'still queued', contextToken: 'c901' }] });
    const run = start(h, fake, cfg);
    try {
      await until(() => fake.sent.some((s) => s.text === '[@codex] held, nothing sent yet') && fake.sent.some((s) => s.text === '[@codex] queued while down'), 30_000, 'delivery after restart');
      await until(() => mb.inbox({ all: true }).some((m) => m.to.sessionId === SID), 10_000, 'the queued WeChat message');
      await new Promise((r) => setTimeout(r, 1500));
      const texts = fake.sent.map((s) => s.text);
      expect(texts.filter((t) => t === '[@codex] queued while down')).toHaveLength(1);
      expect(texts.filter((t) => t === '[@codex] held, nothing sent yet')).toHaveLength(1);
      expect(texts.some((t) => t?.includes('half sent'))).toBe(false);
      expect(texts).toContain('上一条消息处理到一半时程序中断了，请重发一遍。');
      expect(mb.getMessage(half.id)).toMatchObject({ status: 'dead' });
      expect(mb.getMessage(half.id)?.lastError).toMatch(/interrupted after 1 of 2/);
      expect(mb.getMessage(queued.id)?.processedBy).toBe('plugin:ilink');
      // the mid-flight WeChat message is not forwarded; the queued one is, once; the cursor was kept
      expect(mb.inbox({ all: true }).filter((m) => m.to.sessionId === SID).map((m) => m.parts[0]!.text)).toEqual(['still queued']);
      expect(fake.calls.includes('getupdates')).toBe(true);
    } finally {
      await run.stop();
      await fake.close();
    }
  }, 60_000);

  it('a WeChat send that fails is reported back into Morse (retried, then dead with the reason) — never dropped silently', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const cfg = h.config();
    const mb = h.open();
    const m = mb.send({ from: { agent: 'codex', sessionId: 'c-1' }, to: { agent: 'ilink', sessionId: ILINK_SESSION }, text: 'nightly report' });
    fake.mode.failSend = 99;
    const run = start(h, fake, cfg);
    try {
      await until(() => mb.getMessage(m.id)?.status === 'failed', 30_000, 'nack');
      expect(mb.getMessage(m.id)).toMatchObject({ attempts: 1 });
      expect(mb.getMessage(m.id)?.lastError).toMatch(/WeChat send failed \(rejected -2\).*reply window/);
      expect(mb.getMessage(m.id)?.processedAt).toBeUndefined();
    } finally {
      await run.stop();
      await fake.close();
    }
  }, 60_000);

  it('when the target session is gone (moved to its agent mailbox) or the run died, the WeChat user is told', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const mb = h.open();
    const t = setInterval(() => {
      for (const m of mb.todo()) {
        if (m.to.sessionId !== SID || m.status !== 'pending' || !mb.claimById(m.id)) continue;
        if (m.parts[0]!.text === 'gone') mb.toMailbox(m.id, 'target session not found');
        // (ADR-089) what the core writes when it gives a message up after three interrupted turns
        else if (m.parts[0]!.text === 'cut') mb.markFailed(m.id, GAVE_UP_INTERRUPTED, { terminal: true });
        else mb.markFailed(m.id, 'claude did not finish within 600 s', { terminal: true });
      }
    }, 100);
    const run = start(h, fake, h.config());
    try {
      fake.push(wxText('gone', { context: 'ctx-g' }), wxText('slow', { context: 'ctx-s' }), wxText('cut', { context: 'ctx-c' }));
      await until(() => fake.sent.length >= 3, 40_000, 'the three notices');
      expect(fake.sent.map((s) => [s.contextToken, s.text])).toEqual(
        expect.arrayContaining([
          ['ctx-g', '回答微信消息的那个 agent 会话不在了，消息放进了它的 Morse 信箱；请检查 plugins.ilink.target。'],
          ['ctx-s', '处理超时了，请稍后再试。'],
          // a message given up after interrupted turns is not silently dead: the user is told, and that part may be done
          ['ctx-c', TEXT.gaveUp],
        ]),
      );
    } finally {
      clearInterval(t);
      await run.stop();
      await fake.close();
    }
  }, 60_000);

  it('a stale token stops polling and claiming: the run ends with 2, status says to bind again, Morse mail waits', async () => {
    const fake = await startFakeIlink();
    const h = await newHome();
    const cfg = h.config();
    const mb = h.open();
    fake.mode.stale = true;
    const m = mb.send({ from: { agent: 'codex', sessionId: 'c-1' }, to: { agent: 'ilink', sessionId: ILINK_SESSION }, text: 'waits' });
    const run = start(h, fake, cfg);
    expect(await run.done).toBe(2);
    const st = JSON.parse(readFileSync(join(cfg.stateDir, 'status.json'), 'utf8'));
    expect(st).toMatchObject({ state: 'stale-token' });
    expect(st.lastError).toMatch(/login --force/);
    const polls = fake.calls.filter((c) => c === 'getupdates').length;
    await new Promise((r) => setTimeout(r, 800));
    expect(fake.calls.filter((c) => c === 'getupdates').length).toBe(polls);
    expect(mb.getMessage(m.id)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(fake.sent).toEqual([]);
    await fake.close();
  }, 30_000);

  it('import: copies an existing weixin-bridge binding (account + cursor) 0600 without printing it; refuses while the bridge runs', async () => {
    const h = await newHome();
    const bridge = join(h.home, 'fake-bridge');
    mkdirSync(join(bridge, 'state'), { recursive: true });
    writeFileSync(join(bridge, 'state', 'account.json'), JSON.stringify({ token: TOKEN, botId: 'b1', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: OWNER, allowedSender: OWNER, boundAt: '2026-11-09' }));
    writeFileSync(join(bridge, 'state', 'inbox.json'), JSON.stringify({ cursor: 'CURSOR-42', pending: [{ id: '1', from: OWNER, text: 'a' }, { id: '2', from: OWNER, text: 'b' }], active: '1', seen: ['1', '2'] }));
    writeFileSync(join(bridge, 'state', 'session.json'), JSON.stringify({ claude: { sessionId: SID } }));
    writeFileSync(join(bridge, 'state', 'run.pid'), `${process.pid}\n`);
    const store = h.store();
    const refused = importBridgeState({ from: bridge, store });
    expect(refused.ok).toBe(false);
    expect(refused.lines.join('\n')).toMatch(/still running/);
    expect(existsSync(store.path('account.json'))).toBe(false);
    rmSync(join(bridge, 'state', 'run.pid'));
    const r = importBridgeState({ from: bridge, store });
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).not.toContain(TOKEN);
    expect(r.lines.join('\n')).toContain(`@claude:${SID}`);
    expect(JSON.parse(readFileSync(store.path('account.json'), 'utf8'))).toMatchObject({ token: TOKEN, allowedSender: OWNER });
    expect(JSON.parse(readFileSync(store.path('inbox.json'), 'utf8'))).toMatchObject({ cursor: 'CURSOR-42', pending: [{ id: '2' }], active: null });
    for (const f of ['account.json', 'inbox.json']) expect(statSync(store.path(f)).mode & 0o777).toBe(0o600);
    expect(importBridgeState({ from: bridge, store }).ok).toBe(false); // already bound: needs --force
    // an account pointing anywhere but WeChat is refused
    writeFileSync(join(bridge, 'state', 'account.json'), JSON.stringify({ token: TOKEN, baseUrl: 'https://evil.example.com', allowedSender: OWNER }));
    expect(importBridgeState({ from: bridge, store, force: true }).ok).toBe(false);
  });

  it('only imports the plugin interface — never the mailbox, the daemon or other core internals', () => {
    const dir = join(repo, 'src/plugins/ilink');
    const allowed = /^(\.\/|\.\.\/\.\.\/plugin\/(contract|cli-client)\.js$)/;
    for (const f of readdirSync(dir)) {
      for (const [, spec] of readFileSync(join(dir, f), 'utf8').matchAll(/from '([^']+)'/g)) {
        if (spec!.startsWith('node:')) continue;
        expect(spec, `${f} imports ${spec}`).toMatch(allowed);
      }
    }
  });
});

describe('iLink plugin end to end: fake WeChat → Morse → dispatch plugin (fake claude, run.sh settings) → WeChat', () => {
  it('text, an attachment in, [[send-file]] out with the path rules; the agent launched with the configured model / permissions; simulate and status', async () => {
    const fake = await startFakeIlink();
    const PROFILE = { agent: 'claude', session: SID, from: 'ilink', prompt: 'plain', permissionMode: 'acceptEdits', allowedTools: ['mcp__1board'], model: 'claude-fable-5-2', effort: 'high', timeoutSec: 600, appendSystemPrompt: 'files: [[send-file: /abs]]' };
    const h = await newHome({}, [PROFILE]);
    const cfg = h.config();
    // a fake `claude` on PATH: records its argv, answers; asked for a file it names one inside and one outside the root
    const bin = join(h.home, 'bin');
    mkdirSync(bin);
    const pic = join(h.work, 'chart.png');
    writeFileSync(pic, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]));
    writeFileSync(join(h.home, 'secret.txt'), 'outside');
    writeFileSync(
      join(bin, 'claude'),
      `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(join(h.home, 'claude-calls.jsonl'))}, JSON.stringify(a) + '\\n');
const prompt = a[a.length - 1];
if (/send me the chart/.test(prompt)) console.log('here it is\\n[[send-file: ${pic}]]\\n[[send-file: ${join(h.home, 'secret.txt')}]]');
else console.log('got: ' + prompt.split('\\n\\n').slice(1).join(' | '));
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    // (ADR-088 §4) MORSE_ADDRESS in the plugins' environment — the daemon was started from a shell that exports it (and,
    // worst case, handed it on): it selects an address for ONE session and must change nothing here. Were it read by
    // a command the plugins run, `morse message --json` would list another address's mail only (here: fail, it names
    // none) and the answer would never reach WeChat.
    const env = { ...h.env, PATH: `${bin}:${process.env['PATH']}`, MORSE_DISPATCH_INTERVAL_MS: '300', MORSE_ADDRESS: 'work' };
    const dispatch = spawn(process.execPath, ['--import', TSX, join(repo, 'src/plugins/dispatch/main.ts')], { env });
    children.push(dispatch);
    let dlog = '';
    dispatch.stdout.on('data', (d) => (dlog += String(d)));
    dispatch.stderr.on('data', (d) => (dlog += String(d)));
    const run = start({ ...h, env }, fake, cfg, { watch: true });
    try {
      // 1. text
      fake.push(wxText('今天有什么待办', { context: 'ctx-1' }));
      await until(() => fake.sent.some((s) => s.text?.startsWith('got:')), 45_000, `the agent's answer\n${dlog}`);
      expect(fake.sent.find((s) => s.text?.startsWith('got:'))).toMatchObject({ to: OWNER, contextToken: 'ctx-1', text: 'got: 今天有什么待办' });
      const call = JSON.parse(readFileSync(join(h.home, 'claude-calls.jsonl'), 'utf8').trim().split('\n')[0]!) as string[];
      expect(call.slice(0, 12)).toEqual(['-p', '--model', 'claude-fable-5-2', '--effort', 'high', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__1board', '--append-system-prompt', 'files: [[send-file: /abs]]', '--system-prompt-snapshot']);
      expect(call.slice(13, 16)).toEqual(['--resume', SID, '--']);
      expect(call.at(-1)).toMatch(/^\[Morse\] This is your owner writing to you in person through @ilink:wechat/);
      expect(call.join(' ')).not.toMatch(/dangerously|bypass/);

      // 2. an image in: saved 0600 in mediaDir, its absolute path in the Morse message
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);
      const media = fake.media(png);
      fake.push({ message_id: 7777, seq: 7777, from_user_id: OWNER, context_token: 'ctx-2', item_list: [{ type: 2, image_item: { media } }, { type: 1, text_item: { text: '看看这张' } }] });
      await until(() => fake.sent.some((s) => s.contextToken === 'ctx-2' && s.text?.startsWith('got:')), 45_000, 'the image answer');
      const saved = join(cfg.mediaDir, readdirSync(cfg.mediaDir)[0]!, '7777-image.png');
      expect(readFileSync(saved)).toEqual(png);
      expect(statSync(saved).mode & 0o777).toBe(0o600);
      expect(fake.sent.find((s) => s.contextToken === 'ctx-2' && s.text?.startsWith('got:'))!.text).toContain(saved);

      // 3. [[send-file]] out: the one inside the root goes as an image message, the one outside is refused with a line
      fake.push(wxText('send me the chart', { context: 'ctx-3' }));
      await until(() => fake.sent.some((s) => s.contextToken === 'ctx-3' && s.text?.includes('secret.txt')), 45_000, 'the file reply');
      const ctx3 = fake.sent.filter((s) => s.contextToken === 'ctx-3');
      expect(ctx3[0]!.text).toBe('here it is');
      expect(ctx3.some((s) => (s.item as { type: number }).type === 2)).toBe(true);
      expect(ctx3.find((s) => s.text?.includes('secret.txt'))!.text).toBe('文件「secret.txt」没发出去：不在允许发送的目录内。');
      expect(fake.uploads).toHaveLength(1);

      // 4. status and simulate through the plugin's own command line (morse ilink …)
      const cli = (...args: string[]) =>
        new Promise<{ code: number | null; out: string; err: string }>((done) => {
          const p = spawn(MORSE_CMD[0]!, [...MORSE_CMD.slice(1), 'ilink', ...args], { env });
          let out = '';
          let err = '';
          p.stdout.on('data', (d) => (out += String(d)));
          p.stderr.on('data', (d) => (err += String(d)));
          p.on('close', (code) => done({ code, out, err }));
        });
      const st = await cli('status', '--json');
      expect(JSON.parse(st.out)).toMatchObject({ identity: '@ilink:ilink-wechat', target: `@claude:${SID}`, notifyOthers: false, state: 'running', bound: false });
      const before = fake.sent.length;
      const sim = await cli('simulate', 'send me the chart', '--timeout', '40');
      expect(sim.code, sim.err).toBe(0);
      expect(sim.out).toContain('here it is');
      expect(sim.out).toContain(`[would send file] ${pic}`);
      expect(sim.out).toMatch(/\[would refuse file\] .*secret\.txt: outside-root/);
      expect(fake.sent.length).toBe(before); // nothing went to WeChat
    } finally {
      await run.stop();
      await stopProcess(dispatch);
      await fake.close();
    }
  }, 180_000);
});

describe('cutover parity with weixin-bridge (ADR-055..057): a dedicated session, whenLive, media inside the agent directory, one quick failure', () => {
  it('import seeds the dedicated session; answered while live (resume) and held (wait); one turn at a time; recreated when gone; media default; a failure told exactly once', async () => {
    const fake = await startFakeIlink();
    const BRIDGE_SID = 'bbbb3333-0000-4000-8000-00000000000b';
    const NOTICE = '（之前的会话找不到了，已新开一个会话，之前的上下文没有了。）';
    const h = await newHome({ target: '@claude', profile: 'wechat', mediaDir: undefined });
    const profile = (whenLive: string) => ({ agent: 'claude', name: 'wechat', dedicated: true, cwd: h.work, from: 'ilink', prompt: 'plain', whenLive, permissionMode: 'acceptEdits', allowedTools: ['mcp__1board'], model: 'claude-fable-5-2', effort: 'high', timeoutSec: 600, resetNotice: NOTICE });
    const cfgFile = join(h.home, '.morse', 'config.json');
    const writeLaunch = (whenLive: string, ilinkExtra: Record<string, unknown> = {}) => {
      const all = JSON.parse(readFileSync(cfgFile, 'utf8'));
      all.plugins.dispatch = { launch: [profile(whenLive)] };
      all.plugins.ilink = { ...all.plugins.ilink, ...ilinkExtra };
      writeFileSync(cfgFile, JSON.stringify(all));
    };
    writeLaunch('resume');
    const cfg = h.config();
    expect(cfg).toMatchObject({ target: '@dispatch:wechat', profile: 'wechat', agentCwd: h.work, mediaDir: join(h.work, 'wechat-media') });

    // a fake `claude`: knows which sessions exist (like the CLI), records each turn with its time
    const bin = join(h.home, 'bin');
    mkdirSync(bin);
    const known = join(h.home, 'known.txt');
    writeFileSync(known, `${BRIDGE_SID}\n`);
    const calls = join(h.home, 'claude-calls.jsonl');
    writeFileSync(
      join(bin, 'claude'),
      `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const known = fs.readFileSync(${JSON.stringify(known)}, 'utf8').split('\\n').filter(Boolean);
const prompt = a[a.length - 1];
const start = Date.now();
const r = a.indexOf('--resume');
if (r >= 0 && !known.includes(a[r + 1])) { console.error('No conversation found with session ID: ' + a[r + 1]); process.exit(1); }
const c = a.indexOf('--session-id');
if (c >= 0) fs.appendFileSync(${JSON.stringify(known)}, a[c + 1] + '\\n');
if (/slow/.test(prompt)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, cwd: process.cwd(), start, end: Date.now() }) + '\\n');
if (/please fail/.test(prompt)) { console.error('boom'); process.exit(1); }
console.log('got: ' + prompt.split('\\n\\n').slice(1).join(' | '));
`,
    );
    chmodSync(join(bin, 'claude'), 0o755);
    const env = { ...h.env, PATH: `${bin}:${process.env['PATH']}`, MORSE_DISPATCH_INTERVAL_MS: '300' };
    const cli = (...args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const p = spawn(MORSE_CMD[0]!, [...MORSE_CMD.slice(1), ...args], { env });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += String(d)));
        p.stderr.on('data', (d) => (err += String(d)));
        p.on('close', (code) => done({ code, out, err }));
      });
    const turns = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; cwd: string; start: number; end: number }) : []);
    const dedicated = () => JSON.parse(readFileSync(join(h.home, '.morse', 'plugins', 'dispatch', 'state.json'), 'utf8')).dedicated.wechat as { sessionId: string; cwd: string };
    const answer = (ctx: string) => fake.sent.filter((s) => s.contextToken === ctx && s.text);

    // 1. the bridge's binding and its Claude session carry over: the conversation goes on
    const bridge = join(h.home, 'fake-bridge');
    mkdirSync(join(bridge, 'state'), { recursive: true });
    writeFileSync(join(bridge, 'state', 'account.json'), JSON.stringify({ token: TOKEN, botId: 'b1', baseUrl: 'https://ilinkai.weixin.qq.com/', ownerUserId: OWNER, allowedSender: OWNER }));
    writeFileSync(join(bridge, 'state', 'session.json'), JSON.stringify({ claude: { sessionId: BRIDGE_SID } }));
    const imp = await cli('ilink', 'import', '--from', bridge);
    expect(imp.code, imp.err + imp.out).toBe(0);
    expect(imp.out).toContain(`@dispatch:wechat continues the bridge's Claude session ${BRIDGE_SID}`);
    expect(imp.out).not.toContain(TOKEN);
    expect(dedicated()).toMatchObject({ sessionId: BRIDGE_SID, cwd: h.work });
    expect(statSync(join(h.home, '.morse', 'plugins', 'dispatch', 'state.json')).mode & 0o777).toBe(0o600);

    // that session is "open on the computer" (an interactive claude --resume=<id> process)
    let live: ChildProcess | null = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--resume=${BRIDGE_SID}`]);
    children.push(live);
    const dispatch = spawn(process.execPath, ['--import', TSX, join(repo, 'src/plugins/dispatch/main.ts')], { env });
    children.push(dispatch);
    let dlog = '';
    dispatch.stdout.on('data', (d) => (dlog += String(d)));
    dispatch.stderr.on('data', (d) => (dlog += String(d)));
    await until(() => existsSync(join(h.home, '.morse', 'registered', 'dispatch-wechat.json')), 20_000, `@dispatch:wechat registered\n${dlog}`);
    const run = start({ ...h, env }, fake, cfg, { watch: true });
    try {
      // 2. whenLive "resume": answered although the session is live — in the bridge's session, in its directory
      fake.push(wxText('电脑上开着也回我', { context: 'ctx-live' }));
      await until(() => answer('ctx-live').length > 0, 45_000, `the answer while live\n${dlog}`);
      expect(answer('ctx-live')[0]!.text).toBe('got: 电脑上开着也回我');
      expect(turns()[0]!.args).toEqual(expect.arrayContaining(['--resume', BRIDGE_SID, '--permission-mode', 'acceptEdits', '--model', 'claude-fable-5-2']));
      expect(realpathSync(turns()[0]!.cwd)).toBe(h.work);

      // 3. whenLive "wait": held while live, untouched; answered once the session is closed
      writeLaunch('wait');
      await new Promise((r) => setTimeout(r, 2500)); // the launch config is re-read every 2 s
      fake.push(wxText('等你关了再回', { context: 'ctx-wait' }));
      await until(() => h.open().inbox({ all: true }).some((m) => m.parts[0]?.text === '等你关了再回'), 20_000, 'forwarded');
      await new Promise((r) => setTimeout(r, 3000));
      const waiting = h.open().inbox({ all: true }).find((m) => m.parts[0]?.text === '等你关了再回')!;
      expect(h.open().getMessage(waiting.id)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(turns()).toHaveLength(1);
      live.kill();
      live = null;
      await until(() => answer('ctx-wait').length > 0, 30_000, `the answer after closing\n${dlog}`);
      writeLaunch('resume');

      // 4. one turn at a time for the session, however fast the messages come
      fake.push(wxText('slow one', { context: 'ctx-s1' }), wxText('slow two', { context: 'ctx-s2' }));
      await until(() => answer('ctx-s1').length > 0 && answer('ctx-s2').length > 0, 45_000, 'both slow answers');
      const slow = turns().filter((t) => /slow/.test(t.args.at(-1)!));
      expect(slow).toHaveLength(2);
      expect(slow[0]!.end <= slow[1]!.start || slow[1]!.end <= slow[0]!.start).toBe(true);

      // 5. the session is gone: a new one in the profile's directory, and the reply says so once
      writeFileSync(known, '');
      fake.push(wxText('还记得吗', { context: 'ctx-reset' }));
      await until(() => answer('ctx-reset').length > 0, 45_000, `the answer after a reset\n${dlog}`);
      expect(answer('ctx-reset')[0]!.text).toBe(`${NOTICE}\n\ngot: 还记得吗`);
      const fresh = dedicated().sessionId;
      expect(fresh).not.toBe(BRIDGE_SID);
      const created = turns().find((t) => t.args.includes('--session-id'))!;
      expect(created.args).toEqual(expect.arrayContaining(['--session-id', fresh]));
      expect(realpathSync(created.cwd)).toBe(h.work);
      fake.push(wxText('再来一条', { context: 'ctx-after' }));
      await until(() => answer('ctx-after').length > 0, 45_000, 'the next answer');
      expect(answer('ctx-after')[0]!.text).toBe('got: 再来一条'); // said once
      expect(turns().at(-1)!.args).toEqual(expect.arrayContaining(['--resume', fresh]));

      // 6. an image lands inside the agent's directory (it can read it), 0600, git-ignored
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 5)]);
      fake.push({ message_id: 8888, seq: 8888, from_user_id: OWNER, context_token: 'ctx-img', item_list: [{ type: 2, image_item: { media: fake.media(png) } }] });
      await until(() => answer('ctx-img').length > 0, 45_000, 'the image answer');
      const day = readdirSync(cfg.mediaDir).find((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))!;
      const saved = join(cfg.mediaDir, day, '8888-image.png');
      expect(readFileSync(saved)).toEqual(png);
      expect(statSync(saved).mode & 0o777).toBe(0o600);
      expect(saved.startsWith(`${h.work}/`)).toBe(true);
      expect(readFileSync(join(cfg.mediaDir, '.gitignore'), 'utf8')).toBe('*\n');
      expect(answer('ctx-img')[0]!.text).toContain(saved);

      // 7. a failure: one try, told quickly and exactly once
      const t0 = Date.now();
      fake.push(wxText('please fail', { context: 'ctx-fail' }));
      await until(() => answer('ctx-fail').length > 0, 30_000, `the failure notice\n${dlog}`);
      expect(Date.now() - t0).toBeLessThan(20_000);
      await new Promise((r) => setTimeout(r, 5000));
      expect(answer('ctx-fail').map((s) => s.text)).toEqual(['处理出错了，请稍后再试。']);
      expect(turns().filter((t) => /please fail/.test(t.args.at(-1)!))).toHaveLength(1);

      // 8. status: the profile and its directory; a warning when mediaDir is outside it
      const st = JSON.parse((await cli('ilink', 'status', '--json')).out);
      expect(st).toMatchObject({ target: '@dispatch:wechat', profile: 'wechat', agentCwd: h.work, mediaDir: join(h.work, 'wechat-media'), warnings: [] });
      writeLaunch('resume', { mediaDir: join(h.home, 'elsewhere') });
      const warned = JSON.parse((await cli('ilink', 'status', '--json')).out);
      expect(warned.warnings.join('\n')).toMatch(/outside the answering agent's working directory/);
      const sessions = JSON.parse((await cli('dispatch', 'session', '--json')).out);
      expect(sessions.dedicated).toEqual([expect.objectContaining({ profile: 'wechat', address: '@dispatch:wechat', session: fresh, whenLive: 'resume' })]);
    } finally {
      live?.kill();
      await run.stop();
      await stopProcess(dispatch);
      await fake.close();
    }
  }, 240_000);
});
