import type { AclDeps } from './acl.js';
import { AUTOSTART_TASK, autostartStatus, type AutostartKind } from './autostart.js';
import { describePlatformLimits, isWindows } from './platform.js';

export function autostartLine(kind: AutostartKind): string {
  if (kind === 'task') return `autostart: scheduled task ${AUTOSTART_TASK} — the daemon starts when you log on, and stops when you log off`;
  if (kind === 'run-key') return `autostart: registry Run value ${AUTOSTART_TASK} — the daemon starts when you log on, and stops when you log off`;
  return 'autostart: NOT set up — the daemon will not start when you log on; run: morse autostart enable';
}

/**
 * What `morse status` adds on Windows (ADR-080): how the daemon starts at logon, and what is
 * off in this release. Nothing on other platforms.
 */
export function windowsStatusLines(deps: Pick<AclDeps, 'platform' | 'exec' | 'env'> = {}): string[] {
  if (!isWindows(deps.platform)) return [];
  return [autostartLine(autostartStatus(deps).kind), ...describePlatformLimits(deps.platform)];
}
