import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';
import {
  bareHandle,
  currentDomainUrl,
  DEFAULT_RELAY_URL,
  DEFAULT_SITE_URL,
  fetchRelay,
  formatAddress,
  LEGACY_MORSE_DOMAINS,
  MORSE_DOMAIN,
  stripAddressHost,
} from '../src/cluster/address.js';
import { blockedHandles, blockHandle, isBlocked, unblockHandle } from '../src/cluster/blocklist.js';
import { loadOrCreateEncKey, makeKeyBundle } from '../src/cluster/e2e.js';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import { DEFAULT_RELAY_URL as JOIN_DEFAULT_RELAY_URL, DEFAULT_SITE_URL as JOIN_DEFAULT_SITE_URL, installCommand, pairCommands, parseHandle, planJoin } from '../src/cluster/join.js';
import { devicesFor, handleOf, hasRelayHost, parseMorseAddress, startMorse, type Morse } from '../src/cluster/morse.js';
import { startRelayClient } from '../src/cluster/relay-client.js';
import { acceptRequest, declineRequest, formatRequests, handleKey } from '../src/cluster/requests.js';
import { createTrustStore } from '../src/cluster/trust.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { dataDir } from '../src/home.js';
import { migrateLegacyDomains, readMachineConfig } from '../src/machine-config.js';
import { DEFAULT_SITE } from '../src/update/release-key.js';
import { checkLatest, updateSite } from '../src/update/updater.js';

/**
 * ADR-040 as revised by ADR-075: morse.im is the only domain in use. morse.talk is
 * retired — the client never connects or falls back to it and a saved config that names
 * it is rewritten once — but `morse.talk/<handle>` typed or stored before is still
 * accepted as input.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-domain-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('addresses: morse.talk/<handle> (the retired domain) is still accepted as input', () => {
  const cases: Array<[string, { handle: string; agent?: string }]> = [
    ['mei', { handle: 'mei' }],
    ['@mei', { handle: 'mei' }],
    ['morse.im/mei', { handle: 'mei' }],
    ['morse.talk/mei', { handle: 'mei' }],
    ['morse.im/mei/', { handle: 'mei' }],
    ['morse.talk/mei//', { handle: 'mei' }],
    ['MORSE.IM/Mei', { handle: 'mei' }],
    ['Morse.Talk/Mei/AIR', { handle: 'mei', agent: 'air' }],
    ['https://morse.im/mei/air/', { handle: 'mei', agent: 'air' }],
    ['http://morse.talk/mei/air', { handle: 'mei', agent: 'air' }],
    ['@morse.im/mei/air', { handle: 'mei', agent: 'air' }],
    ['morse.im/@mei', { handle: 'mei' }],
    ['  morse.im/k7f3a9xq/macbook-air  ', { handle: 'k7f3a9xq', agent: 'macbook-air' }],
    ['mei/air', { handle: 'mei', agent: 'air' }],
  ];
  it.each(cases)('parseMorseAddress(%j)', (input, want) => {
    expect(parseMorseAddress(input)).toEqual(want);
  });

  it('the same person and agent, whichever domain', () => {
    for (const [a, b] of [
      ['morse.im/bob', 'morse.talk/bob'],
      ['morse.im/bob/air', 'morse.talk/BOB/air/'],
      ['https://morse.im/bob', 'bob'],
    ]) {
      expect(parseMorseAddress(a!)).toEqual(parseMorseAddress(b!));
    }
  });

  it('not addresses: session targets, empty, bad names', () => {
    expect(parseMorseAddress('@codex:frontend')).toBeNull();
    expect(parseMorseAddress('@mini/codex:frontend')).toBeNull();
    expect(parseMorseAddress('morse.im/')).toBeNull();
    expect(parseMorseAddress('morse.im/a')).toBeNull(); // handles are 2+ characters
    expect(parseMorseAddress('morse.im/bob/air/extra')).toBeNull();
    expect(parseMorseAddress('morse.im/bob/-air')).toBeNull();
  });

  it('parseHandle / handleKey / handleOf / bareHandle / hasRelayHost', () => {
    for (const s of ['k7f3a9xq', '@k7f3a9xq', 'morse.im/k7f3a9xq', 'morse.talk/k7f3a9xq', 'MORSE.IM/K7F3A9XQ/', 'https://morse.talk/k7f3a9xq']) {
      expect(parseHandle(s)).toBe('k7f3a9xq');
      expect(handleKey(s)).toBe('k7f3a9xq');
      expect(bareHandle(s)).toBe('k7f3a9xq');
    }
    expect(handleKey('morse.talk/bob/air')).toBe('bob');
    expect(handleKey('morse.im/Bob/air')).toBe('bob');
    expect(handleOf('morse.talk/bob/air')).toBe('bob');
    expect(handleOf('morse.im/bob')).toBe('bob');
    expect(handleOf('bob/air')).toBe('bob');
    expect(stripAddressHost('@morse.talk/Bob/air/')).toBe('Bob/air');
    expect(hasRelayHost('morse.im/bob')).toBe(true);
    expect(hasRelayHost('morse.talk/bob')).toBe(true);
    expect(hasRelayHost('bob')).toBe(false);
    expect(hasRelayHost('@codex:frontend')).toBe(false);
    expect(planJoin('morse.im/k7f3a9xq', 'abcde-fghjk')).toEqual({ kind: 'pair', handle: 'k7f3a9xq', code: 'abcde-fghjk' });
    expect(planJoin('morse.talk/k7f3a9xq', 'abcde-fghjk')).toEqual({ kind: 'pair', handle: 'k7f3a9xq', code: 'abcde-fghjk' });
  });

  it('we print morse.im/…', () => {
    expect(MORSE_DOMAIN).toBe('morse.im');
    expect(LEGACY_MORSE_DOMAINS).toEqual(['morse.talk']); // input compatibility only
    expect(formatAddress('bob')).toBe('morse.im/bob');
    expect(formatAddress('bob', 'air')).toBe('morse.im/bob/air');
    expect(formatAddress('bob', null)).toBe('morse.im/bob');
  });
});

describe('default URLs', () => {
  it('new installs: wss://relay.morse.im and https://morse.im', () => {
    expect(DEFAULT_RELAY_URL).toBe('wss://relay.morse.im');
    expect(DEFAULT_SITE_URL).toBe('https://morse.im');
    expect(JOIN_DEFAULT_RELAY_URL).toBe(DEFAULT_RELAY_URL);
    expect(JOIN_DEFAULT_SITE_URL).toBe(DEFAULT_SITE_URL);
    expect(DEFAULT_SITE).toBe('https://morse.im');
    expect(updateSite({}, {})).toBe('https://morse.im');
    expect(installCommand('abc')).toBe('curl -fsSL https://morse.im/install.sh | bash -s -- abc');
    expect(pairCommands('k7f3a9xq', 'abcdefghjk').install).toContain('https://morse.im/install.sh');
  });

  it('an explicit other site is kept as it is', () => {
    expect(updateSite({ update: { site: 'https://mirror.example.com/' } }, {})).toBe('https://mirror.example.com');
    expect(installCommand('abc', 'https://mirror.example.com')).toBe('curl -fsSL https://mirror.example.com/install.sh | bash -s -- abc');
  });
});

describe('morse.talk is retired (ADR-075): no fallback to it', () => {
  it('updater: morse.im unreachable → a network error; nothing is fetched from another domain', async () => {
    const seen: string[] = [];
    const f = vi.fn(async (u: string) => {
      seen.push(u);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const c = await checkLatest({ site: 'https://morse.im', publicKey: 'AAAA', installedRelease: () => 1, fetch: f });
    expect(c).toMatchObject({ kind: 'error', code: 'network' });
    expect(seen.sort()).toEqual(['https://morse.im/version.json', 'https://morse.im/version.json.sig']);
  });

  it('relay HTTP: relay.morse.im unreachable → the error; one request, to relay.morse.im', async () => {
    const seen: string[] = [];
    const f = vi.fn(async (u: string) => {
      seen.push(u);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(fetchRelay('wss://relay.morse.im', '/v1/register', { method: 'POST' }, f)).rejects.toThrow('fetch failed');
    expect(seen).toEqual(['https://relay.morse.im/v1/register']);
    const ok = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    expect((await fetchRelay('ws://127.0.0.1:8787/base/', '/v1/join', { method: 'POST' }, ok)).status).toBe(200);
    expect(ok).toHaveBeenCalledWith('http://127.0.0.1:8787/base/v1/join', { method: 'POST' });
  });

  it('relay client: relay.morse.im cannot be reached → it keeps trying relay.morse.im, never another name', async () => {
    const home = freshHome();
    const identity = loadOrCreateIdentity(home);
    const seen: string[] = [];
    const client = startRelayClient({
      url: 'wss://relay.morse.im',
      identity,
      bundle: makeKeyBundle(identity, loadOrCreateEncKey(home)),
      onDeliver: async () => undefined,
      createSocket: (u) => {
        seen.push(u);
        throw new Error('unreachable');
      },
      minBackoffMs: 5,
      maxBackoffMs: 10,
    });
    try {
      const end = Date.now() + 5000;
      while (seen.length < 4 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
      expect(seen.length).toBeGreaterThanOrEqual(4);
      expect(seen.every((u) => new URL(u).hostname === 'relay.morse.im')).toBe(true);
      expect(client.url).toBe('wss://relay.morse.im');
    } finally {
      client.close();
    }
  });
});

describe('morse.talk is retired (ADR-075): a saved config that names it is rewritten once', () => {
  it('currentDomainUrl: the relay and the site on the retired domain, nothing else', () => {
    expect(currentDomainUrl('wss://relay.morse.talk')).toBe('wss://relay.morse.im');
    expect(currentDomainUrl('wss://RELAY.MORSE.TALK/')).toBe('wss://relay.morse.im');
    expect(currentDomainUrl('wss://relay.morse.talk:8443/base')).toBe('wss://relay.morse.im:8443/base');
    expect(currentDomainUrl('https://morse.talk')).toBe('https://morse.im');
    expect(currentDomainUrl(' https://morse.talk/ ')).toBe('https://morse.im');
    for (const other of ['wss://relay.morse.im', 'https://morse.im', 'ws://127.0.0.1:8787', 'wss://relay.example.com', 'https://staging.morse.talk', 'https://notmorse.talk', 'https://morse.talk.example.com', 'not a url', '']) {
      expect(currentDomainUrl(other), other).toBeNull();
    }
  });

  it('relay.url and update.site are rewritten, one log line, every other key kept; the second time nothing happens', () => {
    const home = freshHome();
    mkdirSync(dataDir(home), { recursive: true });
    const file = join(dataDir(home), 'config.json');
    const before = { relay: { url: 'wss://relay.morse.talk', handle: 'mei', agent: 'air', agents: ['air'] }, update: { auto: false, site: 'https://morse.talk/' }, morse: { strangers: 'block' }, mine: [1, 2] };
    writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
    const logs: string[] = [];
    expect(migrateLegacyDomains(file, (l) => logs.push(l))).toEqual(['relay.url wss://relay.morse.talk → wss://relay.morse.im', 'update.site https://morse.talk/ → https://morse.im']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('relay.url wss://relay.morse.talk → wss://relay.morse.im');
    expect(logs[0]).toContain(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...before, relay: { ...before.relay, url: 'wss://relay.morse.im' }, update: { auto: false, site: 'https://morse.im' } });
    expect(readMachineConfig(file).relay?.url).toBe('wss://relay.morse.im');
    expect(updateSite(readMachineConfig(file), {})).toBe('https://morse.im');
    // once: nothing left to rewrite — no write, no log
    const text = readFileSync(file, 'utf8');
    expect(migrateLegacyDomains(file, (l) => logs.push(l))).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('other relays and sites, no config, a broken config: left alone', () => {
    const home = freshHome();
    mkdirSync(dataDir(home), { recursive: true });
    const file = join(dataDir(home), 'config.json');
    const logs: string[] = [];
    expect(migrateLegacyDomains(file, (l) => logs.push(l))).toEqual([]); // no file — and none is created
    expect(() => readFileSync(file)).toThrow();
    for (const text of [JSON.stringify({ relay: { url: 'ws://127.0.0.1:8787' }, update: { site: 'https://mirror.example.com' } }), JSON.stringify({ relay: { url: 'wss://relay.morse.im' } }), '{ not json', '[]']) {
      writeFileSync(file, text);
      expect(migrateLegacyDomains(file, (l) => logs.push(l))).toEqual([]);
      expect(readFileSync(file, 'utf8')).toBe(text);
    }
    expect(logs).toEqual([]);
  });

  it('any morse command rewrites it before reading the config, and says so once (stderr)', async () => {
    const home = freshHome();
    mkdirSync(join(home, '.morse'), { recursive: true });
    const file = join(home, '.morse', 'config.json');
    writeFileSync(file, JSON.stringify({ relay: { url: 'wss://relay.morse.talk', handle: 'me', agent: 'mini', agents: ['mini'] } }));
    const cli = (...args: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: resolve(__dirname, '..'), env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += String(d)));
        p.stderr.on('data', (d) => (err += String(d)));
        p.on('close', (code) => done({ code, out, err }));
      });
    const first = await cli('contact', '--json');
    expect(first.code, first.err).toBe(0);
    expect(JSON.parse(first.out)).toHaveProperty('contacts'); // stdout is still only the JSON
    expect(first.err).toContain('relay.url wss://relay.morse.talk → wss://relay.morse.im');
    expect(JSON.parse(readFileSync(file, 'utf8')).relay).toEqual({ url: 'wss://relay.morse.im', handle: 'me', agent: 'mini', agents: ['mini'] });
    const second = await cli('contact', '--json');
    expect(second.code, second.err).toBe(0);
    expect(second.err).not.toContain('relay.url');
  }, 20_000);
});

describe('stored records written with a domain — also the retired one — still match (light migration on read)', () => {
  it('blocklist: an entry "morse.talk/carol" blocks carol, whichever way she is named', () => {
    const home = freshHome();
    mkdirSync(dataDir(home), { recursive: true });
    writeFileSync(join(dataDir(home), 'morse-blocked.json'), JSON.stringify({ handles: ['morse.talk/carol', 'Dave', 'morse.im/dave', 7] }));
    expect(blockedHandles(home)).toEqual(['carol', 'dave']);
    expect(isBlocked('carol', home)).toBe(true);
    expect(isBlocked('morse.im/carol', home)).toBe(true);
    expect(isBlocked('morse.talk/Carol/air', home)).toBe(true);
    expect(unblockHandle('morse.im/carol', home)).toBe(true);
    expect(isBlocked('carol', home)).toBe(false);
    blockHandle('morse.talk/erin', home);
    expect(blockedHandles(home)).toEqual(['dave', 'erin']);
  });

  it('trusted devices: found by handle with either domain (and handle/agent)', () => {
    const home = freshHome();
    const trust = createTrustStore(home);
    trust.add({ id: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH', name: 'bob', tier: 'peer' });
    for (const to of ['bob', 'morse.im/bob', 'morse.talk/bob', 'morse.im/bob/air', 'MORSE.TALK/BOB/air/']) {
      expect(devicesFor(trust, to).map((d) => d.name)).toEqual(['bob']);
    }
  });

  it('message requests (stored by bare handle): accept / decline with either domain; printed as morse.im', () => {
    const fileOne = (mailbox: Mailbox, handle: string) =>
      mailbox.requests.file({
        handle,
        deviceId: `${handle.toUpperCase().padEnd(7, 'X').slice(0, 7)}-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH`,
        msgId: `m-${handle}`,
        from: { agent: 'claude', sessionId: 's' },
        fromAgent: 'mbp',
        to: { agent: 'inbox', sessionId: 'inbox' },
        text: `hello from ${handle}`,
        droppedFiles: 0,
        via: 'relay',
      });
    const home = freshHome();
    const mailbox = createMailbox(createDb(':memory:'));
    fileOne(mailbox, 'bob');
    fileOne(mailbox, 'carol');
    fileOne(mailbox, 'dave');
    expect(formatRequests(mailbox.requests.list()).join('\n')).toContain('morse.im/bob/mbp');
    expect(formatRequests(mailbox.requests.list()).join('\n')).not.toContain('morse.talk');
    const trust = createTrustStore(home);
    expect(acceptRequest('morse.talk/bob', { mailbox, trust, home })).toMatchObject({ ok: true });
    expect(acceptRequest('morse.im/Carol/', { mailbox, trust, home })).toMatchObject({ ok: true });
    expect(trust.list().map((d) => d.name).sort()).toEqual(['bob', 'carol']);
    const d = declineRequest('https://morse.talk/dave', { mailbox, home });
    expect(d).toMatchObject({ ok: true });
    expect(isBlocked('morse.im/dave', home)).toBe(true);
    const none = acceptRequest('morse.talk/nobody', { mailbox, trust, home });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('morse.im/nobody');
  });
});

// (ADR-091, stage 2) "over a real relay: an address typed with the retired domain reaches the same agent" is gone: it
// sent to old names (morse.im/bob/air, morse.talk/bob/air), and old names reach nobody any more.
