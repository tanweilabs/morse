import { allowEntry, devicesOfHandle, listDeviceIds, putDevice, removeDevice, type AllowEntry } from './allowlist.js';
import { lookupAlias } from './aliases.js';
import { AgentBook } from './agent-book.js';
import { AddressHub, addressHub } from './address-hub.js';
import { normalizeAddress } from './address.js';
import { PROTOCOLS } from './v3.js';
import { verifyAgentOp, verifyProfile } from './crypto.js';
import { DeviceHub, agentBook, limitsFromEnv, normalizeHandle, type Env } from './hub.js';
import { InviteBook } from './invite-book.js';
import { IpBucket } from './ip-bucket.js';
import { AGENT_OPS, JOIN_MAX_SKEW_MS, normalizeId, type KeyBundle } from './protocol.js';
import { registerSettingsFromEnv } from './register.js';

export { AddressHub, AgentBook, DeviceHub, InviteBook, IpBucket };

/**
 * Routes:
 *   GET  /healthz                      → "ok" + limits (JSON); `aliases: true` = this relay answers alias queries
 *   GET  /v1/ws/<deviceId>  (Upgrade)  → that device's DeviceHub
 *   GET  /v3/ws/<address>   (Upgrade)  → that address's AddressHub (v3, ADR-073; see v3.ts)
 *   GET  /v3/alias/<handle>[/<agent>]  → {name, entries:[{name, address, agent, default?}]}: a frozen old
 *                                        name → the v3 address(es) it meant (public, read-only; 404 with
 *                                        the same body when there is none; see aliases.ts)
 *   GET  /admin/allowlist                       → list    ┐ require `Authorization: Bearer <ADMIN_KEY>`;
 *   PUT  /admin/allowlist/<id> {handle, name?}  → add     │ the whole /admin tree is 404 when
 *   DELETE /admin/allowlist/<id>                → remove  │ ADMIN_KEY is not set (use `wrangler kv key put`)
 *   POST /admin/invites {handle, uses?, ttlSec?, note?} → {code, id, …}  (code shown once)
 *   GET  /admin/invites                         → live invites (no codes) │
 *   DELETE /admin/invites/<id>                  → revoke  ┘
 *   GET  /admin/agents/<handle>                 → that person's agent directory
 *   DELETE /admin/agents/<handle>/<agent>       → free an agent name
 *   GET  /admin/handles/<handle>                → devices, agents, nickname, claim  (ADR-036);
 *                                                 `?certs=1` adds each device's certificate (`cert`: base64
 *                                                 DER from its key bundle, null when it never uploaded one)
 *                                                 — what scripts/aliases-export.mjs builds the alias table from
 *   DELETE /admin/handles/<handle>              → release it: devices off the allowlist (and
 *                                                 disconnected), agents + nickname wiped
 *   POST /v1/join {code, cert, ts, sig, name?, agent?}  → redeem an invite (public; see invites.ts)
 *   POST /v1/join {handle, code, cert, ts, sig, …}      → join a handle with a pairing code (register.ts)
 *   POST /v1/register {cert, ts, sig, name?, agent?}    → open registration: a new random handle (ADR-036)
 *   POST /v1/pair-code {cert, ts, sig}                  → a member device gets a one-time pairing code
 *   POST /v1/profile {nickname, cert, ts, sig}          → set this device's person's display nickname
 *   POST /v1/agents {op, agent?, to?, cert, ts, sig}    → manage this device's person's agents
 *                                                         (public, signed by the device; ADR-033)
 *
 * KV layout (what `wrangler kv key put` must write by hand):
 *   <deviceId>  → {"handle":"mei","name":"mac-mini","addedAt":"…"}
 *   @<handle>   → ["<deviceId>", …]           (index: a person's devices)
 *   alias:<handle> → {"v":1,"handle":…,"default":…,"agents":{<agent>: <address>}}   the frozen old-alias
 *                    table (aliases.ts): loaded once with `wrangler kv bulk put`; the Worker never writes it
 */

const text = (body: string, status = 200): Response => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

async function admin(request: Request, env: Env, path: string): Promise<Response> {
  if (!env.ADMIN_KEY) return text('not found', 404);
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || !constantTimeEqual(auth.slice(7), env.ADMIN_KEY)) return text('unauthorized', 401);

  if (path === '/admin/allowlist' && request.method === 'GET') {
    // device entries only: not the @handle indexes, not the alias records in the same namespace
    const ids = await listDeviceIds(env.ALLOWLIST);
    const devices = await Promise.all(ids.map(async (id) => ({ id, ...((await allowEntry(env.ALLOWLIST, id)) ?? {}) })));
    return Response.json({ devices });
  }
  const m = /^\/admin\/allowlist\/([^/]+)$/.exec(path);
  if (m) {
    const id = normalizeId(decodeURIComponent(m[1]!));
    if (!id) return text('bad device id', 400);
    if (request.method === 'PUT') {
      let body: { name?: unknown; handle?: unknown } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        /* no body */
      }
      const handle = typeof body.handle === 'string' && body.handle ? normalizeHandle(body.handle) : undefined;
      if (handle === null) return text('bad handle (2–32 of a-z 0-9 - _)', 400);
      if (handle && registerSettingsFromEnv(env).reserved.includes(handle)) return text(`"${handle}" is a reserved name`, 400);
      const entry: AllowEntry = { ...(handle ? { handle } : {}), name: String(body.name ?? '').slice(0, 80), addedAt: new Date().toISOString(), via: 'admin' };
      await putDevice(env.ALLOWLIST, id, entry);
      return Response.json({ id, ...entry });
    }
    if (request.method === 'DELETE') {
      const was = await allowEntry(env.ALLOWLIST, id);
      await removeDevice(env.ALLOWLIST, id);
      // its agents leave with it (ADR-033)
      const dropped = was?.handle
        ? ((await (await agentBook(env, was.handle).fetch('https://agents/drop', { method: 'POST', body: JSON.stringify({ handle: was.handle, device: id }) })).json()) as { dropped: string[] }).dropped
        : [];
      return Response.json({ id, removed: true, droppedAgents: dropped });
    }
  }
  const ag = /^\/admin\/agents\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (ag) {
    const handle = normalizeHandle(decodeURIComponent(ag[1]!));
    if (!handle) return text('bad handle', 400);
    const book = agentBook(env, handle);
    if (!ag[2] && request.method === 'GET') return book.fetch('https://agents/list');
    if (ag[2] && request.method === 'DELETE') {
      return book.fetch('https://agents/admin-remove', { method: 'POST', body: JSON.stringify({ agent: decodeURIComponent(ag[2]) }) });
    }
  }
  const hd = /^\/admin\/handles\/([^/]+)$/.exec(path);
  if (hd) {
    const handle = normalizeHandle(decodeURIComponent(hd[1]!));
    if (!handle) return text('bad handle', 400);
    const book = agentBook(env, handle);
    if (request.method === 'GET') {
      const ids = await devicesOfHandle(env.ALLOWLIST, handle);
      // ?certs=1 (read-only): the certificate each device uploaded with its key bundle
      const withCerts = new URL(request.url).searchParams.get('certs') === '1';
      const certOf = async (id: string): Promise<string | null> =>
        (await (await env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id)).fetch('https://hub/bundle')).json<KeyBundle | null>())?.cert ?? null;
      const devices = await Promise.all(
        ids.map(async (id) => ({ id, ...((await allowEntry(env.ALLOWLIST, id)) ?? {}), ...(withCerts ? { cert: await certOf(id) } : {}) })),
      );
      const dir = (await (await book.fetch('https://agents/list')).json()) as Record<string, unknown>;
      const { claim } = (await (await invites(env).fetch(`https://invites/handles/${encodeURIComponent(handle)}`)).json()) as { claim: unknown };
      return Response.json({ handle, devices, ...dir, claim });
    }
    if (request.method === 'DELETE') {
      // all devices lost (ADR-036): no self-service recovery — the admin frees the handle
      const r = (await (await invites(env).fetch(`https://invites/handles/${encodeURIComponent(handle)}/release`, { method: 'POST' })).json()) as { devices: string[] };
      const { dropped } = (await (await book.fetch('https://agents/reset', { method: 'POST' })).json()) as { dropped: string[] };
      await Promise.all(r.devices.map((id) => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id)).fetch('https://hub/kick', { method: 'POST' }).catch(() => null)));
      return Response.json({ handle, released: true, devices: r.devices, droppedAgents: dropped });
    }
  }
  if (path === '/admin/invites' || path.startsWith('/admin/invites/')) {
    // the InviteBook object owns invites; forward as-is (POST create · GET list · DELETE /<id> revoke)
    return invites(env).fetch(new Request(`https://invites${path.slice('/admin'.length)}`, request));
  }
  return text('not found', 404);
}

const invites = (env: Env) => env.INVITES.get(env.INVITES.idFromName('invites'));

/**
 * POST /v1/agents — a device manages its person's agent directory (ADR-033). Signed
 * like a join: the device proves it holds the key of the certificate it sends, the
 * timestamp keeps the request fresh, and the HANDLE comes from the allowlist entry of
 * that device — never from the request — so a device can only touch its own person.
 */
async function agentRequest(raw: string, env: Env): Promise<Response> {
  const fail = (status: number, code: string, error: string) => Response.json({ error, code }, { status });
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request', 'expected JSON {op, agent?, to?, cert, ts, sig}');
  }
  const op = b['op'];
  const agent = typeof b['agent'] === 'string' ? b['agent'] : '';
  const to = typeof b['to'] === 'string' ? b['to'] : '';
  if (typeof op !== 'string' || !(AGENT_OPS as readonly string[]).includes(op) || typeof b['cert'] !== 'string' || typeof b['sig'] !== 'string' || typeof b['ts'] !== 'number') {
    return fail(400, 'bad_request', `expected {op: ${AGENT_OPS.join('|')}, agent?, to?, cert, ts, sig}`);
  }
  if (Math.abs(Date.now() - b['ts']) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const device = await verifyAgentOp(b['cert'], b['ts'], op, agent, to, b['sig']);
  if (!device) return fail(401, 'bad_signature', 'device signature invalid');
  const handle = (await allowEntry(env.ALLOWLIST, device))?.handle;
  if (!handle) return fail(403, 'not_member', 'this device has not joined (morse join)');
  const book = agentBook(env, handle);
  if (op === 'list') {
    const list = (await (await book.fetch('https://agents/list')).json()) as Record<string, unknown>;
    return Response.json({ handle, device, ...list });
  }
  const res = await book.fetch('https://agents/op', { method: 'POST', body: JSON.stringify({ handle, op, agent, to, device }) });
  const body = (await res.json()) as Record<string, unknown>;
  return Response.json({ handle, ...body }, { status: res.status });
}
/**
 * POST /v1/profile — set the display nickname of this device's person (ADR-036).
 * Signed like an agent op; the handle comes from the allowlist, never the request.
 */
async function profileRequest(raw: string, env: Env): Promise<Response> {
  const fail = (status: number, code: string, error: string) => Response.json({ error, code }, { status });
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request', 'expected JSON {nickname, cert, ts, sig}');
  }
  if (typeof b['nickname'] !== 'string' || typeof b['cert'] !== 'string' || typeof b['sig'] !== 'string' || typeof b['ts'] !== 'number') {
    return fail(400, 'bad_request', 'expected {nickname, cert, ts, sig}');
  }
  if (Math.abs(Date.now() - b['ts']) > JOIN_MAX_SKEW_MS) return fail(400, 'clock_skew', 'this computer’s clock is more than 10 minutes off — fix the time and retry');
  const device = await verifyProfile(b['cert'], b['ts'], b['nickname'], b['sig']);
  if (!device) return fail(401, 'bad_signature', 'device signature invalid');
  const handle = (await allowEntry(env.ALLOWLIST, device))?.handle;
  if (!handle) return fail(403, 'not_member', 'this device has not joined (morse join)');
  const res = await agentBook(env, handle).fetch('https://agents/profile', { method: 'POST', body: JSON.stringify({ handle, device, nickname: b['nickname'] }) });
  const out = (await res.json()) as Record<string, unknown>;
  if (res.ok) {
    // push it to the person's other computers that are online, so what they send carries the new one
    const ids = (await devicesOfHandle(env.ALLOWLIST, handle)).filter((id) => id !== device);
    await Promise.all(
      ids.map((id) =>
        env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id))
          .fetch('https://hub/nickname', { method: 'POST', body: JSON.stringify({ handle, nickname: out['nickname'] ?? null }) })
          .catch(() => null),
      ),
    );
  }
  return Response.json({ handle, ...out }, { status: res.status });
}

/**
 * GET /v3/alias/<handle>[/<agent>] — the frozen old-alias table over HTTP (identity v3 P2,
 * aliases.ts): for the website's old-link page and for scripts. Public and read-only; the
 * table never changes after it is loaded, so answers may be cached.
 */
async function aliasRequest(request: Request, env: Env, rest: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('GET /v3/alias/<handle>[/<agent>]', 405);
  const cors = { 'access-control-allow-origin': '*' };
  let name: string;
  try {
    name = rest.split('/').map(decodeURIComponent).join('/');
  } catch {
    name = '';
  }
  // ADR-077: public, so bounded per client IP (the InviteBook's fixed-window counter, hashed IPs only)
  const perHour = Number.parseInt(env.ALIAS_LOOKUPS_PER_IP_PER_HOUR ?? '', 10);
  const charge = await env.INVITES.get(env.INVITES.idFromName('invites')).fetch('https://invites/alias-lookups', {
    method: 'POST',
    headers: { 'x-morse-client-ip': request.headers.get('cf-connecting-ip') ?? '' },
    body: JSON.stringify(Number.isFinite(perHour) && perHour >= 0 ? { perHour } : {}),
  });
  if (charge.status === 429) {
    const r = (await charge.json().catch(() => ({}))) as { retryAfterSec?: number };
    return Response.json({ error: 'too many alias lookups from this network — try again later' }, { status: 429, headers: { ...cors, 'retry-after': String(r.retryAfterSec ?? 3600) } });
  }
  const answer = await lookupAlias(env.ALLOWLIST, name);
  if (!answer) return Response.json({ error: 'bad alias name' }, { status: 400, headers: cors });
  return Response.json(answer, { status: answer.entries.length ? 200 : 404, headers: { ...cors, 'cache-control': 'public, max-age=300' } });
}

/** A join request is a certificate + a signature + a code: a few KB at most. */
const MAX_JOIN_BYTES = 16 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/healthz') {
      const reg = registerSettingsFromEnv(env);
      return Response.json({ ok: true, protocols: PROTOCOLS, aliases: true, limits: limitsFromEnv(env), registration: { open: reg.open, perIpPerHour: reg.perIpPerHour } });
    }
    if (path.startsWith('/admin/')) return admin(request, env, path);
    if (path === '/v1/join') {
      if (request.method !== 'POST') return text('POST {code, cert, ts, sig, name?}', 405);
      const raw = await request.text();
      if (raw.length > MAX_JOIN_BYTES) return text('request too large', 413);
      return invites(env).fetch('https://invites/join', { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
    }

    if (path === '/v1/register' || path === '/v1/pair-code') {
      if (request.method !== 'POST') return text('POST {cert, ts, sig, …}', 405);
      const raw = await request.text();
      if (raw.length > MAX_JOIN_BYTES) return text('request too large', 413);
      // the per-IP limit on new handles (ADR-036) counts Cloudflare's view of the client address
      const ip = request.headers.get('CF-Connecting-IP') ?? '';
      return invites(env).fetch(`https://invites${path.slice('/v1'.length)}`, {
        method: 'POST',
        body: raw,
        headers: { 'content-type': 'application/json', 'x-morse-client-ip': ip },
      });
    }

    if (path === '/v1/profile') {
      if (request.method !== 'POST') return text('POST {nickname, cert, ts, sig}', 405);
      const raw = await request.text();
      if (raw.length > MAX_JOIN_BYTES) return text('request too large', 413);
      return profileRequest(raw, env);
    }

    if (path === '/v1/agents') {
      if (request.method !== 'POST') return text('POST {op, agent?, to?, cert, ts, sig}', 405);
      const raw = await request.text();
      if (raw.length > MAX_JOIN_BYTES) return text('request too large', 413);
      return agentRequest(raw, env);
    }

    if (path.startsWith('/v3/alias/')) return aliasRequest(request, env, path.slice('/v3/alias/'.length));

    const v3 = /^\/v3\/ws\/([^/]+)$/.exec(path);
    if (v3) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text('expected a websocket upgrade', 426);
      const address = normalizeAddress(decodeURIComponent(v3[1]!));
      if (!address) return text('bad address', 400);
      const fwd = new Request(`https://address/ws?address=${encodeURIComponent(address)}`, request);
      // the per-IP count of new addresses (spec §15.1 #2) uses Cloudflare's view of the client
      const headers = new Headers(fwd.headers);
      headers.set('x-morse-client-ip', request.headers.get('CF-Connecting-IP') ?? '');
      return addressHub(env, address).fetch(new Request(fwd, { headers }));
    }
    const ws = /^\/v1\/ws\/([^/]+)$/.exec(path);
    if (ws) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return text('expected a websocket upgrade', 426);
      const id = normalizeId(decodeURIComponent(ws[1]!));
      if (!id) return text('bad device id', 400);
      const hub = env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id));
      return hub.fetch(new Request(`https://hub/ws?id=${encodeURIComponent(id)}`, request));
    }
    return text('morse-relay: see docs/guides/self-host-relay.zh-CN.md\n', 404);
  },
} satisfies ExportedHandler<Env>;
