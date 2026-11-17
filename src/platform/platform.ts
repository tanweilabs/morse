/**
 * Windows support (ADR-080, docs/specs/windows-native.zh-CN.md). Everything that depends on
 * the operating system goes through src/platform/: each function takes the platform (and the
 * system commands it runs) as arguments, so the Windows branches are tested on macOS / Linux.
 */
export type Platform = NodeJS.Platform;

export const isWindows = (platform: Platform = process.platform): boolean => platform === 'win32';

/** How a Windows install is updated until auto-update works there (phase 3). */
export const WINDOWS_INSTALL_COMMAND = 'irm https://morse.im/install.ps1 | iex';

export type PlatformLimitKey = 'lan' | 'plugins' | 'update';
export interface PlatformLimit {
  key: PlatformLimitKey;
  /** What is off, in the words `morse status` prints. */
  what: string;
  /** What that means for the user / what to do instead. */
  instead: string;
}

/**
 * Phase 1 on Windows is pull-only. These are OFF there whatever config.json says — each is
 * turned on in the phase that verifies it on a real machine (the firewall prompt for the LAN,
 * the approval gate for the attendant, replacing a loaded native module for auto-update).
 * Empty on every other platform. Direct links (WebRTC) were on this list until phase 5 tried
 * them on a real Windows 11 (ADR-080 #33): on, as on macOS / Linux.
 */
const WINDOWS_LIMITS: readonly PlatformLimit[] = [
  { key: 'lan', what: 'LAN (Morse on the same network)', instead: 'every message goes through the relay, end-to-end encrypted' },
  {
    key: 'plugins',
    what: 'plugins — dispatch (pushing a message into a session) and attendant (your agent answering contacts)',
    instead: 'a message reaches an agent at its next prompt (the inbox hook), or when it runs: morse read',
  },
  { key: 'update', what: 'auto-update', instead: `to update, run the installer again: ${WINDOWS_INSTALL_COMMAND}` },
];

export function platformLimits(platform: Platform = process.platform): readonly PlatformLimit[] {
  return isWindows(platform) ? WINDOWS_LIMITS : [];
}

export function platformOff(key: PlatformLimitKey, platform: Platform = process.platform): boolean {
  return platformLimits(platform).some((l) => l.key === key);
}

/** Why a feature is off, without naming it again: "not available on Windows in this release (ADR-080) — <instead>". */
export function offReason(key: PlatformLimitKey, platform: Platform = process.platform): string | null {
  const l = platformLimits(platform).find((x) => x.key === key);
  return l ? `not available on Windows in this release (ADR-080) — ${l.instead}` : null;
}

/** One line for a feature that is off: what, why, what instead (the daemon log). */
export function offLine(key: PlatformLimitKey, platform: Platform = process.platform): string | null {
  const l = platformLimits(platform).find((x) => x.key === key);
  return l ? `${l.what}: not available on Windows in this release (ADR-080) — ${l.instead}` : null;
}

/** The block `morse status` prints on Windows (nothing elsewhere). */
export function describePlatformLimits(platform: Platform = process.platform): string[] {
  const limits = platformLimits(platform);
  if (!limits.length) return [];
  return [
    'windows: pull-only in this release (ADR-080) — a message reaches an agent at its next prompt (the inbox hook), or when it runs: morse read',
    ...limits.map((l) => `  off: ${l.what} — ${l.instead}`),
  ];
}
