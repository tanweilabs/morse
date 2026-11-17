// The GitHub Actions budget (ADR-015, ADR-080, ADR-084; CLAUDE.md rule 7), checked on the workflow files
// themselves: per-push CI is one Ubuntu job on Node 22; macOS and Windows run only weekly or by hand;
// a newer run cancels the older one; documentation-only changes run nothing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = (file: string): string => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');

/** The events under the top-level `on:` block (its keys indented by two spaces). */
function triggers(yml: string): string[] {
  const block = /^on:\n((?:(?: {2,}.*)?\n)+)/m.exec(yml)?.[1] ?? '';
  return [...block.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]!).sort();
}

/** Every value of a `key: value` line, wherever it is in the file (comments stripped). */
function values(yml: string, key: string): string[] {
  const out: string[] = [];
  for (const raw of yml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const m = new RegExp(`^\\s*-?\\s*${key}:\\s*(.+)$`).exec(line);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/** The paths-ignore list of one trigger. */
function ignoredPaths(yml: string, event: string): string[] {
  const block = new RegExp(`^ {2}${event}:\\n((?: {4,}.*\\n)+)`, 'm').exec(yml)?.[1] ?? '';
  const list = /^ {4}paths-ignore:.*\n((?: {6}- .*\n)+)/m.exec(block)?.[1] ?? '';
  return [...list.matchAll(/- '([^']+)'/g)].map((m) => m[1]!);
}

describe('per-push CI (ci.yml): Ubuntu, Node 22, nothing else', () => {
  const yml = workflow('ci.yml');

  it('runs on a push to main and on pull requests — no schedule, no other event', () => {
    expect(triggers(yml)).toEqual(['pull_request', 'push']);
    expect(values(yml, 'branches')).toEqual(['[main]']);
  });

  it('one job, on ubuntu-latest — never macOS or Windows', () => {
    expect(values(yml, 'runs-on')).toEqual(['ubuntu-latest']);
    expect(yml).not.toMatch(/runs-on:.*(macos|windows)/i);
  });

  it('ADR-084: Node 22 only, with no matrix axis to grow', () => {
    expect(values(yml, 'node-version')).toEqual(['22']);
    expect(yml).not.toMatch(/^\s*(matrix|os|node):/m);
  });

  it('a newer run cancels the older one, and docs-only changes do not run it', () => {
    expect(values(yml, 'cancel-in-progress')).toEqual(['true']);
    for (const event of ['push', 'pull_request']) {
      expect(ignoredPaths(yml, event), event).toEqual(expect.arrayContaining(['**/*.md', 'docs/**']));
    }
  });

  it('builds and runs the whole suite', () => {
    expect(values(yml, 'run')).toEqual(['npm ci', 'npm run build', 'npm test']);
  });
});

describe('macOS (ci-macos.yml): weekly or by hand', () => {
  const yml = workflow('ci-macos.yml');

  it('is started only by its schedule (once a week) or by hand', () => {
    expect(triggers(yml)).toEqual(['schedule', 'workflow_dispatch']);
    expect(values(yml, 'cron')).toHaveLength(1);
    expect(values(yml, 'cron')[0]).toMatch(/^'\d+ \d+ \* \* [0-6]'$/);
  });

  it('one macOS job, superseded runs cancelled', () => {
    expect(values(yml, 'runs-on')).toEqual(['macos-latest']);
    expect(values(yml, 'cancel-in-progress')).toEqual(['true']);
  });
});

describe('Windows (ci-windows.yml, ADR-080): weekly or by hand, a subset of the suite', () => {
  const yml = workflow('ci-windows.yml');

  it('is never run by a push or a pull request — its schedule (once a week) or by hand only', () => {
    expect(triggers(yml)).toEqual(['schedule', 'workflow_dispatch']);
    expect(yml).not.toMatch(/^\s*(push|pull_request|pull_request_target):/m);
    expect(values(yml, 'cron')).toHaveLength(1);
    expect(values(yml, 'cron')[0]).toMatch(/^'\d+ \d+ \* \* [0-6]'$/);
  });

  it('one Windows job without a matrix, superseded runs cancelled, stopped after under 20 minutes', () => {
    expect(values(yml, 'runs-on')).toEqual(['windows-latest']);
    expect(yml).not.toMatch(/matrix:/);
    expect(values(yml, 'cancel-in-progress')).toEqual(['true']);
    const limit = values(yml, 'timeout-minutes');
    expect(limit).toHaveLength(1);
    expect(Number(limit[0])).toBeLessThan(20);
  });

  it('runs named test files, never the whole suite', () => {
    expect(yml).toMatch(/npx vitest run test\/\S+\.test\.ts/);
    expect(yml).not.toMatch(/run: npm test\b/);
  });

  it('says what it costs, next to the workflow (CLAUDE.md rule 7)', () => {
    expect(yml).toMatch(/billed minutes a month/);
  });
});
