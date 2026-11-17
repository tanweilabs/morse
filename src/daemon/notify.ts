import { spawn } from 'node:child_process';

/** Desktop alerts the daemon raises about cross-agent traffic. */
export interface Notifier {
  /** Tell the user a session received a message or replied. Rate-limited per session. */
  sessionActivity(agent: string, sessionTitle: string, sessionId: string, direction: 'received' | 'replied'): void;
  /** Loud alert: a delivery to `agent` was refused because its CLI is too old (ADR-025). */
  versionMismatch(agent: string, detail: string): void;
}

const SESSION_QUIET_MS = 60_000;
/** A stale CLI stays stale until upgraded, so one alert per agent per ten minutes is plenty. */
const MISMATCH_QUIET_MS = 600_000;
const MAX_BODY_CHARS = 220;

/** Quote a value for an AppleScript string literal. */
function appleScriptString(text: string): string {
  return `"${text.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** Show a macOS notification banner. Silently does nothing on other platforms or on failure. */
export function postNotification(title: string, body: string): void {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`;
  const proc = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
  // Best-effort: a missing osascript must never affect message delivery.
  proc.on('error', () => undefined);
  proc.unref();
}

/**
 * A gate that lets one event per key through every `quietMs`.
 * The first event for a key always passes.
 */
function rateLimiter(quietMs: number, clock: () => number): (key: string) => boolean {
  const passedAt = new Map<string, number>();
  return (key) => {
    const t = clock();
    const prev = passedAt.get(key);
    if (prev !== undefined && t - prev < quietMs) return false;
    passedAt.set(key, t);
    return true;
  };
}

export function createNotifier(opts: { enabled: boolean; now?: () => number } = { enabled: true }): Notifier {
  const clock = opts.now ?? Date.now;
  const sessionGate = rateLimiter(SESSION_QUIET_MS, clock);
  const mismatchGate = rateLimiter(MISMATCH_QUIET_MS, clock);

  return {
    sessionActivity(agent, sessionTitle, sessionId, direction) {
      if (!opts.enabled || !sessionGate(sessionId)) return;
      const what = direction === 'replied' ? 'sent a reply' : 'received a new message';
      postNotification(
        'Morse',
        `@${agent}:${sessionTitle} ${what} — reopen the session to see it (or the web console: morse console)`,
      );
    },

    versionMismatch(agent, detail) {
      if (!opts.enabled || !mismatchGate(agent)) return;
      // The adapter's detail text carries "upgrade: <command> —"; surface just the command when present.
      const command = detail.match(/upgrade: (.+?) —/)?.[1];
      postNotification(
        `Morse — ${agent} CLI out of date, message NOT delivered`,
        command === undefined ? detail.slice(0, MAX_BODY_CHARS) : `Run: ${command}`,
      );
    },
  };
}
