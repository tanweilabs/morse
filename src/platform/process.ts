import { systemExec, type Exec } from './acl.js';
import { isWindows, type Platform } from './platform.js';
import { system32 } from './which.js';

/**
 * End a process and everything it started. On Windows a child does not die with its parent,
 * and `kill` ends only the one process — `taskkill /T /F` takes the tree. Elsewhere: SIGKILL.
 */
export function killTree(pid: number, deps: { platform?: Platform; exec?: Exec; env?: Record<string, string | undefined> } = {}): { ok: boolean; detail: string } {
  if (isWindows(deps.platform)) {
    const r = (deps.exec ?? systemExec)(system32('taskkill.exe', deps.env), ['/PID', String(pid), '/T', '/F']);
    return { ok: r.code === 0, detail: r.code === 0 ? '' : (r.stderr + r.stdout).trim().replace(/\s+/g, ' ') || `taskkill exit ${r.code}` };
  }
  try {
    process.kill(pid, 'SIGKILL');
    return { ok: true, detail: '' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
