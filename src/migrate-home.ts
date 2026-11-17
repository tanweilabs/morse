import { lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isMorseDaemon } from './daemon/pidfile.js';
import { morseHome, DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from './home.js';

/**
 * ADR-035: the data directory moves from ~/.anytoany to ~/.morse — mailbox.db,
 * identity/, trusted-devices.json, peer-keys.json, config.json, daemon.log, …
 *
 * One atomic rename of the whole directory (same disk), then ~/.anytoany becomes a
 * symlink to .morse, so old hook commands and old processes keep finding their files.
 * Idempotent. Never loses data: if any step fails, the state stays (or is put back)
 * in ~/.anytoany, which home.ts#dataDir keeps using while it is a real directory.
 */

export type MigrateStatus =
  /** nothing to move: no ~/.anytoany (fresh install) */
  | 'fresh'
  /** already moved: ~/.anytoany is a symlink (or gone) and ~/.morse exists */
  | 'done'
  /** moved now */
  | 'migrated'
  /** not moved; still using ~/.anytoany — `reason` says why */
  | 'skipped';

export interface MigrateResult {
  status: MigrateStatus;
  /** the data directory in use afterwards */
  dir: string;
  reason?: string;
  /** a daemon was stopped for the move (setup) */
  stoppedDaemon?: boolean;
}

export interface MigrateOptions {
  home?: string;
  /** Stop a running daemon first (`morse setup`). Without it a running daemon = skip. */
  stopDaemon?: boolean;
  log?: (line: string) => void;
  /** Test hooks. */
  isAlive?: (pid: number) => boolean;
  /** Is that live process a Morse daemon? ('unknown' = cannot tell: the pid file is believed) */
  isDaemon?: (pid: number) => 'yes' | 'no' | 'unknown';
  kill?: (pid: number) => void;
  symlink?: (target: string, path: string) => void;
  stopWaitMs?: number;
}

const lstat = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function migrateDataDir(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const home = opts.home ?? morseHome();
  const log = opts.log ?? (() => undefined);
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  const target = join(home, DATA_DIR_NAME);
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const kill = opts.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const symlink = opts.symlink ?? ((t: string, p: string) => symlinkSync(t, p));
  const skip = (reason: string): MigrateResult => {
    log(`data directory: still using ~/${LEGACY_DATA_DIR_NAME} — not moved to ~/${DATA_DIR_NAME}: ${reason}`);
    return { status: 'skipped', dir: legacy, reason };
  };

  const old = lstat(legacy);
  if (!old || !old.isDirectory()) {
    // no legacy dir, or already a symlink (moved before)
    return { status: lstat(target) ? 'done' : 'fresh', dir: target };
  }
  const existing = lstat(target);
  if (existing) {
    // an EMPTY ~/.morse (e.g. made by hand or a log redirect) is safe to drop
    let empty = false;
    try {
      empty = existing.isDirectory() && readdirSync(target).length === 0;
    } catch {
      empty = false;
    }
    if (!empty) return skip(`both ~/${LEGACY_DATA_DIR_NAME} and ~/${DATA_DIR_NAME} exist — move ~/${DATA_DIR_NAME} aside, then run: morse setup`);
    try {
      rmdirSync(target);
    } catch (e) {
      return skip(`could not remove the empty ~/${DATA_DIR_NAME}: ${(e as Error).message}`);
    }
  }

  // nothing may write while the directory moves: stop the daemon (setup) or leave it be
  let stoppedDaemon = false;
  let pid = 0;
  try {
    pid = Number.parseInt(readFileSync(join(legacy, 'daemon.pid'), 'utf8').trim(), 10) || 0;
  } catch {
    pid = 0;
  }
  // (ADR-083 review N3) a left-over pid file whose pid is another program's by now names no daemon: nobody to wait for or stop
  if (pid && pid !== process.pid && isAlive(pid) && (opts.isDaemon ?? isMorseDaemon)(pid) !== 'no') {
    if (!opts.stopDaemon) return skip(`a daemon is running (pid ${pid}) — it moves the directory itself the next time it starts`);
    log(`data directory: stopping the daemon (pid ${pid}) for the move …`);
    try {
      kill(pid);
    } catch (e) {
      return skip(`could not stop the daemon (pid ${pid}): ${(e as Error).message}`);
    }
    const end = Date.now() + (opts.stopWaitMs ?? 8000);
    while (isAlive(pid) && Date.now() < end) await sleep(100);
    if (isAlive(pid)) return skip(`the daemon (pid ${pid}) did not stop`);
    stoppedDaemon = true;
  }

  // 1. the move: one atomic rename of the whole directory
  try {
    renameSync(legacy, target);
  } catch (e) {
    const now = lstat(legacy);
    if ((!now || !now.isDirectory()) && lstat(target)) return { status: 'done', dir: target }; // someone else moved it just now
    return skip(`rename failed: ${(e as Error).message}`);
  }

  // 2. ~/.anytoany → .morse (relative link), placed atomically via a temp name
  const tmp = join(home, `${LEGACY_DATA_DIR_NAME}.link-${process.pid}`);
  const putLink = (): void => {
    try {
      unlinkSync(tmp);
    } catch {
      /* not there */
    }
    symlink(DATA_DIR_NAME, tmp);
    try {
      renameSync(tmp, legacy);
    } catch (e) {
      // something re-created ~/.anytoany in the instant between the two steps
      const stray = lstat(legacy);
      if (!stray?.isDirectory()) throw e;
      if (readdirSync(legacy).length === 0) rmdirSync(legacy);
      else {
        const aside = `${legacy}.stray-${Date.now()}`;
        renameSync(legacy, aside);
        log(`data directory: something wrote to ~/${LEGACY_DATA_DIR_NAME} during the move — kept it as ${aside}`);
      }
      renameSync(tmp, legacy);
    }
  };
  try {
    putLink();
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* not there */
    }
    // put everything back where it was: old processes and hooks must not lose their files
    try {
      renameSync(target, legacy);
      return skip(`could not create the ~/${LEGACY_DATA_DIR_NAME} symlink (${(e as Error).message}); moved back`);
    } catch (e2) {
      log(`data directory: moved to ~/${DATA_DIR_NAME}, but no ~/${LEGACY_DATA_DIR_NAME} symlink (${(e as Error).message}; ${(e2 as Error).message}) — older tools will not find it`);
      return { status: 'migrated', dir: target, reason: 'no legacy symlink', stoppedDaemon };
    }
  }
  log(`data directory: moved ~/${LEGACY_DATA_DIR_NAME} → ~/${DATA_DIR_NAME} (~/${LEGACY_DATA_DIR_NAME} is now a link to it)`);
  return { status: 'migrated', dir: target, stoppedDaemon };
}
