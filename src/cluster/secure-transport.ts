/**
 * The device-ID LAN's mutual-TLS transport (ADR-028) is gone since ADR-091 stage 1. What stays is the
 * shape of an unpaired caller, which the daemon's `/api/peers` answer still declares.
 */

/** A device that called with a valid certificate but is not on the trust list. */
export interface UntrustedContact {
  id: string;
  /** The device name it gave about itself: a label, never trusted. */
  claimedName?: string;
  /** The Morse handle it said it belongs to: a claim only. */
  claimedHandle?: string;
  address?: string;
  method?: string;
  path?: string;
  at: number;
}
