import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, nodeStatusLine, nodeUpgradeHint } from '../src/node-version.js';

/**
 * ADR-084: the minimum Node.js is 22 for new installs; an install already running on an
 * older Node is never refused — it only gets one hint line (`morse status`, the updater's
 * log). The version is injected: these tests do not depend on the Node that runs them.
 */

const repo = resolve(__dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'morse-node-version-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('the Node.js hint (ADR-084)', () => {
  it('is one line on a Node older than 22', () => {
    for (const v of ['20.19.0', 'v20.20.2', '21.7.3', '18.20.4']) {
      const line = nodeStatusLine(v);
      expect(line, v).toBe(`node: v${v.replace(/^v/, '')} — Node.js 22+ is recommended: on older Node.js every update has to compile the database module from source`);
      expect(line).not.toContain('\n');
      expect(nodeUpgradeHint(v), v).toContain('Node.js 22+ is recommended');
    }
  });

  it('is absent on Node 22 and newer', () => {
    for (const v of ['22.0.0', '22.22.3', 'v24.14.1', '25.1.0', '26.0.0']) {
      expect(nodeStatusLine(v), v).toBeNull();
      expect(nodeUpgradeHint(v), v).toBeNull();
    }
  });

  it('never raises a false alarm on a version it cannot read', () => {
    for (const v of ['', 'unknown', 'x.y.z']) expect(nodeStatusLine(v), JSON.stringify(v)).toBeNull();
  });

  it('agrees with package.json engines and the installer', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { engines: { node: string } };
    expect(pkg.engines.node).toBe(`>=${MIN_NODE_MAJOR}`);
    expect(readFileSync(join(repo, 'site', 'install.sh'), 'utf8')).toContain(`[ "$NODE_MAJOR" -ge ${MIN_NODE_MAJOR} ]`);
  });

  it('morse status prints the line exactly when there is a hint, and its exit code does not change', async () => {
    const r = await new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'status'], {
        cwd: repo,
        env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home },
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (code) => done({ code, out, err }));
    });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('release: ');
    const expected = nodeStatusLine(); // the Node running this test: null on 22+
    const lines = r.out.split('\n').filter((l) => l.startsWith('node: '));
    expect(lines).toEqual(expected ? [expected] : []);
  }, 30_000);
});
