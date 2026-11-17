import { normalizeId, type RateLimiter } from './protocol.js';

/**
 * WebRTC signaling over the relay (ADR-069, docs/specs/phase7-webrtc-direct.md §2).
 *
 *   client → {type:"signal", rid, to, blob}  → {type:"signaled", rid} | {type:"offline", rid} | {type:"error", rid, error}
 *   relay  → {type:"signal", from, fromHandle?, blob, ts}
 *
 * The relay forwards a signal between logged-in, non-passive devices and stores
 * nothing. The blob is an end-to-end sealed, signed Morse envelope (offer / answer /
 * ICE candidate): the relay can neither read nor forge it. Its own token bucket keeps
 * signaling from eating the per-device message rate.
 */

export const MAX_SIGNAL_BYTES = 65_536;
export const SIGNAL_RATE_PER_MINUTE = 240;

export interface SignalForward {
  from: string;
  fromHandle?: string;
  blob: string;
}

export type SignalCheck = { ok: true; to: string; blob: string } | { ok: false; error: string };

/** Validate a client's `signal` request (recipient, size, rate). */
export function checkSignal(msg: Record<string, unknown>, limiter?: RateLimiter, now: number = Date.now()): SignalCheck {
  const to = typeof msg['to'] === 'string' ? normalizeId(msg['to']) : null;
  if (!to) return { ok: false, error: 'bad recipient id' };
  const blob = msg['blob'];
  if (typeof blob !== 'string' || !blob) return { ok: false, error: 'empty signal' };
  if (new TextEncoder().encode(blob).length > MAX_SIGNAL_BYTES) return { ok: false, error: `signal too large (max ${MAX_SIGNAL_BYTES} bytes)` };
  if (limiter && !limiter.take(now)) return { ok: false, error: `rate limited (max ${limiter.rate} signals/min)` };
  return { ok: true, to, blob };
}

/** The frame pushed to the recipient's live socket(s). */
export function signalFrame(req: SignalForward, ts: number = Date.now()): string {
  return JSON.stringify({ type: 'signal', from: req.from, ...(req.fromHandle ? { fromHandle: req.fromHandle } : {}), blob: req.blob, ts });
}
