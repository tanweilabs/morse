import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRepeatFilter, rotateLogIfLarge } from '../src/daemon/log-hygiene.js';

/** ADR-046: one unreachable peer wrote ~4000 identical lines a day; daemon.log reached 12 MB. */

const dir = mkdtempSync(join(tmpdir(), 'morse-log-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('repeated identical failures are logged at growing intervals', () => {
  it('first one, then after 1, 2, 4 … min with how many were held back — a day of 36 s retries is a few dozen lines', () => {
    let t = 0;
    const f = createRepeatFilter({ now: () => t });
    const shown: string[] = [];
    for (let i = 0; i < 2400; i++) {
      // the real pattern: two messages to the same unreachable peer, each retried every ~36 s
      const line = f.pass('peer-x\0lan failed (timed out)', `lan failed #${i}`);
      if (line) shown.push(line);
      t += 36_000;
    }
    expect(shown[0]).toBe('lan failed #0');
    expect(shown.length).toBeLessThan(40); // 24 h at most hourly after the first few
    expect(shown[1]).toMatch(/^lan failed #2 \[same as 1 line\(s\) held back in the last 1m\]$/);
    expect(shown.at(-1)).toMatch(/held back in the last 1h 0\dm\]$/);
  });

  it('a different error, another target, or a recovery shows the next failure at once', () => {
    let t = 0;
    const f = createRepeatFilter({ now: () => t });
    expect(f.pass('a\0e1', 'x')).toBe('x');
    t += 1000;
    expect(f.pass('a\0e1', 'x')).toBeNull();
    expect(f.pass('a\0e2', 'y')).toBe('y');
    expect(f.pass('b\0e1', 'z')).toBe('z');
    f.forget('a\0');
    expect(f.pass('a\0e1', 'x again')).toBe('x again');
    // quiet for a long time = starts over
    t += 10 * 60_000;
    expect(f.pass('b\0e1', 'z later')).toBe('z later');
  });
});

describe('daemon.log rotation by size', () => {
  it('copies to .1 (older shift up to .3), truncates in place, and the O_APPEND writer goes on at the start', () => {
    const path = join(dir, 'daemon.log');
    const fd = openSync(path, 'a');
    try {
      const chunk = 'x'.repeat(1000) + '\n';
      for (let round = 1; round <= 5; round++) {
        for (let i = 0; i < 6; i++) writeSync(fd, chunk);
        writeSync(fd, `round ${round}\n`);
        expect(rotateLogIfLarge({ path, fds: [fd], maxBytes: 5000, keep: 3 })).toBe(true);
        expect(statSync(path).size).toBe(0);
      }
      writeSync(fd, 'after\n');
      expect(readFileSync(path, 'utf8')).toBe('after\n'); // no hole of NULs before it
      expect(readFileSync(`${path}.1`, 'utf8')).toContain('round 5');
      expect(readFileSync(`${path}.2`, 'utf8')).toContain('round 4');
      expect(readFileSync(`${path}.3`, 'utf8')).toContain('round 3');
      expect(existsSync(`${path}.4`)).toBe(false);
      // below the limit: nothing happens
      expect(rotateLogIfLarge({ path, fds: [fd], maxBytes: 5000, keep: 3 })).toBe(false);
    } finally {
      closeSync(fd);
    }
  });

  it('leaves the file alone when our output does not go to it (a terminal, a pipe, another file)', () => {
    const path = join(dir, 'other.log');
    const fd = openSync(path, 'a');
    writeSync(fd, 'y'.repeat(10_000));
    closeSync(fd);
    const elsewhere = openSync(join(dir, 'elsewhere.log'), 'a');
    try {
      expect(rotateLogIfLarge({ path, fds: [elsewhere], maxBytes: 100 })).toBe(false);
      expect(statSync(path).size).toBe(10_000);
    } finally {
      closeSync(elsewhere);
    }
  });
});
