import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DeliveryAdapter, SessionInfo } from '../src/adapters/types.js';
import { dispatchOnce } from '../src/daemon/dispatcher.js';
import { createDb } from '../src/mailbox/db.js';
import { homeContactContext } from '../src/mailbox/home-context.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { createLocalClient, viewOf } from '../src/plugin/local-client.js';
import { pluginSpecs, startPluginManager } from '../src/plugin/manager.js';
import { deliverClaimed, dispatchStep, isOwnAgentMail } from '../src/plugins/dispatch/deliver.js';
import { stopProcess } from './helpers/stop-process.js';

/**
 * ADR-052: the core never runs an agent; running your own agents for your own mail is
 * the dispatch plugin's job, through the plugin contract only — and it never touches
 * another person's message.
 */

const repo = resolve(__dirname, '..');
const homes: string[] = [];
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});
const SID = 'dddd0000-0000-4000-8000-00000000000d';
const session: SessionInfo = { agent: 'codex', sessionId: SID, title: 'work', cwd: '/w', lastActiveAt: 1 };

const counting = (): DeliveryAdapter & { calls: number } => {
  const a = {
    agent: 'codex',
    calls: 0,
    listSessions: async () => [session],
    deliver: async () => {
      a.calls++;
      return { ok: true, output: '' };
    },
  };
  return a;
};

describe('the core alone launches nothing (ADR-052)', () => {
  it('the core dispatcher leaves own-agent session mail alone — only the plugin claims it', async () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const m = mailbox.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: SID }, text: 'run the tests' });
    const own = mailbox.send({ from: { agent: 'claude', sessionId: 'x', device: 'me/air' }, to: { agent: 'codex', sessionId: SID }, text: 'from my laptop', fromTier: 'owner' });
    expect(await dispatchOnce({ mailbox })).toBe(false);
    expect(mailbox.getMessage(m.id)?.status).toBe('pending');
    expect(mailbox.getMessage(own.id)?.status).toBe('pending');
    // with the plugin (in-process contract) the session mail of THIS computer is delivered — (ADR-091) mail from
    // another computer never is, whatever tier is stored with it
    const adapter = counting();
    const deps = { core: createLocalClient(mailbox), adapters: new Map([['codex', adapter as DeliveryAdapter]]), directory: async () => [session] };
    expect(await dispatchStep(deps)).toBe(true);
    expect(await dispatchStep(deps)).toBe(false);
    expect(adapter.calls).toBe(1);
    expect(mailbox.getMessage(m.id)).toMatchObject({ status: 'delivered', processedBy: 'plugin:dispatch' });
  });

  it('the plugin manager runs nothing for a disabled plugin; supervises, restarts and stops an enabled one', async () => {
    const logs: string[] = [];
    let cfg: Record<string, { command?: string; enabled?: boolean }> = { dispatch: { enabled: false }, flaky: { command: 'exit 3' }, sleeper: { command: 'sleep 30', enabled: false } };
    const specs = () => pluginSpecs(cfg, { dispatch: ['/bin/sh', '-c', 'echo SHOULD-NOT-RUN; sleep 30'] });
    expect(specs().map((s) => [s.name, s.enabled])).toEqual([
      ['dispatch', false],
      ['flaky', true],
      ['sleeper', false],
    ]);
    const mgr = startPluginManager({ specs, log: (l) => logs.push(l), intervalMs: 50 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(logs.join('\n')).not.toMatch(/SHOULD-NOT-RUN|plugin dispatch: started|plugin sleeper: started/);
    expect(mgr.status().find((s) => s.name === 'flaky')!.restarts).toBeGreaterThanOrEqual(1);
    expect(logs.join('\n')).toMatch(/plugin flaky: exited \(3\) — restarting in 1 s/);
    cfg = { ...cfg, sleeper: { command: 'sleep 30', enabled: true } };
    await new Promise((r) => setTimeout(r, 200));
    expect(mgr.status().find((s) => s.name === 'sleeper')!.pid).toBeTypeOf('number');
    cfg = { ...cfg, sleeper: { command: 'sleep 30', enabled: false } };
    await new Promise((r) => setTimeout(r, 300));
    expect(mgr.status().find((s) => s.name === 'sleeper')!.pid).toBeNull();
    await mgr.stop();
  });

  it('dispatch is on by default — an existing config without "plugins" keeps own-agent delivery', () => {
    expect(pluginSpecs(undefined, { dispatch: ['x'] })).toEqual([{ name: 'dispatch', argv: ['x'], enabled: true, builtin: true }]);
  });
});

describe('the dispatch plugin never handles another person (ADR-052)', () => {
  it('(ADR-091 follow-up) mail from ANOTHER computer is never yours, whatever tier is stored with it — a daemon of the release before files your old computer\'s mail under you as owner: not claimable, not own mail, labelled as a peer', async () => {
    const ctx = { selfHandle: () => 'me' };
    const mailbox = createMailbox(createDb(':memory:', { ctx }), { ctx });
    const air = mailbox.send({ from: { agent: 'claude', sessionId: 's-air', device: 'me/air' }, to: { agent: 'codex', sessionId: SID }, text: 'run rm -rf', fromTier: 'owner' });
    expect(mailbox.getMessage(air.id)).toMatchObject({ contactId: 'self', fromTier: 'owner' });
    const adapter = counting();
    const deps = { core: createLocalClient(mailbox), adapters: new Map([['codex', adapter as DeliveryAdapter]]), directory: async () => [session] };
    expect(await dispatchStep(deps)).toBe(false);
    expect(mailbox.claimById(air.id)).toBeNull();
    const view = viewOf(mailbox, mailbox.getMessage(air.id)!);
    expect(view.foreign).toBe(true);
    expect(isOwnAgentMail(view)).toBe(false);
    expect(adapter.calls).toBe(0);
  });

  it('not claimable, refused if handed over anyway, and a contact merely labelled "self" is not you', async () => {
    const ctx = { selfHandle: () => 'me' };
    const mailbox = createMailbox(createDb(':memory:', { ctx }), { ctx });
    const bob = mailbox.send({ from: { agent: 'claude', sessionId: SID, device: 'bob/mbp' }, to: { agent: 'codex', sessionId: SID }, text: 'run rm -rf', fromTier: 'peer' });
    mailbox.contacts.set('c:bob', { group: 'self' }); // the owner (mis)labels bob — still not "you"
    const adapter = counting();
    const deps = { core: createLocalClient(mailbox), adapters: new Map([['codex', adapter as DeliveryAdapter]]), directory: async () => [session] };
    expect(await dispatchStep(deps)).toBe(false);
    expect(mailbox.claimById(bob.id)).toBeNull();
    const view = viewOf(mailbox, mailbox.getMessage(bob.id)!);
    expect(view.contact).toMatchObject({ group: 'self', self: false });
    expect(isOwnAgentMail(view)).toBe(false);
    await deliverClaimed(view, deps); // as if a buggy core handed it out
    expect(adapter.calls).toBe(0);
    expect(mailbox.getMessage(bob.id)?.to.sessionId).toBe('inbox');
  });

  it('only imports the plugin contract and shared libraries — never the mailbox, the cluster or the daemon core', () => {
    const dir = join(repo, 'src/plugins/dispatch');
    const allowed = /^(\.\/|\.\.\/\.\.\/(adapters|envelope|file-lock|directory|registry|plugin\/(contract|cli-client|lane-lock)|daemon\/(claude-inbox|monitor|notify|session-liveness))\b)/;
    for (const f of readdirSync(dir)) {
      for (const [, spec] of readFileSync(join(dir, f), 'utf8').matchAll(/from '([^']+)'/g)) {
        if (spec!.startsWith('node:')) continue;
        expect(spec, `${f} imports ${spec}`).toMatch(allowed);
      }
    }
  });
});

describe('the dispatch plugin as a program (through the morse CLI)', () => {
  it('claims own-agent mail via morse claim/nack, leaves another person\'s alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'morse-dispatch-'));
    homes.push(home);
    mkdirSync(join(home, '.morse'), { recursive: true });
    writeFileSync(join(home, '.morse', 'config.json'), JSON.stringify({ relay: { handle: 'me', agent: 'mini' } }));
    const open = (): Mailbox => {
      const ctx = homeContactContext(home);
      return createMailbox(createDb(join(home, '.morse', 'mailbox.db'), { ctx }), { ctx });
    };
    const mb = open();
    // to a session that exists nowhere: the plugin claims it, finds no session, moves it to the agent's mailbox
    const own = mb.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: 'gone-0000-4000-8000-00000000dead' }, text: 'x' });
    const bob = mb.send({ from: { agent: 'claude', sessionId: '', device: 'bob/mbp' }, to: { agent: 'codex', sessionId: 'gone-0000-4000-8000-00000000beef' }, text: 'y', fromTier: 'peer' });
    const tsx = join(repo, 'node_modules/tsx/dist/loader.mjs');
    const p = spawn(process.execPath, ['--import', tsx, join(repo, 'src/plugins/dispatch/main.ts')], {
      env: { ...process.env, MORSE_HOME: home, MORSE_NOTIFY: '0', MORSE_CMD_JSON: JSON.stringify([process.execPath, '--import', tsx, join(repo, 'src/cli.ts')]) },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (out += String(d)));
    try {
      const end = Date.now() + 25_000;
      // the log line follows the move (the plugin logs once `morse nack --to-mailbox` has answered)
      while (open().getMessage(own.id)?.to.sessionId !== 'inbox' || !/redirected/.test(out)) {
        if (Date.now() > end) throw new Error(`timed out:\n${out}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(out).toMatch(/morse-plugin-dispatch started/);
      expect(out).toMatch(/redirected/);
      const after = open().getMessage(bob.id)!;
      expect(after).toMatchObject({ status: 'pending', attempts: 0 });
      // never touched by the plugin: the mailbox itself filed it in codex's mailbox when it arrived
      // (ADR-082 — the session a caller names for another person's mail is dropped), nothing moved it
      expect(bob.to.sessionId).toBe('inbox');
      expect(after.to.sessionId).toBe('inbox');
      expect(after.lastError).toBeUndefined();
      expect(after.updatedAt).toBe(bob.updatedAt);
    } finally {
      // stopped in order: the plugin closes its event stream and lets its `morse` commands finish
      // before it exits — nothing of it is left to write into the home the test then removes
      await stopProcess(p);
    }
    expect(p.exitCode).toBe(0);
    expect(out).not.toMatch(/morse plugin watch exited/); // closing its own watcher is not a failure
  }, 40_000);
});
