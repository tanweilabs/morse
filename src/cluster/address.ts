/**
 * Morse's domain (ADR-040, ADR-075). `morse.im` is the only domain in use: every address
 * we print is `morse.im/<handle>[/<agent>]`, the relay is wss://relay.morse.im and the
 * site https://morse.im.
 *
 * `morse.talk` is retired (ADR-075): the client never connects to it or falls back to it,
 * and a saved config that still names it is rewritten once (machine-config.ts). What
 * stays is input compatibility — `morse.talk/<handle>…` typed, pasted or stored before
 * still means the same person / agent (see HOST_PREFIX below); that goes away with v2.
 *
 * An address never travels as a string: senders put the bare handle (`fromHandle`)
 * on the wire and every store keys on the bare handle, so the domain an address was
 * typed with never matters once it is parsed.
 */

/** The domain — what every printed address uses. */
export const MORSE_DOMAIN = 'morse.im';
/**
 * Compatibility: retired domains. Addresses written with them are still accepted as
 * input, and saved relay / site URLs on them are rewritten to MORSE_DOMAIN (ADR-075).
 */
export const LEGACY_MORSE_DOMAINS: readonly string[] = ['morse.talk'];

export const DEFAULT_RELAY_URL = `wss://relay.${MORSE_DOMAIN}`;
export const DEFAULT_SITE_URL = `https://${MORSE_DOMAIN}`;

/**
 * Compatibility (ADR-075): a relay or site URL saved while a retired domain was in use —
 * host `relay.morse.talk` (the relay) or `morse.talk` (the site) — → the same URL on
 * morse.im (scheme, port and path kept). null = not such a URL (nothing to change); any
 * other host, also another name under a retired domain, is left alone.
 */
export function currentDomainUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  for (const old of LEGACY_MORSE_DOMAINS) {
    if (host !== old && host !== `relay.${old}`) continue;
    u.hostname = `${host.slice(0, host.length - old.length)}${MORSE_DOMAIN}`;
    return u.toString().replace(/\/+$/, '');
  }
  return null;
}

/**
 * A leading host in an address: `morse.im/`, `https://morse.im/`, or any other
 * `<host>.<tld>/` (the host names the relay the handle lives on; only the configured
 * relay is ever used, so it is accepted and ignored — as since ADR-032).
 * Compatibility: this is also what keeps `morse.talk/<handle>` (the retired domain,
 * ADR-075) working as typed or stored input.
 */
const HOST_PREFIX = /^(?:[a-z]+:\/\/)?[a-z0-9.-]+\.[a-z]{2,}\//i;

/** Is there a host in front (`morse.im/…`, any host)? */
export const hasAddressHost = (input: string): boolean => HOST_PREFIX.test(input.trim());

/** `@morse.im/Mei/air/` → `Mei/air`: host, `@` and trailing slashes removed (case kept). */
export function stripAddressHost(input: string): string {
  return input.trim().replace(/^@/, '').replace(HOST_PREFIX, '').replace(/^@/, '').replace(/\/+$/, '');
}

/** The bare, lowercased handle of any stored or typed address (`morse.im/x/air` → `x`; any host in front). */
export function bareHandle(input: string): string {
  return (stripAddressHost(input).split('/')[0] ?? '').toLowerCase();
}

/** `morse.im/<handle>[/<agent>]` — the one form we print. */
export function formatAddress(handle: string, agent?: string | null): string {
  return `${MORSE_DOMAIN}/${handle}${agent ? `/${agent}` : ''}`;
}

/** ws(s)://host[/base] → http(s)://host[/base] (the relay's HTTP side). */
function httpSide(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol === 'ws:') u.protocol = 'http:';
  return u.toString().replace(/\/+$/, '');
}

/** fetch `<relay http side><path>` (ADR-075: one relay name, no fallback to another domain). */
export function fetchRelay(url: string, path: string, init: RequestInit, f: typeof fetch = fetch): Promise<Response> {
  return f(`${httpSide(url)}${path}`, init);
}

/** (ADR-091, stage 2) The one line for an old name (`morse.im/<handle>[/<agent>]`, `me/<agent>`) or a contact still by one. */
export const OLD_NAMES_LINE = (who: string): string => `${who}: old names no longer work — ask for their 26-character address (morse address shows it)`;
