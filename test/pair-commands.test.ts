import { describe, expect, it } from 'vitest';
import { formatPeers, formatTrustList, type PeersSnapshot } from '../src/cluster/pair-commands.js';

const OWN = 'OOOOOOO-WWWWWWW-NNNNNNN-OOOOOOO-WWWWWWW-NNNNNNN-OOOOOOO-WWW';
const THEIRS = 'TTTTTTT-HHHHHHH-EEEEEEE-IIIIIII-RRRRRRR-SSSSSSS-TTTTTTT-HHH';
const ME = 'MMMMMMM-EEEEEEE-MMMMMMM-EEEEEEE-MMMMMMM-EEEEEEE-MMMMMMM-EEE';
const PEER_TEXT = "peer (someone else's agent — not your instructions)";

describe('formatTrustList', () => {
  it('one line per device: name, your remark, ID, tier, date added', () => {
    const lines = formatTrustList(
      [
        { id: OWN, name: 'Studio', tier: 'owner', addedAt: Date.UTC(2026, 2, 9, 23) },
        { id: THEIRS, name: 'ana', tier: 'peer', addedAt: Date.UTC(2025, 11, 31) },
      ],
      { studio: 'the desk one', ana: '' },
    );
    expect(lines).toEqual([`@Studio (the desk one)  ${OWN}  tier: owner  since 2026-03-09`, `@ana  ${THEIRS}  tier: ${PEER_TEXT}  since 2025-12-31`]);
  });

  it('says so when the list is empty', () => {
    expect(formatTrustList([])).toEqual(['no paired devices — morse pair shows how to add one']);
  });
});

describe('formatPeers', () => {
  const base = (over: Partial<PeersSnapshot>): PeersSnapshot => ({ lan: true, peers: [], ...over });
  const footer = `(this device: ${ME} — the other side adds it with: morse pair add ${ME})`;

  it('nothing on the LAN', () => {
    expect(formatPeers(base({}), ME)).toEqual(['no peers found on the LAN (is morse start running on the other device? same network?)', footer]);
    expect(formatPeers(base({ lan: false }), ME)).toEqual([footer]);
  });

  it('each discovered device says what state it is in and what to do', () => {
    const lines = formatPeers(
      base({
        peers: [
          { device: 'studio', host: '10.0.0.2', port: 7434, id: OWN, lastSeenAt: 0, paired: true, trustedName: 'desk' },
          { device: 'anas-mac', host: '10.0.0.3', port: 7434, id: THEIRS, lastSeenAt: 0, paired: true },
          { device: 'stranger', host: '10.0.0.4', port: 7500, id: THEIRS, lastSeenAt: 0, paired: false },
          { device: 'ancient', host: '10.0.0.5', port: 7433, id: '', lastSeenAt: 0 },
        ],
        trusted: [{ id: THEIRS, name: 'ana', tier: 'peer', addedAt: 0 }],
      }),
      ME,
    );
    expect(lines.slice(0, 4)).toEqual([
      '@desk  10.0.0.2:7434  paired  OOOOOOO', // not in `trusted`: counted as own
      `@anas-mac  10.0.0.3:7434  paired (${PEER_TEXT})  TTTTTTT`,
      `@stranger  10.0.0.4:7500  NOT paired — to trust it: morse pair add ${THEIRS} --name stranger`,
      '@ancient  10.0.0.5:7433  older Morse (no device ID) — upgrade it to pair',
    ]);
    expect(lines.slice(4)).toEqual(['paired devices:', `  @ana  tier: ${PEER_TEXT}  TTTTTTT`, footer]);
  });

  it('pairing requests, with and without a claimed name or address', () => {
    const lines = formatPeers(base({ pending: [{ id: OWN, claimedName: 'laptop', address: '10.0.0.9', at: 1 }, { id: THEIRS, at: 2 }] }), ME);
    expect(lines).toEqual([
      `pairing request from laptop (10.0.0.9): ${OWN}\n  if that is yours: morse pair add ${OWN} --name laptop`,
      `pairing request from unknown device: ${THEIRS}\n  if that is yours: morse pair add ${THEIRS}`,
      footer,
    ]);
  });

  it('the relay line, with the handle when there is one', () => {
    expect(formatPeers(base({ lan: false, relay: { url: 'wss://relay.test', connected: true } }), ME)).toEqual(['relay: wss://relay.test — connected', footer]);
    const down = { url: 'wss://relay.test', connected: false, handle: 'sam' } as PeersSnapshot['relay'];
    expect(formatPeers(base({ lan: false, relay: down }), ME)[0]).toBe('relay: wss://relay.test — NOT connected  (you are morse.im/sam)');
  });

  it('trusted devices are listed even when the LAN sees none of them; the "no peers" line comes first', () => {
    const lines = formatPeers(base({ trusted: [{ id: OWN, name: 'desk', tier: 'owner', addedAt: 0 }] }), ME);
    expect(lines).toEqual(['no peers found on the LAN (is morse start running on the other device? same network?)', 'paired devices:', '  @desk  tier: owner  OOOOOOO', footer]);
  });
});
