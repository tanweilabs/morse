import { describe, expect, it } from 'vitest';
import { pickLanAddress } from '../src/cluster/peers.js';

describe('pickLanAddress', () => {
  it('prefers a private IPv4 address over a public one, whatever the order', () => {
    expect(pickLanAddress(['fe80::1', '203.0.113.7', '192.168.4.20'])).toBe('192.168.4.20');
    expect(pickLanAddress(['203.0.113.7', '10.2.3.4'])).toBe('10.2.3.4');
    expect(pickLanAddress(['8.8.8.8', '172.20.1.1'])).toBe('172.20.1.1');
  });

  it('knows where 172.16/12 ends', () => {
    expect(pickLanAddress(['172.15.0.1', '172.16.0.1'])).toBe('172.16.0.1');
    expect(pickLanAddress(['172.32.0.1', '172.31.255.1'])).toBe('172.31.255.1');
    expect(pickLanAddress(['172.32.0.1'])).toBe('172.32.0.1'); // public, but the only usable one
  });

  it('never returns loopback, link-local or proxy TUN (198.18/15) addresses', () => {
    expect(pickLanAddress(['127.0.0.1', '169.254.3.3', '198.18.0.1', '198.19.200.1'])).toBeUndefined();
    expect(pickLanAddress(['198.18.0.1', '100.64.0.9'])).toBe('100.64.0.9');
    expect(pickLanAddress(['198.20.0.1'])).toBe('198.20.0.1');
  });

  it('ignores IPv6 and copes with nothing at all', () => {
    expect(pickLanAddress(['::1', 'fe80::abcd'])).toBeUndefined();
    expect(pickLanAddress([])).toBeUndefined();
  });

  it('takes the first match of a kind', () => {
    expect(pickLanAddress(['10.0.0.1', '192.168.0.1'])).toBe('10.0.0.1');
    expect(pickLanAddress(['1.1.1.1', '9.9.9.9'])).toBe('1.1.1.1');
  });
});
