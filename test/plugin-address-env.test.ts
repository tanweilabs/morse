import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS_SELECTORS, BY_PLUGIN, dropAddressSelectors, pluginCommandEnv, withoutAddressSelectors } from '../src/address-env.js';
import { addressFromEnv } from '../src/commands/known-as.js';
import { updateMachineConfig } from '../src/machine-config.js';
import { createCliClient, runMorse, watchEvents } from '../src/plugin/cli-client.js';
import type { PluginMessage } from '../src/plugin/contract.js';
import { startPluginManager } from '../src/plugin/manager.js';
import { createCliCore } from '../src/plugins/attendant/core.js';
import { createMorseSide } from '../src/plugins/ilink/morse.js';
import { freePort } from './helpers/local-api.js';
import { addressOf, cliAt, cliRaw, computer, mailboxOf, removeHomes, REPO, someone, until, type Computer } from './helpers/personas-home.js';

/**
 * ADR-088 §4 — MORSE_ADDRESS selects an address for ONE session. The daemon, the plugins it supervises (attendant,
 * dispatch, the WeChat bridge) and the `morse` commands those run work for every address of the home: a daemon
 * started from a shell that exports MORSE_ADDRESS must behave exactly as one started from a clean environment.
 * (Found by the review of the first draft: an inherited selector made the plugins' own `morse message --json`
 * return nothing — the attendant did not answer, and the WeChat bridge never saw the reply.)
 *
 * Three guards, each tested on its own: the daemon drops the selector from its environment; whatever starts a
 * plugin or a plugin's command builds the environment without it; a command run for a plugin ignores one that
 * is there all the same. (The WeChat round trip itself — fake WeChat → Morse → dispatch → WeChat, with
 * MORSE_ADDRESS in the plugins' environment — is in test/ilink-plugin.test.ts.)
 */

const SID = 'dddd0000-0000-4000-8000-00000000000d';
const texts = (ms: Array<Pick<PluginMessage, 'text'>>): string[] => ms.map((m) => m.text).sort();
let ann: Computer;
let work: string;
let cat: string;
let ownId: string;
let toMiniId: string;
/** The exact command a plugin runs (`MORSE_CMD_JSON`), against ann's temp home; `more` = set by `env` AFTER whatever the caller passes. */
const cmdWith = (...more: string[]): string[] => ['/usr/bin/env', ...more, `MORSE_HOME=${ann.home}`, `ANYTOANY_HOME=${ann.home}`, `HOME=${ann.home}`, process.execPath, '--import', join(REPO, 'node_modules/tsx/dist/loader.mjs'), join(REPO, 'src/cli.ts')];

beforeAll(() => {
  ann = computer('ann', 'mini', ['work']);
  work = addressOf(ann, 'work').address;
  cat = someone();
  const xin = someone();
  const mb = mailboxOf(ann.home);
  mb.contacts.set(mb.contacts.ensureAddress(cat, '').id, { remark: 'cat' }); // a contact of the first address
  mb.contacts.set(mb.contacts.ensureAddress(xin, work).id, { remark: 'xin' }); // a contact of `work`
  toMiniId = mb.send({ from: { agent: 'claude', sessionId: '', device: cat }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'cat to mini', fromTier: 'peer', myAddress: ann.address }).id;
  mb.send({ from: { agent: 'claude', sessionId: '', device: xin }, to: { agent: 'work', sessionId: 'inbox' }, text: 'xin to work', fromTier: 'peer', myAddress: work });
  // mail between my own sessions: what dispatch delivers, and what the WeChat bridge gets its answer as
  ownId = mb.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: SID }, text: 'own mail' }).id;
  mb.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'ilink', sessionId: 'ilink-wechat' }, text: 'an answer for wechat' });
});
afterEach(() => {
  delete process.env['MORSE_ADDRESS'];
});
afterAll(() => removeHomes());

describe('the environment of a plugin and of the commands it runs carries no address selector (ADR-088 §4)', () => {
  const probe = [process.execPath, '-e', "console.log(JSON.stringify({ type: 'probe', address: process.env.MORSE_ADDRESS ?? null, byPlugin: process.env.MORSE_BY_PLUGIN ?? null }))"];

  it('the helpers: a copy without the selector; the daemon\'s own environment loses it; a plugin\'s command is marked', () => {
    expect(ADDRESS_SELECTORS).toEqual(['MORSE_ADDRESS']);
    const env = { MORSE_ADDRESS: 'work', MORSE_HOME: '/h', PATH: '/bin' };
    expect(withoutAddressSelectors(env)).toEqual({ MORSE_HOME: '/h', PATH: '/bin' });
    expect(env.MORSE_ADDRESS).toBe('work'); // (a copy)
    expect(pluginCommandEnv(env)).toEqual({ MORSE_HOME: '/h', PATH: '/bin', [BY_PLUGIN]: '1' });
    const own: NodeJS.ProcessEnv = { ...env };
    dropAddressSelectors(own);
    expect(own).toEqual({ MORSE_HOME: '/h', PATH: '/bin' });
    // a command run for a plugin reads no selector, even one that is there
    expect(addressFromEnv({ first: 'a', byName: { work: 'b' } }, { MORSE_ADDRESS: 'work' })).toMatchObject({ address: 'b' });
    expect(addressFromEnv({ first: 'a', byName: { work: 'b' } }, { MORSE_ADDRESS: 'work', [BY_PLUGIN]: '1' })).toBeNull();
    expect(addressFromEnv({ first: 'a', byName: { work: 'b' } }, { MORSE_ADDRESS: 'nosuch', [BY_PLUGIN]: '1' })).toBeNull();
  });

  it('`runMorse` and `watchEvents` (how every plugin runs `morse`): the child never has MORSE_ADDRESS — inherited or handed in', async () => {
    process.env['MORSE_ADDRESS'] = 'work';
    const clean = { type: 'probe', address: null, byPlugin: '1' };
    expect(JSON.parse((await runMorse([], probe)).out)).toEqual(clean);
    expect(JSON.parse((await runMorse([], probe, { ...process.env, MORSE_ADDRESS: 'work' })).out)).toEqual(clean);
    for (const env of [undefined, { ...process.env, MORSE_ADDRESS: 'work' }]) {
      const seen = await new Promise<unknown>((done) => {
        const child = watchEvents((e) => done(e), { cmd: probe, ...(env ? { env } : {}) });
        child.on('error', (e) => done(e));
      });
      expect(seen).toEqual(clean);
    }
  }, 30_000);

  it('the plugin manager (how the daemon starts a plugin): the plugin never has MORSE_ADDRESS, whatever the daemon inherited', async () => {
    process.env['MORSE_ADDRESS'] = 'work';
    const out = join(ann.home, 'manager-probe.json');
    const script = join(ann.home, 'manager-probe.cjs');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ address: process.env.MORSE_ADDRESS ?? null, cmd: process.env.MORSE_CMD_JSON ?? null })); setInterval(() => {}, 1000);`);
    const manager = startPluginManager({ specs: () => [{ name: 'probe', argv: [process.execPath, script], enabled: true, builtin: false }], env: { MORSE_CMD_JSON: '["morse"]' }, log: () => {} });
    try {
      await until(() => existsSync(out), 15_000);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ address: null, cmd: '["morse"]' });
    } finally {
      await manager.stop();
    }
  }, 30_000);
});

describe('what the plugins read and do is the same with MORSE_ADDRESS=<second address> exported as with a clean environment (ADR-088 §4)', () => {
  /** What each plugin reads through its own client — the real `morse` command, ann's home. */
  const views = async (cmd: string[]) => {
    const attendant = createCliCore({ cmd });
    const dispatch = createCliClient({ cmd, by: 'plugin:dispatch' });
    const ilink = createMorseSide({ cmd });
    const todo = await ilink.todo();
    return {
      attendant: texts(await attendant.todo()),
      attendantHistory: texts(await attendant.history(`a:${cat}`, 10)),
      dispatch: texts(await dispatch.todo()),
      ilink: texts(todo.messages),
      ilinkUnread: todo.unread,
      ilinkRead: (await ilink.read(ownId))?.text ?? null,
    };
  };
  let clean: Awaited<ReturnType<typeof views>>;

  beforeAll(async () => {
    clean = await views(cmdWith());
    // (what "clean" is: mail written to BOTH addresses — a plugin works for the whole home)
    expect(clean.attendant).toEqual(expect.arrayContaining(['cat to mini', 'xin to work']));
    expect(clean.attendantHistory).toEqual(['cat to mini']);
    expect(clean.ilinkRead).toBe('own mail');
  }, 120_000);

  it('for a session it does select: `MORSE_ADDRESS=work morse message --json` lists work\'s mail only (so the comparison below means something)', async () => {
    const own = JSON.parse((await cliAt(ann.home, ['message', '--json'], { MORSE_ADDRESS: 'work' })).out) as { messages: PluginMessage[] };
    expect(texts(own.messages)).toEqual(['xin to work']);
  }, 60_000);

  it('exported in the plugin\'s own environment (the daemon inherited it from its shell): attendant, dispatch and the WeChat bridge read exactly the same', async () => {
    process.env['MORSE_ADDRESS'] = 'work';
    expect(await views(cmdWith())).toEqual(clean);
    process.env['MORSE_ADDRESS'] = 'nosuch'; // (naming no address here is one error line for a session's command — for a plugin: nothing)
    expect(await views(cmdWith())).toEqual(clean);
  }, 120_000);

  it('set on the command itself, past every guard of the environment: a command run for a plugin ignores it', async () => {
    expect(await views(cmdWith('MORSE_ADDRESS=work'))).toEqual(clean);
    expect(await views(cmdWith('MORSE_ADDRESS=nosuch'))).toEqual(clean);
  }, 120_000);

  it('dispatch claims own mail; the attendant answers mail written to the FIRST address from the first address — with MORSE_ADDRESS=work exported', async () => {
    process.env['MORSE_ADDRESS'] = 'work';
    const dispatch = createCliClient({ cmd: cmdWith(), by: 'plugin:dispatch' });
    const claimed = await dispatch.claimNext();
    expect(claimed).toMatchObject({ id: ownId, text: 'own mail', myAddress: null });
    await dispatch.release(ownId);
    // `morse plugin …` reads no selector at all — also run by hand, with one that names nothing
    const byHand = await cliAt(ann.home, ['plugin', 'claim', '--next', '--json'], { MORSE_ADDRESS: 'nosuch' });
    expect({ code: byHand.code, err: byHand.err }).toEqual({ code: 0, err: '' });
    expect((JSON.parse(byHand.out) as { message: PluginMessage }).message).toMatchObject({ id: ownId });
    await dispatch.release(ownId);
    const answer = await createCliCore({ cmd: cmdWith() }).reply(toMiniId, 'the attendant answers cat');
    expect(answer).toMatchObject({ ok: true });
    const row = mailboxOf(ann.home).getMessage((answer as { id: string }).id)!;
    expect(row).toMatchObject({ direction: 'out', myAddress: ann.address });
    expect(row.myAddress).not.toBe(work);
  }, 120_000);
});

describe('a real daemon started from a shell that exports MORSE_ADDRESS=<second address> (ADR-088 §4)', () => {
  it('it says so once in its log, and a plugin it starts has no MORSE_ADDRESS: its `morse message --json` lists the whole home', async () => {
    const home = computer('bea', 'mini', ['work']);
    const second = addressOf(home, 'work').address;
    const mb = mailboxOf(home.home);
    mb.send({ from: { agent: 'claude', sessionId: '', device: someone() }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'to mini', fromTier: 'peer', myAddress: home.address });
    mb.send({ from: { agent: 'claude', sessionId: '', device: someone() }, to: { agent: 'work', sessionId: 'inbox' }, text: 'to work', fromTier: 'peer', myAddress: second });
    // a plugin of the owner's own: says what its environment has and what the command it is given lists
    const out = join(home.home, 'plugin-probe.json');
    const script = join(home.home, 'plugin-probe.cjs');
    writeFileSync(
      script,
      `const { execFileSync } = require('child_process');
const cmd = JSON.parse(process.env.MORSE_CMD_JSON);
let listed;
try { listed = JSON.parse(execFileSync(cmd[0], [...cmd.slice(1), 'message', '--json'], { encoding: 'utf8' })).messages.map((m) => m.text).sort(); } catch (e) { listed = String(e.stderr || e); }
require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ address: process.env.MORSE_ADDRESS ?? null, listed }));
setInterval(() => {}, 1000);
`,
    );
    chmodSync(script, 0o700);
    updateMachineConfig((cfg) => {
      (cfg['relay'] as Record<string, unknown>)['url'] = 'ws://127.0.0.1:9'; // (no relay is reached)
      cfg['plugins'] = { dispatch: { enabled: false }, attendant: { enabled: false }, probe: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` } };
      cfg['update'] = { auto: false };
    }, join(home.home, '.morse', 'config.json'));
    const port = String(await freePort());
    const started = await cliRaw(home.home, ['start', '--background', '--no-lan', '--no-notify', '--port', port], { MORSE_ADDRESS: 'work' });
    try {
      expect(started.code, started.err + started.out).toBe(0);
      await until(() => existsSync(out), 30_000);
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ address: null, listed: ['to mini', 'to work'] });
      const log = readFileSync(join(home.home, '.morse', 'daemon.log'), 'utf8');
      expect(log.split('\n').filter((l) => l.includes("MORSE_ADDRESS in the daemon's environment is ignored"))).toHaveLength(1);
    } finally {
      await cliRaw(home.home, ['stop']);
      await until(() => !existsSync(join(home.home, '.morse', 'daemon.pid')), 15_000);
    }
  }, 120_000);
});
