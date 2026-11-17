import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  isRandomHandle,
  JoinError,
  joinRelay,
  joinWithPairCode,
  normalizePairCode,
  pairCommands,
  planJoin,
  registerRelay,
  requestPairCode,
} from '../src/cluster/join.js';
import { startFakeRelay, type FakeRelay } from './helpers/fake-relay.js';

/**
 * Open registration, pairing codes (ADR-036; nicknames removed, ADR-065) — the client side
 * (src/cluster/join.ts, nicknames.ts) against the in-memory fake relay.
 */

const homes: string[] = [];
const freshHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-reg-'));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

describe('client: morse join (no code / pairing code / invite), morse agent add (pairing code), morse name', () => {
  let relay: FakeRelay | null = null;
  afterEach(async () => {
    await relay?.close();
    relay = null;
  });
  const fakeRelay = async (opts: { register?: boolean } = {}) => {
    relay = await startFakeRelay(opts);
    return relay;
  };

  it('planJoin: nothing → register; invite → invite; address + --code → pair; a readable name is refused with the hint', () => {
    expect(planJoin()).toEqual({ kind: 'register' });
    expect(planJoin('  ')).toEqual({ kind: 'register' });
    expect(planJoin('ABCD-EFGH ijkl mnop qrst uvwx yz23 4567')).toEqual({ kind: 'invite', code: 'abcdefghijklmnopqrstuvwxyz234567' });
    expect(planJoin('morse.talk/k7f3a9xq', 'abcde-fghjk')).toEqual({ kind: 'pair', handle: 'k7f3a9xq', code: 'abcde-fghjk' });
    expect(planJoin('mei', 'abcde-fghjk')).toEqual({ kind: 'pair', handle: 'mei', code: 'abcde-fghjk' });
    expect(planJoin(undefined, 'abcde-fghjk')).toMatchObject({ kind: 'refused', reason: 'needs_handle' });
    const readable = planJoin('alice');
    expect(readable).toMatchObject({ kind: 'refused', reason: 'readable_name' });
    expect((readable as { message: string }).message).toContain('not open yet — ask the Morse admin for an invite code');
    expect((readable as { message: string }).message).toContain('morse join` with nothing after it');
    expect(planJoin('k7f3a9xq')).toMatchObject({ kind: 'refused', reason: 'needs_code', message: expect.stringContaining('morse agent add') });
    expect(planJoin('not an address!')).toMatchObject({ kind: 'refused', reason: 'bad_argument' });
    expect(normalizePairCode(' ABCDE fghjk ')).toBe('abcdefghjk');
    expect(normalizePairCode('abcde-fghji')).toBeNull(); // i is not in the alphabet
    expect(pairCommands('k7f3a9xq', 'abcde-fghjk')).toEqual({
      morse: 'morse join k7f3a9xq --code abcde-fghjk',
      install: 'curl -fsSL https://morse.im/install.sh | bash -s -- k7f3a9xq --code abcde-fghjk',
    });
  });

  it('register → agent add (pairing code) → second computer joins with the code → both under one random handle', async () => {
    const r = await fakeRelay();
    const url = r.url;
    const h1 = freshHome();
    const h2 = freshHome();
    const r1 = await registerRelay({ url, home: h1, agent: 'mini', probe: false });
    expect(isRandomHandle(r1.handle)).toBe(true);
    expect(r1).toMatchObject({ already: false, agent: 'mini' });
    expect(JSON.parse(readFileSync(join(h1, '.morse', 'config.json'), 'utf8')).relay).toEqual({ url, handle: r1.handle, agents: ['mini'], agent: 'mini' });

    const pc = await requestPairCode({ url, home: h1 });
    expect(pc.handle).toBe(r1.handle);
    await expect(joinWithPairCode({ url, home: h2, handle: r1.handle, code: 'abcde-fghjk', probe: false })).rejects.toMatchObject({ code: 'pair_invalid' });
    const r2 = await joinWithPairCode({ url, home: h2, handle: `morse.talk/${r1.handle}`, code: pc.code.toUpperCase(), agent: 'air', probe: false });
    expect(r2).toMatchObject({ handle: r1.handle, already: false, agent: 'air' });
    expect(r.devicesOf(r1.handle)).toHaveLength(2);
    await expect(joinWithPairCode({ url, home: freshHome(), handle: r1.handle, code: pc.code, probe: false })).rejects.toThrow(/wrong, used or expired.*morse agent add/);

    const r3 = await registerRelay({ url, home: freshHome(), probe: false });
    expect(r3.handle).not.toBe(r1.handle);
    await expect(requestPairCode({ url, home: freshHome() })).rejects.toThrow(/has not joined Morse yet/);
  });

  it('old relays: no open registration is a clear error; invites still join', async () => {
    const r = await fakeRelay({ register: false });
    const url = r.url;
    const err = await registerRelay({ url, home: freshHome(), probe: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JoinError);
    expect((err as JoinError).code).toBe('no_registration');
    const { code } = r.createInvite({ handle: 'bob' });
    expect(await joinRelay({ url, home: freshHome(), code, probe: false })).toMatchObject({ handle: 'bob', already: false });
  });
});
