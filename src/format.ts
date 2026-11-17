import { homedir } from 'node:os';

/** '2m ago', '3h ago', '5d ago' — coarse relative time for directory listings. */
export function formatRelativeTime(epochMs: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - epochMs);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Abbreviate the user's home directory to '~' for display. */
export function shortenHome(path: string, home: string = homedir()): string {
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** '45s', '12m', '3h 05m', '8d 10h' — a coarse duration. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The relay connection as the daemon reports it (ADR-043), for `morse status`. */
export interface RelayStatusView {
  url: string;
  connected: boolean;
  state?: {
    lastConnectedAt: number | null;
    disconnectedSince: number | null;
    lastAttemptAt: number | null;
    failures: number;
    lastError: string | null;
  };
}

/** One line: connected since when, or disconnected for how long and why. */
export function describeRelayStatus(r: RelayStatusView | null, nowMs: number = Date.now()): string {
  if (!r) return 'relay: not configured on this daemon';
  const at = (t: number) => `${new Date(t).toISOString()} (${formatRelativeTime(t, nowMs)})`;
  const s = r.state;
  if (r.connected) return `relay: connected to ${r.url}${s?.lastConnectedAt ? ` since ${at(s.lastConnectedAt)}` : ''}`;
  if (!s) return `relay: NOT connected (${r.url})`;
  const parts = [
    s.disconnectedSince !== null ? `for ${formatDuration(nowMs - s.disconnectedSince)}` : '',
    `last connected ${s.lastConnectedAt ? at(s.lastConnectedAt) : 'never (since the daemon started)'}`,
    s.failures ? `${s.failures} failed attempt(s) in a row` : '',
    s.lastAttemptAt ? `last attempt ${formatRelativeTime(s.lastAttemptAt, nowMs)}` : '',
    s.lastError ? `last error: ${s.lastError}` : '',
  ].filter(Boolean);
  return `relay: NOT connected to ${r.url} — ${parts.join(' · ')}`;
}

/** The direct-link state as the daemon reports it (ADR-069), for `morse status`. */
export interface DirectStatusView {
  enabled: boolean;
  reason?: string;
  links: Array<{ id: string; state: 'connecting' | 'open'; path?: string }>;
  backoff: Array<{ id: string; until: number }>;
  noSignalUntil?: number;
}

/** One line: direct links on / off, which are open, which devices are relay-only for now. */
export function describeDirectStatus(d: DirectStatusView | undefined): string {
  if (!d) return 'direct: off (morse.direct.enabled = false, or MORSE_DIRECT=0)';
  if (!d.enabled) return `direct: off — ${d.reason ?? 'unavailable'} (relay only)`;
  const open = d.links.filter((l) => l.state === 'open');
  const connecting = d.links.filter((l) => l.state === 'connecting');
  const parts = [
    open.length ? `${open.length} link(s) open: ${open.map((l) => `${l.id.slice(0, 7)}${l.path ? ` (${l.path})` : ''}`).join(', ')}` : 'no link open (opened on demand, relay as fallback)',
    connecting.length ? `connecting: ${connecting.map((l) => l.id.slice(0, 7)).join(', ')}` : '',
    d.backoff.length ? `relay only for now: ${d.backoff.map((b) => b.id.slice(0, 7)).join(', ')}` : '',
    d.noSignalUntil ? 'the relay does not forward signaling (old relay)' : '',
  ].filter(Boolean);
  return `direct: on — ${parts.join(' · ')}`;
}
