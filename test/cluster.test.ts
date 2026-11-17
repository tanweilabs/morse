import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { getDeviceName, setDeviceName } from '../src/cluster/device.js';
import { routeForMessage } from '../src/cluster/routing.js';
import { resolveTarget } from '../src/directory/resolve.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

const made: string[] = [];
const tempHome = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'morse-devname-'));
  made.push(d);
  return d;
};
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('this computer\'s name', () => {
  it('comes from the host name\'s first label, in lower case, and is stored the first time', () => {
    const h = tempHome();
    const expected = (hostname().split('.')[0] ?? '').toLowerCase();
    expect(getDeviceName(h)).toBe(expected);
    expect(readFileSync(join(h, '.morse', 'device-name'), 'utf8')).toBe(`${expected}\n`);
  });

  it('a stored name wins (trimmed); a blank file falls back to the host name', () => {
    const h = tempHome();
    setDeviceName('  Studio  ', h);
    expect(readFileSync(join(h, '.morse', 'device-name'), 'utf8')).toBe('Studio\n');
    expect(getDeviceName(h)).toBe('Studio');
    writeFileSync(join(h, '.morse', 'device-name'), '  \n');
    expect(getDeviceName(h)).toBe((hostname().split('.')[0] ?? '').toLowerCase());
  });

  it('setDeviceName creates the data directory when missing', () => {
    const h = tempHome();
    setDeviceName('air', h);
    expect(getDeviceName(h)).toBe('air');
  });
});

describe('routeForMessage', () => {
  const to = (device?: string) => ({ to: device === undefined ? {} : { device } });
  it('is local without a device, with a blank one, or with this device in any case', () => {
    for (const d of [undefined, '', '   ', 'studio', 'STUDIO', ' Studio ']) expect(routeForMessage(to(d), 'studio')).toEqual({ kind: 'local' });
  });
  it('relays to any other device, trimmed', () => {
    expect(routeForMessage(to(' air '), 'studio')).toEqual({ kind: 'relay', device: 'air' });
    expect(routeForMessage(to('air'), '')).toEqual({ kind: 'relay', device: 'air' });
  });
});

describe('sessions on another device', () => {
  const A = '11111111-0000-4000-8000-00000000000a';
  const B = '22222222-0000-4000-8000-00000000000b';

  it('the mailbox stores the device of either end and keeps conversations per device apart', () => {
    const mailbox = createMailbox(createDb(':memory:'));
    const here = mailbox.send({ from: { agent: 'claude', sessionId: A }, to: { agent: 'codex', sessionId: B }, text: 'here' });
    const there = mailbox.send({ from: { agent: 'claude', sessionId: A }, to: { agent: 'codex', sessionId: B, device: 'air' }, text: 'there' });
    expect(mailbox.getMessage(there.id)?.to.device).toBe('air');
    expect(mailbox.getMessage(here.id)?.to.device).toBeUndefined();
    expect(there.from.device).toBeUndefined();
    expect(there.conversationId).not.toBe(here.conversationId);
  });

  it('a target with @device/ resolves only among that device\'s sessions (any case); without one, only local ones', () => {
    const list: SessionInfo[] = [
      { agent: 'codex', sessionId: A, title: 'api server', cwd: '/w/api', lastActiveAt: 10 },
      { agent: 'codex', sessionId: B, title: 'api server', cwd: '/w/api', lastActiveAt: 20, device: 'air' },
    ];
    const local = resolveTarget('@codex:api', list);
    expect(local.ok && local.session.sessionId).toBe(A);
    const remote = resolveTarget('@AIR/codex:api', list);
    expect(remote.ok && remote.session.sessionId).toBe(B);
    const nowhere = resolveTarget('@nas/codex:api', list);
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.reason).toBe('not_found');
  });
});
