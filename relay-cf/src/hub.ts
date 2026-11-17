import { DurableObject } from 'cloudflare:workers';
import { allowEntry, devicesOfHandle, isAllowlisted } from './allowlist.js';
import { randomNonce, verifyBundle, verifyLogin } from './crypto.js';
import { SIGNAL_RATE_PER_MINUTE, checkSignal, signalFrame, type SignalForward } from './signal.js';
import type { AgentRecord } from './agents.js';
import type { AgentBook } from './agent-book.js';
import type { InviteBook } from './invite-book.js';
import type { AddressHub } from './address-hub.js';
import type { IpBucket } from './ip-bucket.js';
import { PROTOCOLS } from './v3.js';
import {
  CLOSE_BAD_FRAME,
  CLOSE_LOGIN_FAILED,
  CLOSE_NOT_ALLOWED,
  CLOSE_REPLACED,
  HELLO_TIMEOUT_MS,
  RateLimiter,
  isKeyBundleShape,
  normalizeAgent,
  normalizeHandle,
  normalizeId,
  parseFrame,
  type KeyBundle,
  type Limits,
} from './protocol.js';

/**
 * DeviceHub — ONE Durable Object per device ID (`idFromName(deviceId)`).
 *
 * It owns that device's live WebSocket(s) (Hibernation API, so an idle connection
 * costs nothing) and its signed encryption-key bundle. That is ALL it stores:
 *
 *   storage['bundle'] = {id, cert, encPub, sig}   — public material, uploaded at login
 *
 * A message never touches storage. `send` from device A = A's hub asks B's hub to
 * forward the ciphertext to B's open socket right now; B's hub answers "online"
 * (pushed) or "offline" (nobody connected). A's daemon keeps the message in its
 * own outbox until B's end-to-end receipt comes back. If this object is evicted
 * mid-flight nothing is lost that was not already lost by a plain TCP reset — the
 * sender simply retries.
 *
 * Login: the client connects to /v1/ws/<deviceId> (the Worker routes that to this
 * object), gets a random challenge, and must present a certificate whose
 * fingerprint IS <deviceId> plus an Ed25519 signature over the challenge. So the
 * object for device X only ever admits the holder of X's private key, and only if
 * X is on the KV allowlist.
 */

export interface Env {
  DEVICE_HUB: DurableObjectNamespace<DeviceHub>;
  /** One object per v3 address (`idFromName(address)`, ADR-073): its record, live connection, mailbox. */
  ADDRESS_HUB: DurableObjectNamespace<AddressHub>;
  /** One object per client IP (`idFromName(<hash of the IP>)`): the v3 send tokens that IP's connections share (ip-limit.ts). */
  IP_BUCKET: DurableObjectNamespace<IpBucket>;
  /** Single object (`idFromName('invites')`) holding the invites (ADR-032). */
  INVITES: DurableObjectNamespace<InviteBook>;
  /** One object per person (`idFromName(handle)`): that person's agent directory (ADR-033). */
  AGENTS: DurableObjectNamespace<AgentBook>;
  ALLOWLIST: KVNamespace;
  MAX_BLOB_BYTES?: string;
  RATE_PER_MINUTE?: string;
  ADMIN_KEY?: string;
  /** Open registration (ADR-036): "0" / "false" closes POST /v1/register. Default open. */
  OPEN_REGISTRATION?: string;
  /** New random handles one IP may get per hour (default 20). */
  REGISTER_PER_IP_PER_HOUR?: string;
  /** Extra reserved handles, comma separated (added to the built-in list). */
  RESERVED_HANDLES?: string;
  /** v3 (ADR-073): offline mailbox lifetime in seconds (default 7 days). */
  MAILBOX_TTL_SEC?: string;
  /** v3: stored envelopes / bytes per address (relay self-protection). */
  MAILBOX_MAX_MESSAGES?: string;
  MAILBOX_MAX_BYTES?: string;
  /** v3: optional hard cap on sends per connection per minute (default: none, spec §8.4). */
  V3_RATE_PER_MINUTE?: string;
  /**
   * v3: `send` frames one client IP may make per minute, over all its connections together
   * (default 600; "0" = off, then no IpBucket is ever called). Only a hash of the IP is used.
   */
  V3_RATE_PER_IP_PER_MINUTE?: string;
  /** v3: new addresses first published from one IP per hour (default 100, spec §15.1 #2). */
  NEW_ADDRESSES_PER_IP_PER_HOUR?: string;
  /** ADR-077: GET /v3/alias lookups per client IP per hour (default 600; 0 = no limit). */
  ALIAS_LOOKUPS_PER_IP_PER_HOUR?: string;
}

/** Per-socket state; survives hibernation via serializeAttachment. */
interface Attachment {
  /** Device ID claimed by the URL path; must match the certificate at hello. */
  id: string;
  nonce: string;
  authed: boolean;
  /** A passive connection (e.g. `anyd pair add <handle>` looking up a directory
   *  entry) never counts as "online" and never receives deliveries. */
  passive: boolean;
  openedAt: number;
  /** The device's handle per the allowlist, set at login. */
  handle?: string | null;
}

export interface ForwardRequest {
  from: string;
  /** The sender's handle — lets an unpaired recipient pair back (ADR-032). */
  fromHandle?: string;
  blob: string;
}

export { normalizeHandle };

export const DEFAULT_MAX_BLOB_BYTES = 1_000_000; // Cloudflare caps one WS message at 1 MiB
export const DEFAULT_RATE_PER_MINUTE = 120;

export function limitsFromEnv(env: Pick<Env, 'MAX_BLOB_BYTES' | 'RATE_PER_MINUTE'>): Limits {
  const maxBlobBytes = Number.parseInt(env.MAX_BLOB_BYTES ?? '', 10) || DEFAULT_MAX_BLOB_BYTES;
  const ratePerMinute = Number.parseInt(env.RATE_PER_MINUTE ?? '', 10) || DEFAULT_RATE_PER_MINUTE;
  return { maxBlobBytes: Math.min(maxBlobBytes, 1_040_000), ratePerMinute };
}

/** The AgentBook of one person. */
export const agentBook = (env: Pick<Env, 'AGENTS'>, handle: string): DurableObjectStub<AgentBook> => env.AGENTS.get(env.AGENTS.idFromName(handle));

export type { AllowEntry } from './allowlist.js';
export { allowEntry, devicesOfHandle } from './allowlist.js';

export class DeviceHub extends DurableObject<Env> {
  private limiter: RateLimiter | null = null;
  /** ADR-069: WebRTC signaling has its own bucket (not the message rate). */
  private signalLimiter: RateLimiter | null = null;
  private readonly limits: Limits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = limitsFromEnv(env);
    // protocol-level ping/pong is answered by the runtime without waking us;
    // this covers clients that send a JSON "ping" as well
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---- HTTP entry points (only the Worker can reach these) ------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.openSocket(request, url.searchParams.get('id') ?? '');
    if (url.pathname === '/forward' && request.method === 'POST') return this.forward((await request.json()) as ForwardRequest);
    if (url.pathname === '/signal' && request.method === 'POST') return this.pushSignal((await request.json()) as SignalForward);
    if (url.pathname === '/bundle') return Response.json((await this.ctx.storage.get<KeyBundle>('bundle')) ?? null);
    if (url.pathname === '/online') return Response.json({ online: this.liveSockets().length > 0 });
    if (url.pathname === '/nickname' && request.method === 'POST') {
      // another computer of this device's person changed the nickname: tell the live socket(s)
      const b = (await request.json()) as { handle?: string; nickname?: string | null };
      const frame = JSON.stringify({ type: 'nickname', handle: b.handle ?? null, nickname: b.nickname ?? null });
      for (const ws of this.liveSockets()) {
        try {
          ws.send(frame);
        } catch {
          /* gone */
        }
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
      // the device left the allowlist (admin): close its sockets now, not at the next reconnect
      let closed = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(CLOSE_NOT_ALLOWED, 'removed from the relay');
          closed++;
        } catch {
          /* already closed */
        }
      }
      return Response.json({ closed });
    }
    return new Response('not found', { status: 404 });
  }

  private openSocket(request: Request, claimedId: string): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const id = normalizeId(claimedId);
    if (!id) return new Response('bad device id', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const att: Attachment = { id, nonce: randomNonce(), authed: false, passive: false, openedAt: Date.now() };
    server.serializeAttachment(att);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'challenge', nonce: att.nonce }));
    void this.ctx.storage.setAlarm(Date.now() + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push an envelope to this device's live socket(s). Stores nothing. */
  private forward(req: ForwardRequest): Response {
    const sockets = this.liveSockets();
    if (sockets.length === 0) return Response.json({ online: false });
    const frame = JSON.stringify({
      type: 'deliver',
      id: crypto.randomUUID(),
      from: req.from,
      ...(req.fromHandle ? { fromHandle: req.fromHandle } : {}),
      blob: req.blob,
      ts: Date.now(),
    });
    let pushed = 0;
    for (const ws of sockets) {
      try {
        ws.send(frame);
        pushed++;
      } catch {
        // a socket that died without a close frame — drop it; the sender retries
        try {
          ws.close(1011, 'send failed');
        } catch {
          /* already gone */
        }
      }
    }
    return Response.json({ online: pushed > 0 });
  }

  /** ADR-069: push a WebRTC signal to this device's live socket(s). Stores nothing. */
  private pushSignal(req: SignalForward): Response {
    const frame = signalFrame(req);
    let pushed = 0;
    for (const ws of this.liveSockets()) {
      try {
        ws.send(frame);
        pushed++;
      } catch {
        /* gone — the sender falls back to the relay */
      }
    }
    return Response.json({ online: pushed > 0 });
  }

  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return Boolean(att?.authed && !att.passive);
    });
  }

  // ---- WebSocket (Hibernation API) -------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return ws.close(CLOSE_BAD_FRAME, 'no state');
    const msg = parseFrame(raw);
    if (!msg) return ws.close(CLOSE_BAD_FRAME, 'bad frame');
    if (!att.authed) return this.hello(ws, att, msg);

    const rid = typeof msg['rid'] === 'string' ? msg['rid'] : undefined;
    const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ ...body, ...(rid ? { rid } : {}) }));
    switch (msg['type']) {
      case 'send':
        return reply(await this.send(att, msg));
      case 'signal':
        return reply(await this.signal(att, msg));
      case 'bundle': {
        const id = typeof msg['id'] === 'string' ? normalizeId(msg['id']) : null;
        if (!id || !(await isAllowlisted(this.env.ALLOWLIST, id))) return reply({ type: 'bundle', bundle: null });
        return reply({ type: 'bundle', bundle: await this.bundleOf(id, att.id) });
      }
      case 'handle': {
        // directory lookup: a person's handle → their allowlisted devices (+ key bundles)
        const handle = typeof msg['handle'] === 'string' ? normalizeHandle(msg['handle']) : null;
        if (!handle) return reply({ type: 'error', error: 'bad handle' });
        const ids = await devicesOfHandle(this.env.ALLOWLIST, handle);
        const devices = await Promise.all(
          ids.map(async (id) => ({ id, name: (await allowEntry(this.env.ALLOWLIST, id))?.name ?? '', bundle: await this.bundleOf(id, att.id) })),
        );
        const nickname = ids.length ? await this.nicknameOf(handle) : undefined;
        return reply({ type: 'handle', handle, ...(nickname !== undefined ? { nickname } : {}), devices });
      }
      case 'agent': {
        // agent directory (ADR-033): morse.im/<handle>/<agent> → the ONE device hosting it
        const handle = typeof msg['handle'] === 'string' ? normalizeHandle(msg['handle']) : null;
        if (!handle) return reply({ type: 'error', error: 'bad handle' });
        const raw = typeof msg['agent'] === 'string' && msg['agent'] ? msg['agent'] : null;
        const agent = raw ? normalizeAgent(raw) : null;
        if (raw && !agent) return reply({ type: 'error', error: 'bad agent name' });
        const q = new URLSearchParams(agent ? { agent } : {});
        const rec = await agentBook(this.env, handle)
          .fetch(`https://agents/resolve?${q}`)
          .then((r) => r.json<AgentRecord | null>());
        const entry = rec ? await allowEntry(this.env.ALLOWLIST, rec.device) : null;
        if (!rec || entry?.handle !== handle) return reply({ type: 'agent', handle, agent: agent ?? rec?.agent ?? null, device: null });
        const nickname = await this.nicknameOf(handle);
        return reply({
          type: 'agent',
          handle,
          ...(nickname !== undefined ? { nickname } : {}),
          agent: rec.agent,
          device: { id: rec.device, name: entry.name ?? '', bundle: await this.bundleOf(rec.device, att.id) },
        });
      }
      default:
        return reply({ type: 'error', error: 'unknown request' });
    }
  }

  /** The display nickname of a handle (ADR-036); null when none, undefined when the lookup failed. */
  private async nicknameOf(handle: string): Promise<string | null | undefined> {
    try {
      const r = await agentBook(this.env, handle)
        .fetch('https://agents/profile')
        .then((res) => res.json<{ nickname?: string | null }>());
      return typeof r.nickname === 'string' && r.nickname ? r.nickname : null;
    } catch {
      return undefined;
    }
  }

  private async bundleOf(id: string, self: string): Promise<KeyBundle | null> {
    if (id === self) return (await this.ctx.storage.get<KeyBundle>('bundle')) ?? null;
    return this.peer(id).fetch('https://hub/bundle').then((r) => r.json<KeyBundle | null>());
  }

  private async hello(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    if (msg['type'] !== 'hello' || typeof msg['cert'] !== 'string' || typeof msg['sig'] !== 'string') {
      return ws.close(CLOSE_LOGIN_FAILED, 'login required');
    }
    const id = await verifyLogin(msg['cert'], att.nonce, msg['sig']);
    if (!id || id !== att.id) {
      console.log(`relay: login failed for ${att.id.slice(0, 7)} — ${id ? 'certificate does not match the URL device id' : 'bad certificate or signature'}`);
      return ws.close(CLOSE_LOGIN_FAILED, 'login failed');
    }
    const entry = await allowEntry(this.env.ALLOWLIST, id);
    if (!entry) {
      console.log(`relay: REJECTED device ${id} — not on the allowlist`);
      ws.send(JSON.stringify({ type: 'error', error: 'device not on the relay allowlist' }));
      return ws.close(CLOSE_NOT_ALLOWED, 'not allowed');
    }
    if (isKeyBundleShape(msg['bundle'])) {
      const bundle = await verifyBundle(id, msg['bundle']);
      if (bundle) await this.ctx.storage.put('bundle', bundle);
    }
    const passive = msg['passive'] === true;
    // a newer (active) connection of the same device replaces older active ones
    for (const other of passive ? [] : this.liveSockets()) {
      if (other !== ws) {
        try {
          other.close(CLOSE_REPLACED, 'replaced by a newer connection');
        } catch {
          /* already closed */
        }
      }
    }
    ws.serializeAttachment({ ...att, authed: true, passive, handle: entry.handle ?? null } satisfies Attachment);
    const nickname = entry.handle && !passive ? await this.nicknameOf(entry.handle) : undefined;
    // nickname: present (null = none) for an active login, so the client also learns it was cleared;
    // left out when the lookup failed (the client then keeps what it has)
    // protocols (ADR-073): a client that sees 3 also opens a v3 connection (/v3/ws/<address>)
    ws.send(JSON.stringify({ type: 'welcome', id, handle: entry.handle ?? null, ...(nickname !== undefined ? { nickname } : {}), limits: this.limits, protocols: PROTOCOLS }));
    console.log(`relay: ${id.slice(0, 7)}${entry.handle ? ` (${entry.handle})` : ''} ${passive ? 'lookup' : 'online'}`);
  }

  private async send(att: Attachment, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const self = att.id;
    const to = typeof msg['to'] === 'string' ? normalizeId(msg['to']) : null;
    const blob = msg['blob'];
    if (!to) return { type: 'error', error: 'bad recipient id' };
    if (typeof blob !== 'string' || !blob) return { type: 'error', error: 'empty blob' };
    if (blob.length > this.limits.maxBlobBytes) return { type: 'error', error: `envelope too large (max ${this.limits.maxBlobBytes} bytes)` };
    this.limiter ??= new RateLimiter(this.limits.ratePerMinute);
    if (!this.limiter.take()) return { type: 'error', error: `rate limited (max ${this.limits.ratePerMinute}/min)` };
    if (!(await isAllowlisted(this.env.ALLOWLIST, to))) return { type: 'error', error: 'recipient not on the relay allowlist' };
    const body: ForwardRequest = { from: self, ...(att.handle ? { fromHandle: att.handle } : {}), blob };
    const res = await this.peer(to).fetch('https://hub/forward', { method: 'POST', body: JSON.stringify(body) });
    const { online } = await res.json<{ online: boolean }>();
    console.log(`relay: ${self.slice(0, 7)} → ${to.slice(0, 7)} ${online ? 'forwarded' : 'offline'} (${blob.length} bytes)`);
    return online ? { type: 'sent' } : { type: 'offline' };
  }

  /**
   * ADR-069: forward a WebRTC signal (an end-to-end sealed offer / answer / candidate)
   * between logged-in devices. Passive (lookup-only) connections cannot signal.
   */
  private async signal(att: Attachment, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (att.passive) return { type: 'error', error: 'a lookup connection cannot signal' };
    this.signalLimiter ??= new RateLimiter(SIGNAL_RATE_PER_MINUTE);
    const c = checkSignal(msg, this.signalLimiter);
    if (!c.ok) return { type: 'error', error: c.error };
    if (!(await isAllowlisted(this.env.ALLOWLIST, c.to))) return { type: 'error', error: 'recipient not on the relay allowlist' };
    const body: SignalForward = { from: att.id, ...(att.handle ? { fromHandle: att.handle } : {}), blob: c.blob };
    const res = await this.peer(c.to).fetch('https://hub/signal', { method: 'POST', body: JSON.stringify(body) });
    const { online } = await res.json<{ online: boolean }>();
    console.log(`relay: ${att.id.slice(0, 7)} → ${c.to.slice(0, 7)} signal ${online ? 'forwarded' : 'offline'} (${c.blob.length} bytes)`);
    return online ? { type: 'signaled' } : { type: 'offline' };
  }

  private peer(id: string): DurableObjectStub<DeviceHub> {
    return this.env.DEVICE_HUB.get(this.env.DEVICE_HUB.idFromName(id));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.authed) console.log(`relay: ${att.id.slice(0, 7)} offline (${code})`);
    // the Hibernation API leaves completing the closing handshake to us
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closed */
    }
  }

  /** Close sockets that never completed the challenge within HELLO_TIMEOUT_MS. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let pending = false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.authed) continue;
      if (now - att.openedAt >= HELLO_TIMEOUT_MS) {
        try {
          ws.close(CLOSE_LOGIN_FAILED, 'login timeout');
        } catch {
          /* already closed */
        }
      } else pending = true;
    }
    if (pending) await this.ctx.storage.setAlarm(now + HELLO_TIMEOUT_MS);
  }
}
