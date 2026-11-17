import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearMonitor, heartbeat, isMonitored } from '../src/daemon/monitor.js';
import { dataDir } from '../src/home.js';

let home: string;
let clock: number;
const at = () => ({ home, now: () => clock });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'morse-monitor-'));
  clock = Date.UTC(2026, 0, 1);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('isMonitored', () => {
  it('says no for a session that never sent a heartbeat', () => {
    expect(isMonitored('never', at())).toBe(false);
  });

  it('stays true for up to ten seconds after the last heartbeat', () => {
    heartbeat('s1', at());
    expect(isMonitored('s1', at())).toBe(true);
    clock += 10_000;
    expect(isMonitored('s1', at())).toBe(true);
    clock += 1;
    expect(isMonitored('s1', at())).toBe(false);
  });

  it('honours a custom freshness window', () => {
    heartbeat('s1', at());
    clock += 3_000;
    expect(isMonitored('s1', { ...at(), freshMs: 2_000 })).toBe(false);
    expect(isMonitored('s1', { ...at(), freshMs: 5_000 })).toBe(true);
  });

  it('a later heartbeat extends the window', () => {
    heartbeat('s1', at());
    clock += 8_000;
    heartbeat('s1', at());
    clock += 8_000;
    expect(isMonitored('s1', at())).toBe(true);
  });

  it('treats an unreadable heartbeat body as not monitored', () => {
    heartbeat('s1', at());
    writeFileSync(join(dataDir(home), 'monitors', 's1'), 'garbage');
    expect(isMonitored('s1', at())).toBe(false);
  });

  it('keeps each session separate', () => {
    heartbeat('alpha', at());
    expect(isMonitored('alpha', at())).toBe(true);
    expect(isMonitored('beta', at())).toBe(false);
  });
});

describe('heartbeat file naming', () => {
  it('flattens path characters so the file stays inside the monitors folder', () => {
    heartbeat('x/../../escape', at());
    expect(isMonitored('x/../../escape', at())).toBe(true);
    expect(readdirSync(join(dataDir(home), 'monitors'))).toEqual(['x_.._.._escape']);
  });
});

describe('clearMonitor', () => {
  it('removes the heartbeat right away', () => {
    heartbeat('s1', at());
    clearMonitor('s1', { home });
    expect(isMonitored('s1', at())).toBe(false);
    expect(existsSync(join(dataDir(home), 'monitors', 's1'))).toBe(false);
  });

  it('is a no-op for an unknown session', () => {
    expect(() => clearMonitor('ghost', { home })).not.toThrow();
  });
});
