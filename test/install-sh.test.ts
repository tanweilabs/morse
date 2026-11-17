import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * ADR-045: site/install.sh must write the service definition with the node that ran the
 * install and the real path of the dist/cli.js it just installed under that npm's global
 * prefix — not `command -v morse` / `command -v node`. On one machine those were a user's
 * bash wrapper and another Node: launchd ran "node <bash script>" in a KeepAlive crash loop.
 *
 * Runs the real script with --no-join --dry-run-service against a fake world: a local
 * file:// site, a node directory whose npm is a stub that "installs" a tiny package, and
 * a PATH whose first entries are a decoy `morse` wrapper and a decoy `npm` of another node.
 */

const repo = resolve(__dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'morse-install-sh-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (p: string, body: string, mode = 0o644) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
  chmodSync(p, mode);
};

describe('install.sh Node.js check (ADR-084)', () => {
  /** A `node` that only answers what the installer asks before its version check. */
  const fakeNode = (dir: string, version: string) =>
    write(
      join(dir, 'node'),
      `#!/bin/bash\ncase "$1" in\n  --version) echo "v${version}" ;;\n  -p) echo "${version.split('.')[0]}" ;;\n  *) echo "fake node: unexpected $*" >&2; exit 97 ;;\nesac\n`,
      0o755,
    );
  const run = (version: string) => {
    const dir = join(root, `node-${version}`);
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    fakeNode(join(dir, 'bin'), version);
    return spawnSync('bash', [join(repo, 'site', 'install.sh'), '--no-join', '--no-service'], {
      env: { HOME: home, PATH: [join(dir, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'), MORSE_SITE: `file://${join(dir, 'no-site')}`, TMPDIR: dir },
      encoding: 'utf8',
      timeout: 60_000,
    });
  };

  it('refuses Node 20 and 21 before installing anything, says why and how to upgrade', () => {
    for (const version of ['20.19.0', '21.7.3']) {
      const r = run(version);
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stderr).toContain(`Morse needs Node.js 22 or newer (found v${version}).`);
      expect(r.stderr).toContain('better-sqlite3');
      expect(r.stderr).toContain('Node.js 20 reached end of life in April 2026');
      expect(r.stderr).toContain('Nothing was changed on this computer');
      expect(r.stderr).toMatch(/brew install node|nvm install 22/);
      expect(r.stderr).not.toContain('fake node: unexpected'); // nothing ran after the check
      expect(r.stdout).not.toContain('Installing');
    }
  });

  it('does not stop at the version check on Node 22', () => {
    // (the fake node has no npm, so the installer stops later — but not at the version check)
    const out = ((r) => `${r.stdout}\n${r.stderr}`)(run('22.11.0'));
    expect(out).not.toContain('(found v22.11.0)');
    expect(out).not.toContain('no longer ships a ready-made build');
  });
});

describe('install.sh service definition (ADR-045)', () => {
  it('uses the installing node and the installed dist/cli.js — not the morse / npm first on PATH', () => {
    const site = join(root, 'site');
    write(join(site, 'morse.tgz'), 'not really a tarball');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const prefix = join(root, 'prefix');
    const marker = join(root, 'cli-calls.log');

    // the node that runs the install, with "its" npm next to it (…/bin/node, …/lib/node_modules/npm)
    const nodeDir = join(root, 'nodeA');
    mkdirSync(join(nodeDir, 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(nodeDir, 'bin', 'node'));
    const fakeCli = `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(marker)}, process.execPath + ' ' + process.argv.slice(2).join(' ') + '\\n');
`;
    write(
      join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      `const fs = require('fs'), path = require('path');
const prefix = ${JSON.stringify(prefix)};
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'prefix') { console.log(prefix); process.exit(0); }
if (cmd === 'install' && rest.includes('-g')) {
  const pkg = path.join(prefix, 'lib', 'node_modules', 'anytoany');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), ${JSON.stringify(fakeCli)}, { mode: 0o755 });
  try { fs.symlinkSync(${JSON.stringify(join(repo, 'node_modules', 'better-sqlite3'))}, path.join(pkg, 'node_modules', 'better-sqlite3')); } catch {}
  fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
  try { fs.symlinkSync(path.join(pkg, 'dist', 'cli.js'), path.join(prefix, 'bin', 'morse')); } catch {}
  process.exit(0);
}
console.error('fake npm: unexpected ' + process.argv.slice(2).join(' '));
process.exit(1);
`,
    );

    // decoys first on PATH: a user's bash wrapper called morse, and the npm of some other node
    const decoy = join(root, 'decoy');
    write(join(decoy, 'morse'), '#!/bin/bash\necho "decoy morse $*"\n', 0o755);
    write(join(decoy, 'npm'), `#!/bin/bash\necho "decoy npm $*" >> ${JSON.stringify(marker)}\nexit 1\n`, 0o755);

    const env = {
      HOME: home,
      PATH: [decoy, join(nodeDir, 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      MORSE_SITE: `file://${site}`,
      TMPDIR: root,
    };
    const r = spawnSync('bash', [join(repo, 'site', 'install.sh'), '--no-join', '--dry-run-service'], { env, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);

    const node = join(nodeDir, 'bin', 'node');
    const entry = realpathSync(join(prefix, 'lib', 'node_modules', 'anytoany', 'dist', 'cli.js'));
    if (process.platform === 'darwin') {
      expect(out).toContain(`<string>${node}</string>\n    <string>${entry}</string>\n    <string>start</string>`);
    } else {
      expect(out).toContain(`ExecStart="${node}" "${entry}" start`);
    }
    expect(out).not.toContain(join(decoy, 'morse</string>'));
    // the installer drove the new package with the same node (setup ran), never the decoys
    const calls = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    expect(calls).not.toContain('decoy npm');
    // --no-join: nothing that can create an address runs — `relay show` and `address` both do on a computer
    // that has none (ADR-080: found on a real install; whether it has joined is read from config.json)
    expect(calls).toContain(' setup');
    for (const creating of [' relay show', ' address', ' join', ' agent add']) expect(calls, creating).not.toContain(creating);
    expect(calls).toMatch(/ setup\n/);
    expect(out).toContain(`'morse' in your PATH is ${join(decoy, 'morse')}`);
  });
});

describe('install.sh never names or renames an address by itself (ADR-088)', () => {
  const sh = readFileSync(join(repo, 'site', 'install.sh'), 'utf8');
  const code = sh
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('(ADR-091) nothing is named at install: --agent is accepted and ignored, there is no `join` — `morse address` makes the address', () => {
    expect(code).not.toMatch(/morse_ join /);
    expect(code).toMatch(/^AGENT=""$/m);
    expect(code.match(/--agent/g)).toHaveLength(1); // the option itself
    expect(code).toMatch(/morse_ address >\/dev\/null \|\| die/);
  });

  it('on an install that already has an address nothing is added, renamed or adopted — with or without --agent', () => {
    expect(code).not.toMatch(/morse_ (agent|address) (add|rename|set|adopt)/);
    expect(code).not.toMatch(/MORSE_AGENT|MYAGENT/);
    // what it says at the end names no address
    expect(code).not.toMatch(/address is named/);
    expect(code).toContain('echo "  Your address any time: morse address"');
  });
});

