import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/cluster/identity.js';
import {
  adminKeyFromEnv,
  createInvite,
  installCommand,
  joinRelay,
  JoinError,
  listInvites,
  normalizeInviteCode,
  parseDuration,
  probeMembership,
  relayHttpBase,
  revokeInvite,
} from '../src/cluster/join.js';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';

/**
 * Invites (ADR-032) — the client side (src/cluster/join.ts): `morse join <code>`
 * and the admin commands, against the in-memory fake relay.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-inv-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('morse join / morse invite (client)', () => {
  let relay: FakeRelay | null = null;
  afterEach(async () => {
    await relay?.close();
    relay = null;
  });
  const ADMIN = 'admin-secret';
  const fakeRelay = async () => {
    relay = await startFakeRelay({ adminKey: ADMIN });
    return relay;
  };

  it('helpers: code normalisation, durations, URLs, the install one-liner, the admin key comes only from the environment', () => {
    expect(normalizeInviteCode(' ABCD-EFGH ijkl mnop qrst uvwx yz23 4567 ')).toBe('abcdefghijklmnopqrstuvwxyz234567');
    expect(normalizeInviteCode('abc')).toBeNull();
    expect(normalizeInviteCode('0'.repeat(32))).toBeNull(); // not base32
    expect([parseDuration('7d'), parseDuration('12h'), parseDuration('30m'), parseDuration('90s'), parseDuration('3600'), parseDuration('1w')]).toEqual([604_800, 43_200, 1800, 90, 3600, 604_800]);
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('0d')).toBeNull();
    expect(relayHttpBase('wss://relay.morse.talk/')).toBe('https://relay.morse.talk');
    expect(relayHttpBase('ws://127.0.0.1:8787/base')).toBe('http://127.0.0.1:8787/base');
    expect(() => relayHttpBase('ftp://x')).toThrow();
    expect(installCommand('abc')).toBe('curl -fsSL https://morse.im/install.sh | bash -s -- abc');
    expect(installCommand('abc', 'http://127.0.0.1:9/')).toBe('curl -fsSL http://127.0.0.1:9/install.sh | bash -s -- abc');
    expect(() => adminKeyFromEnv({})).toThrow(/MORSE_ADMIN_KEY/);
    expect(adminKeyFromEnv({ MORSE_ADMIN_KEY: ' k ' })).toBe('k');
  });

  it('admin creates / lists / revokes; a new device joins and the relay URL + handle are saved; a used code is refused', async () => {
    const { url } = await fakeRelay();
    await expect(createInvite(url, 'wrong', { handle: 'alice' })).rejects.toThrow(/admin key/);
    const inv = await createInvite(url, ADMIN, { handle: 'alice', uses: 1, ttlSec: 3600 });
    expect(inv.code).toMatch(/^[a-z2-7]{32}$/);
    const spare = await createInvite(url, ADMIN, { handle: 'alice' });
    expect((await listInvites(url, ADMIN)).map((i) => i.id)).toEqual([inv.id, spare.id]);
    expect(await revokeInvite(url, ADMIN, spare.id)).toBe(true);
    expect(await revokeInvite(url, ADMIN, spare.id)).toBe(false);

    const home = freshHome();
    const r = await joinRelay({ code: inv.code, url, home, name: 'alice-mini', probe: false });
    expect(r).toEqual({ id: loadOrCreateIdentity(home).id, handle: 'alice', already: false });
    expect(JSON.parse(readFileSync(join(home, '.morse', 'config.json'), 'utf8'))).toEqual({ relay: { url, handle: 'alice' } });
    expect(relay!.entry(r.id)).toMatchObject({ handle: 'alice', name: 'alice-mini' });

    const late = freshHome();
    const err = await joinRelay({ code: inv.code, url, home: late, probe: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect((err as JoinError).code).toBe('invite_invalid');
    await expect(joinRelay({ code: 'nope', url, home: late, probe: false })).rejects.toThrow(/does not look like an invite code/);
    await expect(joinRelay({ code: inv.code, url: 'ws://127.0.0.1:1', home: late, probe: false })).rejects.toThrow(/cannot reach the relay/);
  });

  it('membership probe: an allowlisted device is recognised (no invite spent), an unknown one is not', async () => {
    const member = freshHome();
    const stranger = freshHome();
    relay = await startFakeRelay({ allowlist: [{ id: loadOrCreateIdentity(member).id, handle: 'mei' }] });
    const url = relay.url;
    expect(await probeMembership(url, loadOrCreateIdentity(member))).toEqual({ handle: 'mei' });
    expect(await probeMembership(url, loadOrCreateIdentity(stranger))).toBe('not-member');
    // join on an already-member device: answered from the probe, never reaches /v1/join
    expect(await joinRelay({ code: 'a'.repeat(32), url, home: member })).toMatchObject({ handle: 'mei', already: true });
    expect(JSON.parse(readFileSync(join(member, '.morse', 'config.json'), 'utf8')).relay).toEqual({ url, handle: 'mei' });
    expect(relay.online()).toEqual([]); // the probe was passive
  });
});
