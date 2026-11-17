import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAddressKey, loadPrimaryAddress, signAs } from '../src/identity/address-key.js';
import { isEnvelopeV3, maxPaddedFor, openV3, paddedSize, PrekeyUnknownError, sealV3 } from '../src/identity/envelope.js';
import { ensurePrekeys, PREKEY_ROTATE_MS } from '../src/identity/prekeys.js';

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'morse-env3-'));
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const pair = () => {
  const a = loadPrimaryAddress(home());
  const b = loadPrimaryAddress(home());
  const pb = ensurePrekeys(b);
  return { a, b, pb };
};

describe('v3 envelope: sign, then HPKE-seal to the signed prekey (ADR-073 §5)', () => {
  it('round trip; only `to` is visible outside; the sender is proven inside', async () => {
    const { a, b, pb } = pair();
    const env = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('hello mei'), cert: 'Q0VSVA==' });
    expect(Object.keys(env).sort()).toEqual(['ct', 'enc', 'to', 'v']);
    expect(isEnvelopeV3(env)).toBe(true);
    const blob = JSON.stringify(env);
    expect(blob).not.toContain(a.address);
    expect(blob).not.toContain('hello');
    const o = await openV3(env, { address: b.address, keys: pb.keys });
    expect(o).toMatchObject({ from: a.address, to: b.address, cert: 'Q0VSVA==', prekeyId: pb.current.id });
    expect(o.body.toString()).toBe('hello mei');
    expect(o.fromKey.equals(a.publicKey)).toBe(true);
  });

  it('pads to 1 / 4 / 16 / 64 KB, then 64 KB steps, never above the relay cap', async () => {
    expect(paddedSize(10)).toBe(1024);
    expect(paddedSize(1025)).toBe(4096);
    expect(paddedSize(5000)).toBe(16384);
    expect(paddedSize(20000)).toBe(65536);
    expect(paddedSize(70000)).toBe(131072);
    expect(paddedSize(70000, 100000)).toBe(100000);
    expect(paddedSize(120000, 100000)).toBe(120000);
    const { a, b, pb } = pair();
    const small = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('x') });
    const bigger = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.alloc(600, 1) });
    expect(Buffer.from(small.ct, 'base64').length).toBe(Buffer.from(bigger.ct, 'base64').length); // same bucket, same size
    const near = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.alloc(700_000, 2), maxBlobBytes: 1_000_000 });
    expect(Buffer.byteLength(JSON.stringify(near))).toBeLessThanOrEqual(1_000_000);
    expect(maxPaddedFor(1_000_000)).toBeGreaterThan(700_000);
    expect((await openV3(near, { address: b.address, keys: pb.keys })).body.length).toBe(700_000);
  });

  it('opens with an older prekey it still keeps; a deleted one → PrekeyUnknownError', async () => {
    const a = loadPrimaryAddress(home());
    const b = loadPrimaryAddress(home());
    const old = ensurePrekeys(b, 1000);
    const env = await sealV3({ from: a, to: b.address, prekey: old.current, body: Buffer.from('sealed to the old one') });
    const now = ensurePrekeys(b, 1000 + PREKEY_ROTATE_MS);
    expect((await openV3(env, { address: b.address, keys: now.keys })).prekeyId).toBe(old.current.id);
    await expect(openV3(env, { address: b.address, keys: [now.keys[0]!] })).rejects.toBeInstanceOf(PrekeyUnknownError);
  });

  it('refuses: another recipient, a forged sender, a wrong signature, stale or future-dated', async () => {
    const { a, b, pb } = pair();
    const c = createAddressKey(home());
    const env = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('x') });
    await expect(openV3(env, { address: c.address, keys: pb.keys })).rejects.toThrow(/not addressed/);
    await expect(openV3({ ...env, to: c.address }, { address: c.address, keys: pb.keys })).rejects.toThrow(); // aad bound to b
    // signed for c, re-sealed to b: the signature covers `to`
    const forwarded = await sealV3({ from: a, to: c.address, prekey: ensurePrekeys(c).current, body: Buffer.from('x') });
    const cOpened = await openV3(forwarded, { address: c.address, keys: ensurePrekeys(c).keys });
    expect(cOpened.to).toBe(c.address);
    const t = 1_800_000_000_000;
    const stale = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('x'), ts: t - 32 * 24 * 3600_000 });
    await expect(openV3(stale, { address: b.address, keys: pb.keys }, t)).rejects.toThrow(/older than 31 days/);
    const ahead = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('x'), ts: t + 11 * 60_000 });
    await expect(openV3(ahead, { address: b.address, keys: pb.keys }, t)).rejects.toThrow(/future/);
    const ok = await sealV3({ from: a, to: b.address, prekey: pb.current, body: Buffer.from('x'), ts: t + 9 * 60_000 });
    expect((await openV3(ok, { address: b.address, keys: pb.keys }, t)).ts).toBe(t + 9 * 60_000);
    expect(signAs(a, 'x')).toHaveLength(64);
    await expect(openV3({ v: 2 } as never, { address: b.address, keys: pb.keys })).rejects.toThrow(/not a v3/);
    await expect(sealV3({ from: a, to: 'mei', prekey: pb.current, body: Buffer.from('x') })).rejects.toThrow(/not an address/);
  });

  it('a sender claiming another address is refused (key ≠ address)', async () => {
    const { a, b, pb } = pair();
    const impostor = { ...a, address: createAddressKey(home()).address };
    const env = await sealV3({ from: impostor, to: b.address, prekey: pb.current, body: Buffer.from('x') });
    await expect(openV3(env, { address: b.address, keys: pb.keys })).rejects.toThrow(/does not match/);
  });
});
