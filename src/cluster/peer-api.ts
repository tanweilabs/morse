import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionInfo } from '../adapters/types.js';
import type { Mailbox, SessionRef } from '../mailbox/mailbox.js';
import type { TrustedDevice } from './trust.js';

/**
 * The `/api/peer/*` routes of the device-ID LAN (ADR-028). No daemon serves them since ADR-091
 * stage 1; the handler stays as the reference for how such a caller's mail is filed.
 *
 * The caller arrives already authenticated: the transport matched its certificate to a row of the
 * trust list and passes that row in. The sending device is therefore recorded under the row's name,
 * whatever the request body says.
 */

export interface PeerApiOptions {
  selfDevice: string;
  selfId?: string;
  mailbox: Mailbox;
  /** This computer's own sessions (never other devices'). */
  localDirectory: () => Promise<SessionInfo[]>;
  /** Called after a message was filed. */
  onChange?: () => void;
  /** Where a Morse message handed over on the LAN goes (ADR-034); a getter, as Morse starts later than the LAN. */
  morseInbound?: () => MorseInbound | undefined;
  /** (ADR-077) The verified address of a trusted device; it decides which contact the mail is filed under. */
  addressOf?: (deviceId: string) => string | null;
}

/** Takes one Morse message from a trusted device; answers with the HTTP status and body to send back. */
export type MorseInbound = (peer: TrustedDevice, body: unknown) => Promise<{ status: number; body: unknown }>;

type Handler = (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice) => Promise<void>;

/** Bodies larger than this are refused while being read. */
const BODY_LIMIT = 5 * 1024 * 1024;

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** The request body as JSON; an empty body reads as `{}`. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of req) {
    const bytes = part as Buffer;
    total += bytes.length;
    if (total > BODY_LIMIT) throw new Error('request body too large');
    parts.push(bytes);
  }
  const text = Buffer.concat(parts).toString('utf8');
  return text === '' ? {} : JSON.parse(text);
}

/** An agent plus a non-empty session id. */
function sessionRef(value: unknown): SessionRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { agent, sessionId } = value as Record<string, unknown>;
  return typeof agent === 'string' && typeof sessionId === 'string' && sessionId !== '' ? (value as SessionRef) : null;
}

const hasSealedEnvelope = (value: unknown): boolean => typeof value === 'object' && value !== null && 'sealedV3' in value;

export function createPeerApiHandler(opts: PeerApiOptions): Handler {
  /** POST /api/peer/messages: a plain message, filed under the authenticated device. */
  const fileMessage: Handler = async (req, res, peer) => {
    const body = (await jsonBody(req)) as Record<string, unknown>;
    const from = sessionRef(body.from);
    const to = sessionRef(body.to);
    if (!from || !to || typeof body.text !== 'string') {
      send(res, 400, { error: 'expected {contextId?, from, to, text}' });
      return;
    }
    const contactId = opts.mailbox.contacts.filingContact({ address: opts.addressOf?.(peer.id) ?? null, deviceId: peer.id }, peer.name, peer.tier);
    const contextId = typeof body.contextId === 'string' ? body.contextId : '';
    const message = opts.mailbox.send({
      from: { agent: from.agent, sessionId: from.sessionId, device: peer.name },
      // (ADR-048) someone else's device names no session here: its mail waits in the agent's inbox
      to: { agent: to.agent, sessionId: peer.tier === 'owner' ? to.sessionId : 'inbox' },
      text: body.text,
      via: 'relay',
      fromTier: peer.tier,
      ...(contactId ? { contactId } : {}),
      ...(contextId ? { contextId } : {}),
    });
    opts.onChange?.();
    send(res, 201, { message });
  };

  /**
   * POST /api/peer/morse (plaintext) and /api/peer/morse3 (a sealed v3 envelope, ADR-073): what the
   * relay would carry, handed straight to the Morse layer. Both tiers may send.
   */
  const handOver = async (req: IncomingMessage, res: ServerResponse, peer: TrustedDevice, sealedRoute: boolean): Promise<void> => {
    const inbound = opts.morseInbound?.();
    if (!inbound) {
      send(res, 404, { error: 'Morse is not enabled on this device' });
      return;
    }
    const body = await jsonBody(req);
    if (sealedRoute !== hasSealedEnvelope(body)) {
      send(res, 400, { error: sealedRoute ? 'expected {sealedV3: <v3 envelope>}' : 'a sealed envelope goes to /api/peer/morse3' });
      return;
    }
    const answer = await inbound(peer, body);
    send(res, answer.status, answer.body);
  };

  return async (req, res, peer) => {
    const path = new URL(req.url ?? '/', 'https://peer').pathname;
    // a device of someone else may send, but never sees this computer's sessions — whatever the method
    if (peer.tier === 'peer' && path === '/api/peer/sessions') {
      send(res, 403, { error: 'peer-tier devices may only send messages' });
      return;
    }
    const route = `${req.method ?? ''} ${path}`;
    switch (route) {
      case 'GET /api/peer/info':
        send(res, 200, { device: opts.selfDevice, ...(opts.selfId ? { id: opts.selfId } : {}) });
        return;
      case 'GET /api/peer/sessions':
        send(res, 200, { sessions: await opts.localDirectory() });
        return;
      case 'POST /api/peer/messages':
        return fileMessage(req, res, peer);
      case 'POST /api/peer/morse':
        return handOver(req, res, peer, false);
      case 'POST /api/peer/morse3':
        return handOver(req, res, peer, true);
      default:
        send(res, 404, { error: 'not found' });
    }
  };
}
