import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
}));

import { spawn } from 'node:child_process';
import { createNotifier, postNotification } from '../src/daemon/notify.js';

const spawnMock = vi.mocked(spawn);
const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });

/** The AppleScript passed to each osascript call so far. */
const scripts = () => spawnMock.mock.calls.map((c) => String((c[1] as string[])[1]));

beforeAll(() => setPlatform('darwin'));
afterAll(() => setPlatform(realPlatform));
beforeEach(() => spawnMock.mockClear());

describe('postNotification', () => {
  it('runs osascript with an escaped display-notification script', () => {
    postNotification('Ti "t"', 'back\\slash');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('osascript');
    expect(scripts()[0]).toBe('display notification "back\\\\slash" with title "Ti \\"t\\""');
  });

  it('does nothing off macOS', () => {
    setPlatform('linux');
    try {
      postNotification('t', 'b');
    } finally {
      setPlatform('darwin');
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('sessionActivity', () => {
  it('shows at most one banner per session per minute', () => {
    let t = 2_000_000;
    const n = createNotifier({ enabled: true, now: () => t });
    n.sessionActivity('codex', 'web', 'S1', 'received');
    n.sessionActivity('codex', 'web', 'S1', 'replied');
    n.sessionActivity('claude', 'api', 'S2', 'replied');
    expect(scripts()).toEqual([
      'display notification "@codex:web received a new message — reopen the session to see it (or the web console: morse console)" with title "Morse"',
      'display notification "@claude:api sent a reply — reopen the session to see it (or the web console: morse console)" with title "Morse"',
    ]);
    t += 59_999;
    n.sessionActivity('codex', 'web', 'S1', 'received');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    t += 1;
    n.sessionActivity('codex', 'web', 'S1', 'received');
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it('is silent when notifications are disabled', () => {
    const n = createNotifier({ enabled: false });
    n.sessionActivity('codex', 'x', 'S9', 'received');
    n.versionMismatch('codex', 'whatever');
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('versionMismatch (ADR-025)', () => {
  it('pulls the upgrade command out of the detail when there is one', () => {
    const n = createNotifier({ enabled: true, now: () => 1 });
    n.versionMismatch('kimi', 'version_mismatch: kimi 0.1 — upgrade: pip install -U kimi-cli — then retry');
    expect(scripts()[0]).toBe(
      'display notification "Run: pip install -U kimi-cli" with title "Morse — kimi CLI out of date, message NOT delivered"',
    );
  });

  it('otherwise shows the start of the detail text', () => {
    const n = createNotifier({ enabled: true, now: () => 1 });
    n.versionMismatch('codex', 'x'.repeat(300));
    expect(scripts()[0]).toContain(`"${'x'.repeat(220)}" with title`);
    expect(scripts()[0]).not.toContain('x'.repeat(221));
  });

  it('alerts once per agent per ten minutes', () => {
    let t = 9_000_000;
    const n = createNotifier({ enabled: true, now: () => t });
    n.versionMismatch('codex', 'first');
    n.versionMismatch('codex', 'second');
    n.versionMismatch('claude', 'other agent');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(scripts().join('\n')).not.toContain('anytoany');
    t += 600_000;
    n.versionMismatch('codex', 'third');
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });
});
