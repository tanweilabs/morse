import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createCodexLiveness,
  isSessionLive,
  liveClaudeSessions,
  parseCodexLockHolders,
  parseLiveClaudeSessions,
} from '../src/daemon/session-liveness.js';

// ADR-023: a Claude session someone has open is not resumed headlessly.
// ADR-026: a Codex thread with a live writer refuses `codex exec resume`.

const OPEN_A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const OPEN_B = 'b2b2b2b2-0000-4000-8000-00000000000b';
const HEADLESS = 'c3c3c3c3-0000-4000-8000-00000000000c';

describe('parseLiveClaudeSessions (ps -o command output)', () => {
  it('finds every --resume=<uuid>, and nothing in a headless `--resume <uuid>` delivery', () => {
    const ps = [
      'COMMAND',
      `/opt/claude/bin/claude --resume=${OPEN_A} --output-format stream-json`,
      `claude -p --resume ${HEADLESS} "[Morse] message"`,
      `node /x/claude.js --verbose --resume=${OPEN_B}`,
      `/opt/claude/bin/claude --resume=${OPEN_A}`, // the same session twice
      'zsh',
    ].join('\n');
    expect(parseLiveClaudeSessions(ps)).toEqual(new Set([OPEN_A, OPEN_B]));
  });

  it('ignores ids that are not lowercase UUIDs, and empty input', () => {
    expect(parseLiveClaudeSessions('claude --resume=not-a-uuid\nclaude --resume=A1A1A1A1-0000-4000-8000-00000000000A').size).toBe(0);
    expect(parseLiveClaudeSessions('').size).toBe(0);
  });
});

describe('liveClaudeSessions / isSessionLive (the real machine)', () => {
  it('answer with a set, the same one while cached, and never claim a random session is live', () => {
    let t = 1_000_000;
    const first = liveClaudeSessions(() => t);
    expect(first).toBeInstanceOf(Set);
    t += 1_000;
    expect(liveClaudeSessions(() => t)).toBe(first);
    expect(isSessionLive('ffffffff-ffff-4fff-8fff-ffffffffffff', () => t)).toBe(false);
  });
});

describe('parseCodexLockHolders (lsof -F n output)', () => {
  const T1 = '019a0000-1111-7111-8111-111111111111';
  const T2 = '019a0000-2222-7222-8222-222222222222';

  it('takes thread ids from the name (n…) lines, absolute or relative', () => {
    const out = ['p501', 'f12', `n/Users/me/.codex/thread-writer-locks/${T1}.lock`, 'f13', `n${T2}.lock`, ''].join('\n');
    expect(parseCodexLockHolders(out)).toEqual(new Set([T1, T2]));
  });

  it('ignores pid/fd lines, other lock files and other files', () => {
    const out = [`p${T1}.lock`, `f${T1}.lock`, 'n/x/.coordination.lock', 'n/x/session.lock', `n/x/${T1}.lock.bak`, 'n/x/readme.txt'].join('\n');
    expect(parseCodexLockHolders(out).size).toBe(0);
  });
});

describe('createCodexLiveness', () => {
  const T1 = '019a0000-1111-7111-8111-111111111111';
  const T2 = '019a0000-2222-7222-8222-222222222222';
  const locks = (...names: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'morse-codex-locks-'));
    for (const n of names) writeFileSync(join(dir, n), '');
    return dir;
  };

  it('asks about the thread lock files only, by full path, and reports the held ones (an orphaned file is not live)', () => {
    const dir = locks(`${T1}.lock`, `${T2}.lock`, '.coordination.lock', 'notes.txt');
    let lsofRuns = 0;
    const probed: string[] = [];
    const held = join(dir, `${T2}.lock`);
    const live = createCodexLiveness({ lockDir: dir, holders: (files) => (lsofRuns++, probed.push(...files), `p77\nf9\nn${held}\n`) });
    expect(live()).toEqual(new Set([T2]));
    expect(lsofRuns).toBe(1);
    expect(probed.sort()).toEqual([join(dir, `${T1}.lock`), held].sort());
  });

  it('no thread lock files: lsof is not run at all', () => {
    let runs = 0;
    const live = createCodexLiveness({ lockDir: locks('.coordination.lock'), holders: () => (runs++, '') });
    expect(live().size).toBe(0);
    expect(runs).toBe(0);
  });

  it('a missing folder or a failing lsof: nothing is live', () => {
    const missing = createCodexLiveness({ lockDir: join(tmpdir(), 'morse-no-codex-locks-here'), holders: () => `n${T1}.lock` });
    expect(missing().size).toBe(0);
    const failing = createCodexLiveness({
      lockDir: locks(`${T1}.lock`),
      holders: () => {
        throw new Error('spawn lsof ENOENT');
      },
    });
    expect(failing().size).toBe(0);
  });

  it('reuses the answer for ttlMs, then asks again', () => {
    let runs = 0;
    let t = 50;
    const live = createCodexLiveness({ lockDir: locks(`${T1}.lock`), ttlMs: 100, holders: () => (runs++, `n${T1}.lock`) });
    const clock = () => t;
    expect(live(clock)).toEqual(new Set([T1]));
    t = 149;
    live(clock);
    expect(runs).toBe(1);
    t = 150;
    live(clock);
    expect(runs).toBe(2);
  });

  it('the default holders really run lsof: a lock file nobody holds is not live', () => {
    const live = createCodexLiveness({ lockDir: locks(`${T1}.lock`) });
    expect(live().has(T1)).toBe(false);
  });
});
