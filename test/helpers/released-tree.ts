import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * (ADR-091) The RELEASED client — the one every user runs while v2 is being removed — as a source tree a test can
 * import from (its own `src/`, by absolute path), next to this branch's. `RELEASED_COMMIT` is origin/main when the
 * removal started (the release 20261116042458 line: v3, `addr1`, contacts per address — and still v2).
 *
 * Where it comes from: `MORSE_RELEASED_TREE` when set (a `git archive` of that commit with `node_modules` linked
 * in); else it is extracted here, once, from this repository's own history into the OS temp dir. null = neither
 * is possible (a shallow clone without that commit): the tests that need it say so and are skipped.
 */
export const RELEASED_COMMIT = '1afe17e';

const repo = resolve(__dirname, '..', '..');
let cached: string | null | undefined;

export function releasedTree(): string | null {
  if (cached !== undefined) return cached;
  const given = process.env['MORSE_RELEASED_TREE'];
  if (given) return (cached = existsSync(join(given, 'src', 'cluster', 'morse.ts')) ? resolve(given) : null);
  const dir = join(tmpdir(), `morse-released-${RELEASED_COMMIT}`);
  if (existsSync(join(dir, 'src', 'cluster', 'morse.ts')) && existsSync(join(dir, 'node_modules'))) return (cached = dir);
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${RELEASED_COMMIT}^{commit}`], { stdio: 'ignore' });
    const part = `${dir}.${process.pid}.partial`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    const tar = execFileSync('git', ['-C', repo, 'archive', '--format=tar', RELEASED_COMMIT], { maxBuffer: 512 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', part], { input: tar });
    symlinkSync(join(repo, 'node_modules'), join(part, 'node_modules'));
    try {
      renameSync(part, dir);
    } catch {
      rmSync(part, { recursive: true, force: true }); // another test process made it meanwhile
    }
    return (cached = existsSync(join(dir, 'src', 'cluster', 'morse.ts')) ? dir : null);
  } catch {
    return (cached = null);
  }
}
