import { describe, expect, it } from 'vitest';
import { aliasKey, entriesFor, lookupAlias, normalizeAliasName, parseAliasRecord, type AliasRecord } from '../src/aliases.js';
import { ALIAS_PREFIX, listDeviceIds } from '../src/allowlist.js';

/**
 * The frozen old-alias table (identity v3 P2, spec §7 / §12.3 step 4) — pure logic: how a
 * typed old name is read, what a stored record must look like, and what a query answers.
 * The real Worker (WS `alias` frame, GET /v3/alias/…) is in aliases-wrangler.test.ts; how
 * the table is built and verified is in scripts/test/aliases-export.test.ts.
 */

// fixed, valid 26-character addresses (the alphabet has no 0 1 i l o u)
const MINI = '6rdv5398dn85jpw5cf4gaewrx3';
const AIR = 'vsng57czvsjy26zpsbgn9m8m9v';
const PRO = 'nwtc6ffhvk7tjccteyk2vjeg99';

const alice: AliasRecord = { v: 1, handle: 'alice', default: 'mini', agents: { mini: MINI, air: AIR, claude: MINI, zed: PRO } };

const fakeKv = (data: Record<string, unknown>) => ({
  async get(key: string, _type: 'json'): Promise<unknown> {
    const v = data[key];
    if (v instanceof Error) throw v;
    return v === undefined ? null : v;
  },
});

describe('normalizeAliasName', () => {
  it('reads a handle or handle/agent', () => {
    expect(normalizeAliasName('alice')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('alice/air')).toEqual({ handle: 'alice', agent: 'air' });
    expect(normalizeAliasName('k7f3a9xq')).toEqual({ handle: 'k7f3a9xq' });
    expect(normalizeAliasName('a_b-c/x-1')).toEqual({ handle: 'a_b-c', agent: 'x-1' });
    expect(normalizeAliasName('ab/a')).toEqual({ handle: 'ab', agent: 'a' });
  });

  it('strips case, a leading @, a host prefix and trailing slashes', () => {
    expect(normalizeAliasName('  Alice/AIR  ')).toEqual({ handle: 'alice', agent: 'air' });
    expect(normalizeAliasName('@alice')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('morse.im/alice')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('morse.talk/Alice/Air/')).toEqual({ handle: 'alice', agent: 'air' });
    expect(normalizeAliasName('https://morse.im/alice/air')).toEqual({ handle: 'alice', agent: 'air' });
    expect(normalizeAliasName('HTTPS://MORSE.TALK/ALICE//')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('http://127.0.0.1:8787/alice')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('@morse.im/@alice/')).toEqual({ handle: 'alice' });
    expect(normalizeAliasName('relay.example.org/alice/air')).toEqual({ handle: 'alice', agent: 'air' });
  });

  it('refuses everything else', () => {
    for (const bad of ['', ' ', 'a', '-alice', '/alice', 'alice//air', 'alice/air/x', 'alice/-air', 'alice/air-', 'alice/a_b', 'al ice', 'alice?x=1', 'a'.repeat(33), `alice/${'a'.repeat(33)}`, 'morse.im/', 'https://', 'älice', 'alice/@air']) {
      expect(normalizeAliasName(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 7, {}, ['alice']]) expect(normalizeAliasName(bad)).toBeNull();
  });

  it('a trailing slash after a handle is the bare handle', () => {
    expect(normalizeAliasName('alice/')).toEqual({ handle: 'alice' });
  });
});

describe('parseAliasRecord', () => {
  it('accepts a well-formed record and returns only its known fields', () => {
    expect(parseAliasRecord({ ...alice, extra: 1 })).toEqual(alice);
    expect(parseAliasRecord({ v: 1, handle: 'bob', default: null, agents: { pro: PRO } })).toEqual({ v: 1, handle: 'bob', default: null, agents: { pro: PRO } });
    expect(parseAliasRecord(JSON.parse(JSON.stringify(alice)))).toEqual(alice);
  });

  it('refuses anything that is not exactly a v1 record', () => {
    const bad: unknown[] = [
      null,
      'x',
      [],
      { ...alice, v: 2 },
      { ...alice, v: '1' },
      { ...alice, handle: 'Alice' },
      { ...alice, handle: 'a' },
      { ...alice, handle: undefined },
      { ...alice, default: 'nope' }, // not a key of agents
      { ...alice, default: undefined },
      { ...alice, default: 7 },
      { ...alice, default: 'constructor' },
      { ...alice, agents: null },
      { ...alice, agents: [MINI] },
      { ...alice, agents: { ...alice.agents, 'Bad_Name': AIR } },
      { ...alice, agents: { ...alice.agents, air: AIR.toUpperCase() } }, // stored lowercase only
      { ...alice, agents: { ...alice.agents, air: AIR.slice(1) } },
      { ...alice, agents: { ...alice.agents, air: `${AIR.slice(1)}0` } }, // 0 is not in the alphabet
      { ...alice, agents: { ...alice.agents, air: 7 } },
      { ...alice, agents: { ...alice.agents, air: null } },
    ];
    for (const b of bad) expect(parseAliasRecord(b), JSON.stringify(b)).toBeNull();
  });
});

describe('entriesFor', () => {
  it('bare handle: every agent, the default first under the bare name, the rest by agent name', () => {
    expect(entriesFor(alice)).toEqual([
      { name: 'alice', address: MINI, agent: 'mini', default: true },
      { name: 'alice/air', address: AIR, agent: 'air' },
      { name: 'alice/claude', address: MINI, agent: 'claude' }, // same device as mini: same address
      { name: 'alice/zed', address: PRO, agent: 'zed' },
    ]);
  });

  it('handle/agent: that one entry (0 or 1); the default agent also answers to its own name', () => {
    expect(entriesFor(alice, 'air')).toEqual([{ name: 'alice/air', address: AIR, agent: 'air' }]);
    expect(entriesFor(alice, 'mini')).toEqual([{ name: 'alice/mini', address: MINI, agent: 'mini', default: true }]);
    expect(entriesFor(alice, 'nobody')).toEqual([]);
    // names that exist on every JS object are not agents
    expect(entriesFor(alice, 'constructor')).toEqual([]);
    expect(entriesFor(alice, 'tostring')).toEqual([]);
  });

  it('no default: no default:true entry, agents sorted by name', () => {
    const r: AliasRecord = { v: 1, handle: 'bob', default: null, agents: { pro: PRO, air: AIR } };
    expect(entriesFor(r)).toEqual([
      { name: 'bob/air', address: AIR, agent: 'air' },
      { name: 'bob/pro', address: PRO, agent: 'pro' },
    ]);
    expect(entriesFor(r, 'pro')).toEqual([{ name: 'bob/pro', address: PRO, agent: 'pro' }]);
    expect(entriesFor({ v: 1, handle: 'nil', default: null, agents: {} })).toEqual([]);
  });
});

describe('lookupAlias (KV: alias:<handle> → record, read-only)', () => {
  const kv = fakeKv({
    [aliasKey('alice')]: alice,
    [aliasKey('bob')]: { v: 1, handle: 'bob', default: 'pro', agents: { pro: PRO } },
    [aliasKey('broken')]: { v: 1, handle: 'broken', default: 'x', agents: {} },
    [aliasKey('moved')]: { ...alice }, // a record stored under another handle's key
    [aliasKey('boom')]: new Error('kv down'),
    // what else lives in the namespace: a device entry and a handle index
    'ABCDEFG-HIJKLMN': { handle: 'alice', name: 'mini' },
    '@alice': ['ABCDEFG-HIJKLMN'],
  });

  it('the key', () => {
    expect(ALIAS_PREFIX).toBe('alias:');
    expect(aliasKey('alice')).toBe('alias:alice');
  });

  it('bare handle, handle/agent, the default by handle/agent', async () => {
    expect(await lookupAlias(kv, 'alice')).toEqual({ name: 'alice', entries: entriesFor(alice) });
    expect(await lookupAlias(kv, 'alice/air')).toEqual({ name: 'alice/air', entries: [{ name: 'alice/air', address: AIR, agent: 'air' }] });
    expect(await lookupAlias(kv, 'alice/mini')).toEqual({ name: 'alice/mini', entries: [{ name: 'alice/mini', address: MINI, agent: 'mini', default: true }] });
    expect(await lookupAlias(kv, 'bob')).toEqual({ name: 'bob', entries: [{ name: 'bob', address: PRO, agent: 'pro', default: true }] });
  });

  it('the name is normalized before the lookup and in the answer', async () => {
    expect(await lookupAlias(kv, 'https://morse.im/Alice/AIR/')).toEqual({ name: 'alice/air', entries: [{ name: 'alice/air', address: AIR, agent: 'air' }] });
    expect((await lookupAlias(kv, '@MORSE.TALK/ALICE'))?.name).toBe('alice');
  });

  it('unknown names are an empty list, not an error', async () => {
    expect(await lookupAlias(kv, 'nobody')).toEqual({ name: 'nobody', entries: [] });
    expect(await lookupAlias(kv, 'alice/nobody')).toEqual({ name: 'alice/nobody', entries: [] });
    expect(await lookupAlias(kv, 'nobody/air')).toEqual({ name: 'nobody/air', entries: [] });
  });

  it('a bad name is null (the caller answers "bad alias name")', async () => {
    expect(await lookupAlias(kv, 'alice/air/x')).toBeNull();
    expect(await lookupAlias(kv, '')).toBeNull();
    expect(await lookupAlias(kv, 42)).toBeNull();
  });

  it('a malformed, misplaced or unreadable record answers nothing rather than something wrong', async () => {
    expect(await lookupAlias(kv, 'broken')).toEqual({ name: 'broken', entries: [] });
    expect(await lookupAlias(kv, 'moved')).toEqual({ name: 'moved', entries: [] });
    expect(await lookupAlias(kv, 'boom')).toEqual({ name: 'boom', entries: [] });
  });
});

describe('the allowlist listing ignores alias records', () => {
  it('listDeviceIds: every page, without @handle indexes and alias: keys', async () => {
    const pages: Array<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> = [
      { keys: [{ name: '@alice' }, { name: 'AAAAAAA-1' }, { name: 'alias:alice' }], list_complete: false, cursor: 'p2' },
      { keys: [{ name: 'alias:bob' }, { name: 'BBBBBBB-2' }], list_complete: false, cursor: 'p3' },
      { keys: [{ name: 'CCCCCCC-3' }, { name: '@bob' }], list_complete: true },
    ];
    const cursors: Array<string | undefined> = [];
    const kv = {
      async list(opts?: { cursor?: string }) {
        cursors.push(opts?.cursor);
        return pages[cursors.length - 1]!;
      },
    };
    expect(await listDeviceIds(kv)).toEqual(['AAAAAAA-1', 'BBBBBBB-2', 'CCCCCCC-3']);
    expect(cursors).toEqual([undefined, 'p2', 'p3']);
  });
});
