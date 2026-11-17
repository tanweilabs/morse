/**
 * What is left of the device-ID LAN layer (ADR-028), switched off since ADR-091 stage 1: the record
 * a daemon reports for a device it saw on the LAN (`/api/peers` still has the field), and the
 * address picker the LAN by address (lan-address.ts) uses for mDNS answers.
 */

/** A device seen on the LAN. */
export interface Peer {
  device: string;
  host: string;
  /** Its mutual-TLS port (ADR-028). */
  port: number;
  /** The device ID it announced: public, and of use only to the holder of the matching key. */
  id: string;
  lastSeenAt: number;
}

/** 10/8, 172.16/12 and 192.168/16. */
const PRIVATE_RANGE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
/** Loopback, link-local, and 198.18/15 (the fake addresses of proxy TUN interfaces). */
const NEVER_REACHABLE = /^(?:127\.|169\.254\.|198\.1[89]\.)/;

/**
 * The address to reach a LAN device on, out of everything its mDNS answer lists (one per interface,
 * proxy TUN fakes and link-local included). IPv4 only: a private-range address first, else any
 * address outside the never-reachable ranges, else none.
 */
export function pickLanAddress(addresses: string[]): string | undefined {
  let fallback: string | undefined;
  for (const address of addresses) {
    if (!address.includes('.') || NEVER_REACHABLE.test(address)) continue;
    if (PRIVATE_RANGE.test(address)) return address;
    fallback ??= address;
  }
  return fallback;
}
