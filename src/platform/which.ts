import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Platform } from './platform.js';

export interface FindOptions {
  platform?: Platform;
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** Directories looked in after PATH (where an installer puts the program without touching PATH). */
  extraDirs?: string[];
}

/** An environment variable whatever its case (Windows: `Path`, `PATHEXT`, `SystemRoot`). */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/**
 * Where a command is, without starting a process (Windows has no `which`): PATH, in order,
 * with PATHEXT on Windows; then `extraDirs`. null = not found. It only looks — whether the
 * result can be started without a shell (an npm `.cmd` shim cannot) is the caller's concern.
 */
export function findExecutable(name: string, opts: FindOptions = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const win = platform === 'win32';
  const p = win ? win32 : posix;
  const dirs = [...(envValue(env, 'PATH') ?? '').split(p.delimiter), ...(opts.extraDirs ?? [])].filter(Boolean);
  const exts = win
    ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
        .map((e) => e.toLowerCase())
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** A program of Windows itself, by absolute path — never looked up on PATH (a planted icacls.exe must not run). */
export function system32(exe: string, env: Record<string, string | undefined> = process.env): string {
  return win32.join(envValue(env, 'SystemRoot') ?? envValue(env, 'windir') ?? 'C:\\Windows', 'System32', exe);
}
