import { DurableObject } from 'cloudflare:workers';
import { keyOfAddress, normalizeAddress, verifyAddressLogin, verifyPrekey, type PrekeyRecord } from './address.js';
import { lookupAlias } from './aliases.js';
import { randomNonce } from './crypto.js';
import { limitsFromEnv, type Env } from './hub.js';
import { ipBucket } from './ip-bucket.js';
import { IP_LEASE_SIZE, LeaseHolder, ipRateLimitedError, sendIpHash } from './ip-limit.js';
import { CLOSE_BAD_FRAME, CLOSE_LOGIN_FAILED, CLOSE_REPLACED, HELLO_TIMEOUT_MS, RateLimiter, parseFrame, type Limits } from './protocol.js';
import { MAX_SIGNAL_BYTES, SIGNAL_RATE_PER_MINUTE } from './signal.js';
import { CLOSE_TOO_MANY_NEW, PROTOCOLS, checkV3Send, deliverFrame, helloEntries, normalizeCaps, undeliverableFrame, v3SettingsFromEnv, type V3Settings, ALIAS_RATE_PER_MINUTE } from './v3.js';

/**
 * AddressHub — ONE Durable Object per v3 address (`idFromName(address)`), ADR-073.
 *
 * It keeps that address's public record and, while the address is offline, its mailbox:
 *
 *   storage 'record' = {key, prekeys:[current, previous], publishedAt, caps?}   public material
 *                      (caps, ADR-081: what the client that last logged this address in can do)
 *   storage 'host'   = <primary address>   when another address's connection hosts this one
 *   sql mailbox      = sealed envelopes for this address (≤ 7 days, deleted on ack)
 *   sql notices      = "what you sent to X expired unread" for this address as a sender
 *
 * A computer logs in all the addresses it hosts over ONE WebSocket to the hub of its first
 * (primary) address; the hubs of the other addresses remember that host. Sending to X =
 * X's hub pushes it to the live connection that hosts X right now, or — nobody there —
 * stores it (sealed: the relay cannot read it) and answers "stored". On the next login
 * the stored envelopes go out marked `stored`; the client acks each and it is deleted.
 * An envelope nobody fetched within the TTL is deleted and its sender gets `undeliverable`.
 * There is no allowlist: an address is whoever holds its key (the address IS its key's hash).
 */

interface Attachment {
  /** The address in the URL: this hub's own. */
  primary: string;
  nonce: string;
  authed: boolean;
  openedAt: number;
  /** Every address this connection logged in (primary first). */
  addresses: string[];
  ip: string;
}

interface AddressRecord {
  key: string;
  prekeys: PrekeyRecord[];
  publishedAt: number;
  /** ADR-081: as the last login gave them (absent = a record from before caps, or none given). */
  caps?: string[];
}

interface MailRow extends Record<string, SqlStorageValue> {
  id: string;
  sender: string;
  ref: string | null;
  blob: string;
  size: number;
  ts: number;
}

/** What this hub holds of one client IP's send tokens (ip-limit.ts). Memory only: hibernation drops it. */
interface IpLease {
  holder: LeaseHolder;
  /** The lease request in flight, shared by every send that is waiting for it. */
  pending: Promise<void> | null;
  /** "the limiter is unavailable" was logged for this connection. */
  warned: boolean;
}

type DeliverOutcome = { r: 'sent' } | { r: 'offline' } | { r: 'stored'; expiresAt: number } | { r: 'unknown' } | { r: 'full' };

export const addressHub = (env: Pick<Env, 'ADDRESS_HUB'>, address: string): DurableObjectStub<AddressHub> => env.ADDRESS_HUB.get(env.ADDRESS_HUB.idFromName(address));

const post = (stub: DurableObjectStub<AddressHub>, path: string, body: unknown): Promise<Response> =>
  stub.fetch(`https://address${path}`, { method: 'POST', body: JSON.stringify(body) });

export class AddressHub extends DurableObject<Env> {
  private readonly limits: Limits;
  private readonly settings: V3Settings;
  private sendLimiter: RateLimiter | null = null;
  private signalLimiter: RateLimiter | null = null;
  private aliasLimiter: RateLimiter | null = null;
  /** Per client IP (normally one: a hub has one live connection). Never stored. */
  private readonly ipLeases = new Map<string, IpLease>();
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = limitsFromEnv(env);
    this.settings = v3SettingsFromEnv(env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox (id TEXT PRIMARY KEY, sender TEXT NOT NULL, ref TEXT, blob TEXT NOT NULL, size INTEGER NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, body TEXT NOT NULL, ts INTEGER NOT NULL)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---- internal HTTP (the Worker and other hubs) ------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = async <T>(): Promise<T> => (await request.json()) as T;
    switch (url.pathname) {
      case '/ws':
        return this.openSocket(request, url.searchParams.get('address') ?? '');
      case '/info':
        return Response.json(await this.info());
      case '/exists':
        return Response.json({ exists: Boolean(await this.record()) });
      case '/attach':
        return Response.json(await this.attach(await body<{ address: string; host: string; key: string; prekey?: PrekeyRecord | null; caps?: unknown }>()));
      case '/deliver':
        return Response.json(await this.accept(await body<{ to: string; from: string; ref?: string; blob: string; store?: boolean }>()));
      case '/push': {
        const b = await body<{ to: string; frame: string }>();
        return Response.json({ online: this.pushLocal(b.to, b.frame) });
      }
      case '/online': {
        const to = url.searchParams.get('to') ?? '';
        return Response.json({ online: this.socketsFor(to).length > 0 });
      }
      case '/notice':
        return Response.json(await this.notice(await body<{ from: string; to: string; ref: string; ts: number }>()));
      case '/ack': {
        const b = await body<{ ids: string[] }>();
        return Response.json({ deleted: this.deleteMail(b.ids) });
      }
      case '/prekey': {
        const b = await body<{ prekey: PrekeyRecord }>();
        return Response.json({ ok: await this.storePrekey(b.prekey) });
      }
      case '/signal': {
        const b = await body<{ to: string; from: string; blob: string }>();
        return Response.json({ online: await this.pushTo(b.to, JSON.stringify({ type: 'signal', from: b.from, to: b.to, blob: b.blob, ts: Date.now() })) });
      }
      case '/dump':
        // tests (wrangler dev): what the relay holds for this address — never plaintext
        return Response.json({ record: await this.record(), host: (await this.ctx.storage.get<string>('host')) ?? null, mailbox: this.mailCount(), notices: this.sql.exec('SELECT COUNT(*) AS n FROM notices').one()['n'] });
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async record(): Promise<AddressRecord | null> {
    return (await this.ctx.storage.get<AddressRecord>('record')) ?? null;
  }

  private self: string | null = null;

  /** This hub's own address (the name it was created from), remembered in storage. */
  private async remember(address: string): Promise<void> {
    if (this.self === address) return;
    this.self = address;
    if ((await this.ctx.storage.get<string>('self')) !== address) await this.ctx.storage.put('self', address);
  }

  private async ownAddress(): Promise<string | null> {
    return (this.self ??= (await this.ctx.storage.get<string>('self')) ?? null);
  }

  private async info(): Promise<{ key: string | null; prekey: PrekeyRecord | null; online: boolean; caps: string[] }> {
    const rec = await this.record();
    const me = await this.ownAddress();
    return { key: rec?.key ?? null, prekey: rec?.prekeys[0] ?? null, online: me ? await this.isOnline(me) : false, caps: normalizeCaps(rec?.caps) };
  }

  /**
   * Remember the key (and prekey) an address logged in with. `caps` (ADR-081): given at a login
   * = what that client can do, replacing what was there (an older client logging the address in
   * again publishes none, so none are claimed for it); left out (a rotated prekey) = unchanged.
   */
  private async publish(key: string, prekey?: PrekeyRecord | null, caps?: string[]): Promise<void> {
    const rec = await this.record();
    const prekeys = prekey ? [prekey, ...(rec?.prekeys ?? []).filter((p) => p.id !== prekey.id)].slice(0, 2) : (rec?.prekeys ?? []);
    const kept = caps ?? rec?.caps ?? [];
    await this.ctx.storage.put('record', { key, prekeys, publishedAt: rec?.publishedAt ?? Date.now(), ...(kept.length ? { caps: kept } : {}) } satisfies AddressRecord);
  }

  private async storePrekey(prekey: PrekeyRecord): Promise<boolean> {
    const rec = await this.record();
    if (!rec) return false;
    await this.publish(rec.key, prekey);
    return true;
  }

  /** Another address's connection hosts this one now (a secondary of a multi-address login). */
  private async attach(b: { address: string; host: string; key: string; prekey?: PrekeyRecord | null; caps?: unknown }): Promise<{ ok: true }> {
    await this.remember(b.address);
    await this.publish(b.key, b.prekey ?? null, normalizeCaps(b.caps));
    await this.ctx.storage.put('host', b.host);
    await this.flush(b.address);
    return { ok: true };
  }

  // ---- delivery ---------------------------------------------------------------------------

  private socketsFor(address: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return Boolean(att?.authed && att.addresses.includes(address));
    });
  }

  /** Send a frame on this hub's live connection(s) that logged in `address`. */
  private pushLocal(address: string, frame: string): boolean {
    let pushed = 0;
    for (const ws of this.socketsFor(address)) {
      try {
        ws.send(frame);
        pushed++;
      } catch {
        try {
          ws.close(1011, 'send failed');
        } catch {
          /* gone */
        }
      }
    }
    return pushed > 0;
  }

  /** Push to whichever connection hosts this hub's address: one here, or the host's. */
  private async pushTo(address: string, frame: string): Promise<boolean> {
    if (this.pushLocal(address, frame)) return true;
    const host = await this.ctx.storage.get<string>('host');
    if (!host || host === address) return false;
    try {
      const r = await post(addressHub(this.env, host), '/push', { to: address, frame });
      return ((await r.json()) as { online: boolean }).online;
    } catch {
      return false;
    }
  }

  private async isOnline(address: string): Promise<boolean> {
    if (this.socketsFor(address).length) return true;
    const host = await this.ctx.storage.get<string>('host');
    if (!host || host === address) return false;
    try {
      const r = await addressHub(this.env, host).fetch(`https://address/online?to=${encodeURIComponent(address)}`);
      return ((await r.json()) as { online: boolean }).online;
    } catch {
      return false;
    }
  }

  private mailCount(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM mailbox').one()['n']);
  }

  /** An envelope for this hub's address: push it live, else keep it in the mailbox. */
  private async accept(b: { to: string; from: string; ref?: string; blob: string; store?: boolean }): Promise<DeliverOutcome> {
    if (!(await this.record())) return { r: 'unknown' };
    await this.remember(b.to);
    const now = Date.now();
    const live = deliverFrame({ id: crypto.randomUUID(), to: b.to, from: b.from, blob: b.blob, ts: now, ref: b.ref ?? null });
    if (await this.pushTo(b.to, live)) return { r: 'sent' };
    if (b.store === false) return { r: 'offline' }; // the sender keeps it (e.g. file chunks)
    const used = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM mailbox').one();
    if (Number(used['n']) >= this.settings.mailboxMaxMessages || Number(used['bytes']) + b.blob.length > this.settings.mailboxMaxBytes) return { r: 'full' };
    const id = crypto.randomUUID();
    this.sql.exec('INSERT INTO mailbox (id, sender, ref, blob, size, ts) VALUES (?, ?, ?, ?, ?, ?)', id, b.from, b.ref ?? null, b.blob, b.blob.length, now);
    await this.schedule(now + this.settings.mailboxTtlMs);
    // the recipient may have logged in while we stored it: hand it over now
    if (await this.isOnline(b.to)) await this.flush(b.to);
    return { r: 'stored', expiresAt: now + this.settings.mailboxTtlMs };
  }

  /** Push every stored envelope and notice to the live connection (after a login). */
  private async flush(address: string): Promise<void> {
    const rows = this.sql.exec<MailRow>('SELECT id, sender, ref, blob, size, ts FROM mailbox ORDER BY ts ASC').toArray();
    for (const r of rows) {
      if (!(await this.pushTo(address, deliverFrame({ id: r.id, to: address, from: r.sender, blob: r.blob, ts: r.ts, ref: r.ref, stored: true })))) return;
    }
    const notes = this.sql.exec<{ id: string; body: string }>('SELECT id, body FROM notices ORDER BY ts ASC').toArray();
    for (const n of notes) {
      if (!(await this.pushTo(address, n.body))) return;
      this.sql.exec('DELETE FROM notices WHERE id = ?', n.id);
    }
  }

  private deleteMail(ids: unknown): number {
    if (!Array.isArray(ids)) return 0;
    let n = 0;
    for (const id of ids.slice(0, 500)) if (typeof id === 'string') n += this.sql.exec('DELETE FROM mailbox WHERE id = ?', id).rowsWritten;
    return n;
  }

  /** `undeliverable` for this hub's address (it was the sender): push, or keep it until it logs in. */
  private async notice(n: { from: string; to: string; ref: string; ts: number }): Promise<{ online: boolean }> {
    const frame = undeliverableFrame(n);
    if (await this.pushTo(n.from, frame)) return { online: true };
    const now = Date.now();
    this.sql.exec('INSERT INTO notices (id, body, ts) VALUES (?, ?, ?)', crypto.randomUUID(), frame, now);
    await this.schedule(now + this.settings.mailboxTtlMs);
    return { online: false };
  }

  // ---- the per-IP send limit (ip-limit.ts) ----------------------------------------------------

  /**
   * One send token of this connection's client IP. Spent from the lease this hub holds; only
   * an empty or expired lease asks the IP's bucket (one call per IP_LEASE_SIZE sends).
   * false = that IP is over V3_RATE_PER_IP_PER_MINUTE.
   */
  private async ipToken(att: Attachment): Promise<boolean> {
    let lease = this.ipLeases.get(att.ip);
    if (!lease) {
      // a new client IP on this hub: forget the ones no connection has any more
      const live = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment | null)?.ip));
      for (const ip of this.ipLeases.keys()) if (!live.has(ip)) this.ipLeases.delete(ip);
      this.ipLeases.set(att.ip, (lease = { holder: new LeaseHolder(), pending: null, warned: false }));
    }
    const l = lease;
    for (;;) {
      const t = l.holder.take(Date.now());
      if (t !== 'need-lease') return t === 'ok';
      // sends that arrive while a lease is on its way wait for that one
      await (l.pending ??= this.fetchLease(att, l).finally(() => (l.pending = null)));
    }
  }

  /** Ask the IP's bucket for a lease. Never throws: a bucket that cannot be reached lets mail through. */
  private async fetchLease(att: Attachment, l: IpLease): Promise<void> {
    const rate = this.settings.ratePerIpPerMinute;
    try {
      const r = await ipBucket(this.env, await sendIpHash(att.ip)).fetch('https://ip-bucket/lease', { method: 'POST', body: JSON.stringify({ want: IP_LEASE_SIZE, rate }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const granted = ((await r.json()) as { granted?: unknown }).granted;
      if (typeof granted !== 'number') throw new Error('bad answer');
      l.holder.fill(granted, Date.now());
      if (granted <= 0) console.log(`relay v3: ${att.primary.slice(0, 7)} — its network is over ${rate} sends/min, refusing`);
    } catch (e) {
      l.holder.failOpen(Date.now());
      if (!l.warned) console.log(`relay v3: per-IP send limit unavailable (${e instanceof Error ? e.message : String(e)}) — ${att.primary.slice(0, 7)} sends without it`);
      l.warned = true;
    }
  }

  // ---- WebSocket --------------------------------------------------------------------------

  private openSocket(request: Request, claimed: string): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const primary = normalizeAddress(claimed);
    if (!primary) return new Response('bad address', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const att: Attachment = { primary, nonce: randomNonce(), authed: false, openedAt: Date.now(), addresses: [], ip: request.headers.get('x-morse-client-ip') ?? '' };
    server.serializeAttachment(att);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'challenge', nonce: att.nonce, protocol: 3 }));
    void this.schedule(Date.now() + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return ws.close(CLOSE_BAD_FRAME, 'no state');
    const msg = parseFrame(raw);
    if (!msg) return ws.close(CLOSE_BAD_FRAME, 'bad frame');
    if (!att.authed) return this.hello(ws, att, msg);
    const rid = typeof msg['rid'] === 'string' ? msg['rid'] : undefined;
    const reply = (body: Record<string, unknown>) => ws.send(JSON.stringify({ ...body, ...(rid ? { rid } : {}) }));
    switch (msg['type']) {
      case 'send': {
        if (this.settings.ratePerMinute > 0) this.sendLimiter ??= new RateLimiter(this.settings.ratePerMinute);
        const c = checkV3Send(msg, att.addresses, this.limits.maxBlobBytes, this.sendLimiter);
        if (!c.ok) return reply({ type: 'error', error: c.error });
        // shared by every connection from this client IP; a send refused above costs no token
        if (this.settings.ratePerIpPerMinute > 0 && !(await this.ipToken(att))) return reply({ type: 'error', error: ipRateLimitedError(this.settings.ratePerIpPerMinute) });
        let out: DeliverOutcome;
        try {
          out = (await (await post(addressHub(this.env, c.to), '/deliver', { to: c.to, from: c.from, ref: c.ref, blob: c.blob, ...(msg['store'] === false ? { store: false } : {}) })).json()) as DeliverOutcome;
        } catch (e) {
          return reply({ type: 'error', error: `relay: ${e instanceof Error ? e.message : String(e)}` });
        }
        console.log(`relay v3: ${c.from.slice(0, 7)} → ${c.to.slice(0, 7)} ${out.r} (${c.blob.length} bytes)`);
        if (out.r === 'sent') return reply({ type: 'sent' });
        if (out.r === 'offline') return reply({ type: 'offline' });
        if (out.r === 'stored') return reply({ type: 'stored', expiresAt: out.expiresAt });
        if (out.r === 'full') return reply({ type: 'error', error: 'mailbox full — the recipient has too many messages waiting; try again later' });
        return reply({ type: 'error', error: 'unknown address — nobody has logged in with it yet' });
      }
      case 'address': {
        const a = normalizeAddress(msg['address']);
        if (!a) return reply({ type: 'error', error: 'bad address' });
        const info = a === att.primary ? await this.info() : ((await (await addressHub(this.env, a).fetch('https://address/info')).json()) as Awaited<ReturnType<AddressHub['info']>>);
        // caps (ADR-081): always an array — [] for an address whose client published none
        return reply({ type: 'address', address: a, key: info.key, prekey: info.prekey, online: info.online, caps: normalizeCaps(info.caps) });
      }
      case 'alias': {
        // a frozen old name (`alice`, `alice/air`) → the address(es) it meant (aliases.ts; read-only)
        // ADR-077: bounded per connection (the same token bucket as signals)
        this.aliasLimiter ??= new RateLimiter(ALIAS_RATE_PER_MINUTE);
        if (!this.aliasLimiter.take()) return reply({ type: 'error', error: `rate limited (max ${ALIAS_RATE_PER_MINUTE} alias lookups/min)` });
        const answer = await lookupAlias(this.env.ALLOWLIST, msg['name']);
        if (!answer) return reply({ type: 'error', error: 'bad alias name' });
        return reply({ type: 'alias', name: answer.name, entries: answer.entries });
      }
      case 'prekey': {
        const a = normalizeAddress(msg['address']);
        if (!a || !att.addresses.includes(a)) return reply({ type: 'error', error: 'not logged in as that address' });
        const rec = a === att.primary ? await this.record() : null;
        const keyB64 = rec?.key ?? ((await (await addressHub(this.env, a).fetch('https://address/info')).json()) as { key: string | null }).key;
        const key = keyB64 ? await keyOfAddress(a, keyB64) : null;
        const p = key ? await verifyPrekey(a, key, msg['prekey']) : null;
        if (!p) return reply({ type: 'error', error: 'bad prekey signature' });
        if (a === att.primary) await this.storePrekey(p);
        else await post(addressHub(this.env, a), '/prekey', { prekey: p });
        return reply({ type: 'prekey', ok: true });
      }
      case 'ack': {
        const to = normalizeAddress(msg['to']) ?? att.primary;
        if (!att.addresses.includes(to)) return;
        if (to === att.primary) this.deleteMail(msg['ids']);
        else await post(addressHub(this.env, to), '/ack', { ids: msg['ids'] });
        return;
      }
      case 'signal': {
        this.signalLimiter ??= new RateLimiter(SIGNAL_RATE_PER_MINUTE);
        const c = checkV3Send(msg, att.addresses, MAX_SIGNAL_BYTES, this.signalLimiter);
        if (!c.ok) return reply({ type: 'error', error: c.error.replace('envelope', 'signal') });
        const r = (await (await post(addressHub(this.env, c.to), '/signal', { to: c.to, from: c.from, blob: c.blob })).json()) as { online: boolean };
        return reply({ type: r.online ? 'signaled' : 'offline' });
      }
      default:
        return reply({ type: 'error', error: 'unknown request' });
    }
  }

  private async hello(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    const entries = helloEntries(msg, att.primary);
    if (!entries) return ws.close(CLOSE_LOGIN_FAILED, 'login required');
    const verified: Array<{ address: string; key: string; prekey: PrekeyRecord | null; isNew: boolean; caps: string[] }> = [];
    for (const e of entries) {
      const key = await verifyAddressLogin(e.address, e.key, att.nonce, e.sig);
      if (!key) {
        console.log(`relay v3: login failed for ${e.address.slice(0, 7)} — bad key or signature`);
        return ws.close(CLOSE_LOGIN_FAILED, 'login failed');
      }
      const prekey = e.prekey === undefined ? null : await verifyPrekey(e.address, key, e.prekey);
      const isNew =
        e.address === att.primary
          ? !(await this.record())
          : !((await (await addressHub(this.env, e.address).fetch('https://address/exists')).json()) as { exists: boolean }).exists;
      verified.push({ address: e.address, key: e.key as string, prekey, isNew, caps: e.caps });
    }
    // spec §15.1 #2: new addresses per IP per hour (never consulted for sending)
    const fresh = verified.filter((v) => v.isNew).length;
    if (fresh) {
      const r = await this.env.INVITES.get(this.env.INVITES.idFromName('invites')).fetch('https://invites/new-addresses', {
        method: 'POST',
        body: JSON.stringify({ n: fresh, perHour: this.settings.newAddressesPerIpPerHour }),
        headers: { 'x-morse-client-ip': att.ip },
      });
      if (r.status === 429) {
        ws.send(JSON.stringify({ type: 'error', error: 'too many new addresses from this network in the last hour — try again later' }));
        return ws.close(CLOSE_TOO_MANY_NEW, 'too many new addresses');
      }
    }
    // a newer connection of the same primary replaces older ones
    for (const other of this.ctx.getWebSockets()) {
      const o = other.deserializeAttachment() as Attachment | null;
      if (other !== ws && o?.authed) {
        try {
          other.close(CLOSE_REPLACED, 'replaced by a newer connection');
        } catch {
          /* already closed */
        }
      }
    }
    const addresses = verified.map((v) => v.address);
    ws.serializeAttachment({ ...att, authed: true, addresses } satisfies Attachment);
    const own = verified[0]!;
    await this.remember(own.address);
    await this.publish(own.key, own.prekey, own.caps);
    await this.ctx.storage.delete('host');
    ws.send(JSON.stringify({ type: 'welcome', v: 3, addresses, limits: this.limits, protocols: PROTOCOLS }));
    console.log(`relay v3: ${att.primary.slice(0, 7)} online (${addresses.length} address(es))`);
    await this.flush(att.primary);
    for (const v of verified.slice(1)) {
      await post(addressHub(this.env, v.address), '/attach', { address: v.address, host: att.primary, key: v.key, prekey: v.prekey, caps: v.caps }).catch(() => null);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.authed) console.log(`relay v3: ${att.primary.slice(0, 7)} offline (${code})`);
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

  // ---- timers: login timeout + mailbox expiry ------------------------------------------------

  private async schedule(at: number): Promise<void> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || at < cur) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (!att || att.authed) continue;
      if (now - att.openedAt >= HELLO_TIMEOUT_MS) {
        try {
          ws.close(CLOSE_LOGIN_FAILED, 'login timeout');
        } catch {
          /* already closed */
        }
      } else next = Math.min(next, att.openedAt + HELLO_TIMEOUT_MS);
    }
    const ttl = this.settings.mailboxTtlMs;
    const me = await this.ownAddress();
    const expired = this.sql.exec<{ id: string; sender: string; ref: string | null }>('SELECT id, sender, ref FROM mailbox WHERE ts <= ?', now - ttl).toArray();
    for (const r of expired) {
      this.sql.exec('DELETE FROM mailbox WHERE id = ?', r.id);
      if (r.ref && me) await post(addressHub(this.env, r.sender), '/notice', { from: r.sender, to: me, ref: r.ref, ts: now }).catch(() => null);
    }
    if (expired.length) console.log(`relay v3: ${me?.slice(0, 7) ?? '?'} — ${expired.length} stored envelope(s) expired unread`);
    this.sql.exec('DELETE FROM notices WHERE ts <= ?', now - ttl);
    const oldest = this.sql.exec('SELECT MIN(ts) AS t FROM (SELECT ts FROM mailbox UNION ALL SELECT ts FROM notices)').one()['t'];
    if (typeof oldest === 'number') next = Math.min(next, oldest + ttl);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }
}
