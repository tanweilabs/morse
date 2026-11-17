import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withoutAddressSelectors } from '../address-env.js';
import type { Mailbox } from '../mailbox/mailbox.js';
import { createEventSource, type CoreEvent } from './events.js';

/**
 * The `on_message` exec hook (ADR-051): for every core event (docs/PLUGINS.md) the
 * daemon runs the configured command with the event's JSON on stdin. Runs beside
 * delivery, never in its path: at most `maxConcurrent` at a time, each killed after
 * its timeout, a full queue drops the oldest. The cursor is kept in a file so events
 * that arrived while the daemon was down are handed over after a restart.
 *
 *   ~/.morse/config.json: { "hooks": { "on_message": { "command": "…", "timeoutSec": 30 } } }
 */

export interface OnMessageConfig {
  command: string;
  timeoutSec?: number;
}

export interface OnMessageOptions {
  mailbox: Mailbox;
  config: () => OnMessageConfig | null;
  cursorFile: string;
  log?: (line: string) => void;
  intervalMs?: number;
  maxConcurrent?: number;
  maxQueue?: number;
}

export interface OnMessageHook {
  tick(): void;
  stop(): void;
  /** Resolves when nothing is queued or running (tests). */
  idle(): Promise<void>;
}

const readCursor = (file: string): number | null => {
  try {
    const n = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
};

export function startOnMessageHook(opts: OnMessageOptions): OnMessageHook {
  const log = opts.log ?? (() => undefined);
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const maxQueue = opts.maxQueue ?? 1000;
  const saved = readCursor(opts.cursorFile);
  // resume after the saved cursor (requests: those filed since the cursor was last written)
  let savedAt = 0;
  try {
    savedAt = statSync(opts.cursorFile).mtimeMs;
  } catch {
    /* none */
  }
  const events = createEventSource(opts.mailbox, saved !== null ? { sinceSeq: saved, sinceMs: savedAt } : {});
  let cursor = events.cursor();
  const queue: CoreEvent[] = [];
  let running = 0;
  const waiters: Array<() => void> = [];
  const save = () => {
    try {
      mkdirSync(dirname(opts.cursorFile), { recursive: true });
      writeFileSync(opts.cursorFile, String(cursor));
    } catch {
      /* best effort */
    }
  };
  const settle = () => {
    if (running === 0 && queue.length === 0) for (const w of waiters.splice(0)) w();
  };
  const pump = () => {
    const cfg = opts.config();
    while (cfg && running < maxConcurrent && queue.length) {
      const ev = queue.shift()!;
      running++;
      const child = spawn('/bin/sh', ['-c', cfg.command], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...withoutAddressSelectors(process.env), MORSE_EVENT: ev.type } });
      let err = '';
      child.stderr?.on('data', (d) => (err = (err + String(d)).slice(-500)));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        log(`on_message: killed after ${cfg.timeoutSec ?? 30} s (${ev.type}${ev.type === 'message' ? ` ${ev.id.slice(0, 8)}` : ''})`);
      }, (cfg.timeoutSec ?? 30) * 1000);
      timer.unref();
      const done = (code: number | null) => {
        clearTimeout(timer);
        running--;
        if (code) log(`on_message: exited ${code}${err.trim() ? ` — ${err.trim().split('\n').pop()}` : ''}`);
        pump();
        settle();
      };
      child.on('error', (e) => {
        log(`on_message: could not run: ${e.message}`);
        done(null);
      });
      child.on('close', done);
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(`${JSON.stringify(ev)}\n`);
    }
  };
  const hook: OnMessageHook = {
    tick() {
      const fresh = events.poll();
      cursor = Math.max(cursor, events.cursor());
      // not configured: keep the cursor current, so turning it on later does not replay everything
      if (opts.config()) {
        queue.push(...fresh);
        if (queue.length > maxQueue) {
          const dropped = queue.splice(0, queue.length - maxQueue).length;
          log(`on_message: ${dropped} event(s) dropped — the hook is too slow`);
        }
      }
      if (fresh.length) save();
      pump();
      settle();
    },
    stop() {
      clearInterval(timer);
      save();
    },
    idle: () => new Promise<void>((r) => {
      if (running === 0 && queue.length === 0) r();
      else waiters.push(r);
    }),
  };
  const timer = setInterval(() => hook.tick(), opts.intervalMs ?? 1000);
  timer.unref();
  return hook;
}

