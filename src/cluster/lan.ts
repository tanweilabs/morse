/**
 * The hook the Morse layer has for delivering to a paired device on the LAN (ADR-034). The device-ID
 * LAN that implemented it (mDNS `_anytoany._tcp` plus mutual TLS) is no longer started since
 * ADR-091 stage 1; the LAN by address is src/cluster/lan-address.ts.
 */

/** What a hand-over on the LAN answered. Status and body matter to chunked transfers (ADR-038). */
export interface MorseLanResult {
  ok: boolean;
  error?: string;
  /** The device refused us: it has not paired us. */
  notPaired?: boolean;
  /** (ADR-037) It took the message as a message request (`filed`), or dropped it because one from us already waits. */
  request?: 'filed' | 'dropped';
  status?: number;
  body?: unknown;
}

export interface LanMorseLink {
  /** Paired, and seen on the LAN right now. */
  reachable(deviceId: string): boolean;
  /** Hand the payload to that device; `sealed` = the payload is a v3 envelope (ADR-073). */
  deliver(deviceId: string, payload: unknown, opts?: { timeoutMs?: number; sealed?: boolean }): Promise<MorseLanResult>;
}
