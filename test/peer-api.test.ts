import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { createPeerApiHandler, type MorseInbound, type PeerApiOptions } from '../src/cluster/peer-api.js';
import type { TrustedDevice } from '../src/cluster/trust.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';

const desk: TrustedDevice = { id: 'DESK', name: 'desk', tier: 'owner', addedAt: 0 };
const ana: TrustedDevice = { id: 'ANA', name: 'ana', tier: 'peer', addedAt: 0 };
const mine: SessionInfo[] = [{ agent: 'codex', sessionId: 'c-1', title: 'api', cwd: '/w/api', lastActiveAt: 9 }];

/** A handler plus a way to call it with a body (string = raw bytes, else JSON) and read the answer. */
function harness(extra: Partial<PeerApiOptions> = {}) {
  const mailbox = createMailbox(createDb(':memory:'));
  let changed = 0;
  const handler = createPeerApiHandler({ selfDevice: 'studio', mailbox, localDirectory: async () => mine, onChange: () => void changed++, ...extra });
  const call = async (caller: TrustedDevice, method: string, url: string, body?: unknown) => {
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
    const req = Object.assign((async function* () { yield* raw; })(), { method, url });
    const answer = { status: 0, type: '', json: undefined as unknown };
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        answer.status = status;
        answer.type = headers['content-type'] ?? '';
      },
      end(text: string) {
        answer.json = JSON.parse(text);
      },
    };
    await handler(req as never, res as never, caller);
    return answer;
  };
  return { mailbox, call, changes: () => changed };
}

const plain = (over: Record<string, unknown> = {}) => ({ from: { agent: 'claude', sessionId: 'far-1' }, to: { agent: 'codex', sessionId: 'c-1' }, text: 'ping', ...over });

describe('peer API: info and sessions', () => {
  it('GET /api/peer/info names this device (and its ID when known), JSON typed', async () => {
    expect(await harness().call(desk, 'GET', '/api/peer/info')).toEqual({ status: 200, type: 'application/json; charset=utf-8', json: { device: 'studio' } });
    expect((await harness({ selfId: 'SELF' }).call(ana, 'GET', '/api/peer/info?v=1')).json).toEqual({ device: 'studio', id: 'SELF' });
  });

  it('own devices may list the local sessions; someone else\'s never can, by any method', async () => {
    const h = harness();
    expect(await h.call(desk, 'GET', '/api/peer/sessions')).toMatchObject({ status: 200, json: { sessions: mine } });
    for (const method of ['GET', 'POST']) expect(await h.call(ana, method, '/api/peer/sessions')).toMatchObject({ status: 403, json: { error: 'peer-tier devices may only send messages' } });
    expect((await h.call(desk, 'POST', '/api/peer/sessions')).status).toBe(404);
  });

  it('anything else is 404', async () => {
    const h = harness();
    expect(await h.call(desk, 'GET', '/elsewhere')).toMatchObject({ status: 404, json: { error: 'not found' } });
    expect((await h.call(desk, 'POST', '/api/peer/collab', {})).status).toBe(404);
  });
});

describe('peer API: POST /api/peer/messages', () => {
  it('files the message under the trusted device name, whatever the body claims', async () => {
    const h = harness();
    const r = await h.call(desk, 'POST', '/api/peer/messages', plain({ from: { agent: 'claude', sessionId: 'far-1', device: 'forged' }, contextId: 'thread-7' }));
    expect(r.status).toBe(201);
    const [m] = h.mailbox.inbox();
    expect(m).toMatchObject({ from: { agent: 'claude', sessionId: 'far-1', device: 'desk' }, to: { agent: 'codex', sessionId: 'c-1' }, fromTier: 'owner', contextId: 'thread-7' });
    expect((r.json as { message: { id: string } }).message.id).toBe(m!.id);
    expect(h.changes()).toBe(1);
  });

  it('from someone else\'s device: tier peer, the named session dropped for the inbox, filed under their contact', async () => {
    const h = harness();
    expect((await h.call(ana, 'POST', '/api/peer/messages', plain({ contextId: '' }))).status).toBe(201);
    const [m] = h.mailbox.inbox();
    expect(m).toMatchObject({ fromTier: 'peer', to: { agent: 'codex', sessionId: 'inbox' }, from: { device: 'ana' }, contactId: 'c:ana' });
  });

  it('refuses a body without both session refs (non-empty ids) and a text', async () => {
    const h = harness();
    const bad = [{}, plain({ text: 7 }), plain({ from: { agent: 'claude', sessionId: '' } }), plain({ to: { agent: 'codex' } }), plain({ to: 'codex' })];
    for (const body of bad) expect(await h.call(desk, 'POST', '/api/peer/messages', body)).toMatchObject({ status: 400, json: { error: 'expected {contextId?, from, to, text}' } });
    expect((await h.call(desk, 'POST', '/api/peer/messages', '')).status).toBe(400); // empty body = {}
    expect(h.mailbox.inbox()).toEqual([]);
    expect(h.changes()).toBe(0);
  });

  it('throws (for the transport to answer) on bad JSON or a body over 5 MiB', async () => {
    const h = harness();
    await expect(h.call(desk, 'POST', '/api/peer/messages', '{nope')).rejects.toThrow();
    await expect(h.call(desk, 'POST', '/api/peer/messages', 'x'.repeat(5 * 1024 * 1024 + 1))).rejects.toThrow('request body too large');
  });
});

describe('peer API: Morse hand-over (/api/peer/morse, /api/peer/morse3)', () => {
  const recorder = () => {
    const got: Array<[string, unknown]> = [];
    const inbound: MorseInbound = async (peer, body) => {
      got.push([peer.name, body]);
      return { status: 202, body: { request: 'filed' } };
    };
    return { got, inbound };
  };

  it('404 while Morse is not running here', async () => {
    const h = harness({ morseInbound: () => undefined });
    expect(await h.call(desk, 'POST', '/api/peer/morse', { kind: 'message' })).toMatchObject({ status: 404, json: { error: 'Morse is not enabled on this device' } });
    expect((await harness().call(desk, 'POST', '/api/peer/morse3', { sealedV3: {} })).status).toBe(404);
  });

  it('passes the body and the caller through, and answers with what the Morse layer said', async () => {
    const { got, inbound } = recorder();
    const h = harness({ morseInbound: () => inbound });
    expect(await h.call(ana, 'POST', '/api/peer/morse', { kind: 'message', id: 'm1' })).toMatchObject({ status: 202, json: { request: 'filed' } });
    expect((await h.call(desk, 'POST', '/api/peer/morse3', { sealedV3: { v: 3 } })).status).toBe(202);
    expect((await h.call(desk, 'POST', '/api/peer/morse', '')).status).toBe(202); // empty body = {}
    expect(got).toEqual([['ana', { kind: 'message', id: 'm1' }], ['desk', { sealedV3: { v: 3 } }], ['desk', {}]]);
  });

  it('keeps sealed and plain apart', async () => {
    const { got, inbound } = recorder();
    const h = harness({ morseInbound: () => inbound });
    expect(await h.call(desk, 'POST', '/api/peer/morse', { sealedV3: {} })).toMatchObject({ status: 400, json: { error: 'a sealed envelope goes to /api/peer/morse3' } });
    for (const body of [{ kind: 'message' }, 'null', '"text"'])
      expect(await h.call(desk, 'POST', '/api/peer/morse3', body)).toMatchObject({ status: 400, json: { error: 'expected {sealedV3: <v3 envelope>}' } });
    expect((await h.call(desk, 'GET', '/api/peer/morse')).status).toBe(404);
    expect(got).toEqual([]);
  });
});
