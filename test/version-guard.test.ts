import { describe, expect, it } from 'vitest';
import {
  VERSION_MISMATCH,
  checkCliVersion,
  createVersionProbe,
  inferWriterVersion,
  isCliOlder,
  parseVersion,
  type WriterSample,
} from '../src/adapters/version-guard.js';
import { recordingExec } from './helpers/fake-exec.js';

describe('parseVersion: the first major.minor.patch in a string', () => {
  it.each([
    ['2.1.300 (Claude Code)', [2, 1, 300]],
    ['codex-cli 0.170.2', [0, 170, 2]],
    ['0.165.0-alpha.3+build.9', [0, 165, 0]],
    ['v10.20.30 and later 1.2.3', [10, 20, 30]],
    ['1.2.3.4', [1, 2, 3]],
  ])('%s', (raw, core) => {
    expect(parseVersion(raw)).toEqual(core);
  });

  it.each(['', 'unknown', '3.1', 'v.1.2', '1..2.3'])('nothing usable in %j', (raw) => {
    expect(parseVersion(raw)).toBeNull();
  });
});

describe('isCliOlder: only a CLI strictly behind the writer is refused', () => {
  it.each([
    ['2.1.287', '2.1.295', true],
    ['1.99.99', '2.0.0', true],
    ['0.9.0', '0.10.0', true],
    ['codex-cli 0.157.1', '0.162.0-alpha.17.2', true],
    ['2.1.295', '2.1.295', false],
    ['2.2.0', '2.1.999', false],
    ['0.162.0', '0.162.0-alpha.17.2', false],
    ['0.162.0-alpha.1', '0.162.0', false],
    ['not a version', '9.9.9', false],
    ['1.0.0', 'unknown', false],
  ])('cli %s vs writer %s → %s', (cli, writer, older) => {
    expect(isCliOlder(cli, writer)).toBe(older);
  });
});

describe('createVersionProbe: `<cli> --version`, remembered for a while', () => {
  it('asks once per TTL, trims the answer, and asks again when it has aged out', async () => {
    const { exec, argvs, runs } = recordingExec({ stdout: '  0.170.2\n' });
    let clock = 1_000;
    const probe = createVersionProbe(exec, 'codex', { ttlMs: 500, now: () => clock });
    expect(await probe()).toBe('0.170.2');
    clock = 1_500;
    expect(await probe()).toBe('0.170.2');
    expect(argvs()).toEqual([['codex', '--version']]);
    expect(runs[0]?.opts).toEqual({ timeoutMs: 10_000 });
    clock = 1_501;
    await probe();
    expect(argvs()).toHaveLength(2);
  });

  it('defaults to a one-minute TTL', async () => {
    const { exec, argvs } = recordingExec({ stdout: '1.0.0' });
    let clock = 0;
    const probe = createVersionProbe(exec, 'claude', { now: () => clock });
    await probe();
    clock = 60_000;
    await probe();
    expect(argvs()).toHaveLength(1);
    clock = 60_001;
    await probe();
    expect(argvs()).toHaveLength(2);
  });

  it('a failing, silent or throwing CLI yields null — and that answer is remembered too', async () => {
    const failing = recordingExec({ code: 127, stdout: '1.0.0' });
    const p1 = createVersionProbe(failing.exec, 'kimi', { now: () => 0 });
    expect(await p1()).toBeNull();
    await p1();
    expect(failing.argvs()).toHaveLength(1);

    const silent = recordingExec({ stdout: ' \n' });
    expect(await createVersionProbe(silent.exec, 'kimi', { now: () => 0 })()).toBeNull();

    const throwing = createVersionProbe(async () => {
      throw new Error('spawn EACCES');
    }, 'kimi', { now: () => 0 });
    expect(await throwing()).toBeNull();
  });
});

describe('checkCliVersion: the refusal, or null', () => {
  const spec = { cli: 'claude', app: 'Claude Code (desktop App)', upgrade: 'npm i -g @anthropic-ai/claude-code@latest' };

  it('an older CLI gets the full, actionable explanation', async () => {
    const message = await checkCliVersion(async () => '2.1.287 (Claude Code)', spec, '2.1.295');
    expect(message).toBe(
      'version_mismatch: the claude CLI Morse delivers with (2.1.287 (Claude Code)) is older than the ' +
        'Claude Code (desktop App) that last wrote this session (2.1.295). Resuming it with the older CLI fails ' +
        '(often a bare "exit 1"), so the message was NOT sent. Ask the operator to upgrade: ' +
        'npm i -g @anthropic-ai/claude-code@latest — then resend (a dead-lettered one can be retried from the ' +
        'web console: morse console). See ADR-025.',
    );
    expect(message?.startsWith(VERSION_MISMATCH)).toBe(true);
  });

  it('passes a CLI that is as new or newer, or whose version is unknown', async () => {
    expect(await checkCliVersion(async () => '2.1.295', spec, '2.1.295')).toBeNull();
    expect(await checkCliVersion(async () => '2.2.0', spec, '2.1.295')).toBeNull();
    expect(await checkCliVersion(async () => null, spec, '2.1.295')).toBeNull();
  });

  it('does not even probe when the session records no writer', async () => {
    let asked = 0;
    const countingProbe = async () => {
      asked++;
      return '0.0.1';
    };
    expect(await checkCliVersion(countingProbe, spec, undefined)).toBeNull();
    expect(await checkCliVersion(countingProbe, spec, '')).toBeNull();
    expect(asked).toBe(0);
  });
});

describe('inferWriterVersion: who most plausibly wrote a session last', () => {
  const seen: WriterSample[] = [
    { originator: 'Codex Desktop', version: '0.150.0', at: 1_000 },
    { originator: 'Codex Desktop', version: '0.170.0-alpha.2', at: 3_000 },
    { originator: 'Codex Desktop', version: '0.160.0', at: 2_000 },
    { originator: 'Codex Desktop', version: 'garbled', at: 2_500 },
    { originator: 'codex_exec', version: '0.199.0', at: 500 },
  ];

  it('the highest version its originator ran up to the session\'s last activity', () => {
    expect(inferWriterVersion('0.140.0', 'Codex Desktop', 3_000, seen)).toBe('0.170.0-alpha.2');
    expect(inferWriterVersion('0.140.0', 'Codex Desktop', 2_999, seen)).toBe('0.160.0');
    expect(inferWriterVersion('0.140.0', 'Codex Desktop', 1_000, seen)).toBe('0.150.0');
  });

  it('never below its own record; nothing applicable keeps the own record', () => {
    expect(inferWriterVersion('0.165.0', 'Codex Desktop', 2_999, seen)).toBe('0.165.0');
    expect(inferWriterVersion('0.140.0', 'Codex Desktop', 999, seen)).toBe('0.140.0');
    expect(inferWriterVersion('0.140.0', 'codex-tui', 10_000, seen)).toBe('0.140.0');
  });

  it('without an own record the originator\'s sightings still count; without an originator only the own record does', () => {
    expect(inferWriterVersion(undefined, 'Codex Desktop', 2_000, seen)).toBe('0.160.0');
    expect(inferWriterVersion(undefined, 'Codex Desktop', 10, seen)).toBeUndefined();
    expect(inferWriterVersion('0.100.0', undefined, 10_000, seen)).toBe('0.100.0');
    expect(inferWriterVersion(undefined, undefined, 10_000, seen)).toBeUndefined();
  });

  it('an unparseable own record is replaced by any parseable sighting', () => {
    expect(inferWriterVersion('dev-build', 'Codex Desktop', 1_000, seen)).toBe('0.150.0');
  });
});
