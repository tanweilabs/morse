import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The plugin's state directory (ported from weixin-bridge lib/store.mjs): small JSON files
 * written atomically with mode 0600 in a 0700 directory, plus a log that never carries
 * credentials (any field whose name looks like a secret is dropped) and never full text.
 */

const SECRET_KEY = /token|secret|authorization|password|aes|key$/i;

/** Timestamps are written in Beijing time. */
export const beijingNow = (): string => new Date(Date.now() + 8 * 3_600_000).toISOString().replace('Z', '+08:00');

/** Message text never goes to the log in full: length plus the first 20 characters. */
export function preview(text: unknown): { len: number; head: string } {
  const value = String(text ?? '');
  return { len: value.length, head: Array.from(value).slice(0, 20).join('') };
}

export type LogFields = Record<string, unknown>;
export type Log = (event: string, fields?: LogFields) => void;

export interface Store {
  dir: string;
  path(name: string): string;
  writeFile(name: string, data: string | Buffer): void;
  readJson<T>(name: string, fallback: T): T;
  writeJson(name: string, value: unknown): void;
  remove(name: string): void;
  log: Log;
}

export function createStore(dir: string, opts: { echo?: (line: string) => void } = {}): Store {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const path = (name: string) => join(dir, name);
  const writeFile = (name: string, data: string | Buffer) => {
    const tmp = path(`.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path(name));
  };
  return {
    dir,
    path,
    writeFile,
    readJson<T>(name: string, fallback: T): T {
      try {
        return JSON.parse(readFileSync(path(name), 'utf8')) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw new Error(`cannot read ${path(name)}: ${(error as Error).message}`);
      }
    },
    writeJson(name, value) {
      writeFile(name, `${JSON.stringify(value, null, 2)}\n`);
    },
    remove(name) {
      rmSync(path(name), { force: true });
    },
    log(event, fields = {}) {
      const parts = [beijingNow(), event];
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || SECRET_KEY.test(key)) continue;
        parts.push(`${key}=${JSON.stringify(value)}`);
      }
      const line = parts.join(' ');
      appendFileSync(path('ilink.log'), `${line}\n`, { mode: 0o600 });
      opts.echo?.(line);
    },
  };
}
