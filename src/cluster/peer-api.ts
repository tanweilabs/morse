import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from '../adapters/types.js';
import type { Mailbox, SessionRef } from '../mailbox/mailbox.js';
import type { TrustedDevice } from './trust.js';

/**
 * Routes a paired device may call (ADR-028). Reached only through the mutual-TLS
 * peer server, which has already pinned the caller to an entry in our trust list —
 * so `peer` here is authenticated, and its trusted name (not anything in the body)
 * is what we record as the sending device.
 */

export interface PeerApiOptions {
  selfDevice: string;
  selfId?: string;
  mailbox: Mailbox;
  /** Local-only directory (no peer aggregation) served to peers. */
  localDirectory: () => Promise<SessionInfo[]>;
  /** Tell the local console something changed. */
  onChange?: () => void;
  /** Morse over the LAN (ADR-034): file a Morse message from this trusted device.
   *  A getter because the Morse layer starts after the LAN layer. */
  morseInbound?: () => MorseInbound | undefined;
  /** ADR-077: a trusted device's VERIFIED address (its pinned certificate) — picks the contact its mail is filed under. */
  addressOf?: (deviceId: string) => string | null;
}

/** Files one Morse message handed over directly; answers with an HTTP status + body. */
export type MorseInbound = (peer: TrustedDevice, body: unknown) => Promise<{ status: number; body: unknown }>;

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const isSessionRef = (v: unknown): v is SessionRef =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SessionRef).agent === 'string' &&
  typeof (v as SessionRef).sessionId === 'string' &&
  (v as SessionRef).sessionId.length > 0;

export function createPeerApiHandler(
  opts: PeerApiOptions,
): (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void> {
  return async (req, res, peer) => {
    const path = new URL(req.url ?? '/', 'https://peer').pathname;

    if (req.method === 'GET' && path === '/api/peer/info') {
      json(res, 200, { device: opts.selfDevice, ...(opts.selfId ? { id: opts.selfId } : {}) });
      return;
    }
    // Morse: someone else's device may hand us messages, nothing more — it must not
    // read this device's session directory.
    if (peer.tier === 'peer' && path === '/api/peer/sessions') {
      json(res, 403, { error: 'peer-tier devices may only send messages' });
      return;
    }
    if (req.method === 'GET' && path === '/api/peer/sessions') {
      json(res, 200, { sessions: await opts.localDirectory() });
      return;
    }
    if (req.method === 'POST' && path === '/api/peer/messages') {
      const body = (await readBody(req)) as { contextId?: unknown; from?: unknown; to?: unknown; text?: unknown };
      if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string') {
        json(res, 400, { error: 'expected {contextId?, from, to, text}' });
        return;
      }
      const m = opts.mailbox.send({
        // the authenticated device, not whatever the body claims
        from: { agent: body.from.agent, sessionId: body.from.sessionId, device: peer.name },
        // target is local here; another person's device never picks a session (ADR-048)
        to: peer.tier === 'owner' ? { agent: body.to.agent, sessionId: body.to.sessionId } : { agent: body.to.agent, sessionId: 'inbox' },
        text: body.text,
        via: 'relay',
        fromTier: peer.tier,
        // ADR-077: by the caller's verified address, never by anything in the body
        ...(() => {
          const contactId = opts.mailbox.contacts.filingContact({ address: opts.addressOf?.(peer.id) ?? null, deviceId: peer.id }, peer.name, peer.tier);
          return contactId ? { contactId } : {};
        })(),
        ...(typeof body.contextId === 'string' && body.contextId ? { contextId: body.contextId } : {}),
      });
      opts.onChange?.();
      json(res, 201, { message: m });
      return;
    }
    // Morse over the LAN: same message the relay would carry, minus the sealing —
    // mutual TLS already proves which trusted device is calling (both tiers may send).
    // ADR-073: the same, as a sealed v3 envelope ({sealedV3}) — signed and encrypted end to end
    // on top of the mutual TLS; the Morse layer checks it was sealed by this very device
    if (req.method === 'POST' && (path === '/api/peer/morse' || path === '/api/peer/morse3')) {
      const inbound = opts.morseInbound?.();
      if (!inbound) {
        json(res, 404, { error: 'Morse is not enabled on this device' });
        return;
      }
      const raw = await readBody(req);
      if (path === '/api/peer/morse3' && (raw === null || typeof raw !== 'object' || !('sealedV3' in raw))) {
        json(res, 400, { error: 'expected {sealedV3: <v3 envelope>}' });
        return;
      }
      if (path === '/api/peer/morse' && raw !== null && typeof raw === 'object' && 'sealedV3' in raw) {
        json(res, 400, { error: 'a sealed envelope goes to /api/peer/morse3' });
        return;
      }
      const r = await inbound(peer, raw);
      json(res, r.status, r.body);
      return;
    }
    json(res, 404, { error: 'not found' });
  };
}
