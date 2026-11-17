import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { rawPublicKey, signManifest } from '../src/update/manifest.js';

/**
 * site/install.ps1 — the Windows installer (ADR-080). PowerShell is not available where
 * these tests run, so the script itself is never executed here: these are the rules it has
 * to keep as text, plus the one part that IS portable — the Node script it writes to a file
 * to check the signed release manifest, run here against real signatures. Everything else
 * (does it parse, does it install) is the real-machine checklist in docs/guides/windows.zh-CN.md.
 */

const repo = resolve(__dirname, '..');
const ps1Bytes = readFileSync(join(repo, 'site', 'install.ps1'));
const ps1 = ps1Bytes.toString('utf8');
const sh = readFileSync(join(repo, 'site', 'install.sh'), 'utf8');

/** The here-strings (`@' … '@`): embedded Node scripts, not PowerShell. */
const hereStrings = [...ps1.matchAll(/@'\r?\n([\s\S]*?)\r?\n'@/g)].map((m) => m[1]!);
/** PowerShell code only: no here-strings, no comment lines. */
const code = ps1
  .replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "''")
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

const verifyPs1 = hereStrings.find((h) => h.includes('morse-release-v1'))!;
const verifySh = /"\$NODE_BIN" -e '\n([\s\S]*?)\n\s*' "\$RELEASE_KEY"/.exec(sh)![1]!;

describe('install.ps1 as text: what Windows PowerShell 5.1 and `irm | iex` require', () => {
  it('is pure ASCII with no byte-order mark (5.1 decodes a fetched script as Latin-1 when there is no charset)', () => {
    expect([ps1Bytes[0], ps1Bytes[1], ps1Bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
    const bad = /[^\x09\x0a\x0d\x20-\x7e]/.exec(ps1);
    expect(bad ? `U+${bad[0].codePointAt(0)!.toString(16)} at ${bad.index}: ${ps1.slice(Math.max(0, bad.index - 30), bad.index + 10)}` : null).toBeNull();
  });

  it('never ends the host process: `irm | iex` runs in the user\'s own terminal — a failure throws', () => {
    expect(code).not.toMatch(/\bexit\b/i);
    expect(code).not.toMatch(/\[Environment\]::Exit|Stop-Process\s+-Id\s+\$PID/i);
    expect(code).toMatch(/function Fail\(\[string\]\$Text\) \{ throw /);
  });

  it('uses nothing newer than PowerShell 5.1: no && / ||, no ternary, no ??', () => {
    expect(code).not.toMatch(/&&|\|\|/);
    expect(code).not.toMatch(/\?\?/);
    expect(code).not.toMatch(/\$\w+\s+\?\s+[^:\n]+\s+:\s/);
  });

  it('never redirects a native program\'s error output (under $ErrorActionPreference = Stop that becomes a terminating error)', () => {
    expect(code).not.toMatch(/2>&1|2>\s*\$null|2>\s*\S/);
    expect(code).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('keeps its settings out of the user\'s session: everything runs inside one child scope', () => {
    const afterParams = code.slice(code.indexOf(')\n', code.indexOf('param(')) + 2).trim();
    expect(afterParams.startsWith('& {')).toBe(true);
    expect(afterParams.endsWith('}')).toBe(true);
  });

  it('runs node and npm by absolute path — never npm.cmd / npm.ps1 or a bare `morse`', () => {
    expect(code).toContain("'node_modules\\npm\\bin\\npm-cli.js'");
    expect(code).not.toMatch(/&\s*npm\b|npm\.cmd|\bnpx\b/);
    expect(code).not.toMatch(/&\s*morse\b/);
    expect(code).not.toMatch(/Invoke-Expression|\biex\s+\(/i); // it never evaluates anything it downloaded
  });

  it('asks for Node 22 and only tells how to install it — it never installs Node itself', () => {
    expect(code).toContain('$MinNode = 22');
    expect(code).toContain('winget install OpenJS.NodeJS.LTS');
    expect(code).not.toMatch(/&\s*winget|Start-Process\s+winget/i);
  });

  it('removes morse.ps1 / anyd.ps1 (the default script policy blocks them; morse.cmd stays), stops the old daemon before npm, registers the logon start', () => {
    expect(code).toContain("@('morse.ps1', 'anyd.ps1')");
    expect(code.indexOf("@($entry, 'stop')")).toBeGreaterThan(0);
    expect(code.indexOf("@($entry, 'stop')")).toBeLessThan(code.indexOf("'install', '-g'"));
    expect(code).toContain("@($entry, 'autostart', 'enable')");
    expect(code).toContain("@($entry, 'start', '--background')");
    // … and once more AFTER the install, with the new package: a daemon installed somewhere else (another
    // Node, another npm prefix) is not at $entry before the install, so the first stop never reaches it —
    // it would keep running the old copy while the task and hooks point at the new one
    const stops = [...code.matchAll(/@\(\$entry, 'stop'\)/g)].map((m) => m.index!);
    expect(stops).toHaveLength(2);
    expect(stops[1]!).toBeGreaterThan(code.indexOf("'install', '-g'"));
    expect(stops[1]!).toBeLessThan(code.indexOf("@($entry, 'start', '--background')"));
  });
});

describe('install.ps1 -NoJoin never joins', () => {
  it('whether this computer has an address is read from config.json — `morse relay show` / `morse address` create an address where there is none', () => {
    // found on the first real-machine run (2026-11-15): -NoJoin still registered an address, through `relay show`
    expect(code).not.toContain("'relay', 'show'");
    expect(code).toMatch(/function Test-Address \{[\s\S]*?config\.json[\s\S]*?ConvertFrom-Json/);
    // `morse address` (which creates one too) runs only where -NoJoin was not given, or once an address is known
    const make = code.indexOf("@($entry, 'address')");
    expect(make).toBeGreaterThan(0);
    expect(code.slice(make - 300, make)).toContain('if ((-not $skipJoin) -and (-not (Test-Address))) {');
    const show = code.indexOf("@($entry, 'address')", make + 1);
    expect(code.slice(show - 200, show)).toContain('if (Test-Address) {');
  });
});

describe('install.ps1 checks the signed release manifest exactly as install.sh does — and has no way around it', () => {
  it('carries the key placeholder once, for the site build to fill in', () => {
    expect(ps1.match(/__MORSE_RELEASE_PUBLIC_KEY__/g)).toHaveLength(1);
    expect(code).toContain("$ReleaseKey = '__MORSE_RELEASE_PUBLIC_KEY__'");
  });

  it('the embedded verification script is install.sh\'s, line for line (only where the arguments start, and an ASCII "..." for the ellipsis)', () => {
    const norm = (s: string) =>
      s
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n')
        .replace('process.argv.slice(1)', 'process.argv.slice(N)')
        .replace('process.argv.slice(2)', 'process.argv.slice(N)')
        .replace('…', '...');
    expect(norm(verifyPs1)).toBe(norm(verifySh));
    expect(verifyPs1).toContain('morse-release-v1');
  });

  it('stricter than install.sh: an unstamped copy, a site without a manifest, or a failed check all refuse — before anything is installed', () => {
    const noKey = code.indexOf("if ($ReleaseKey.StartsWith('__')) { Fail ");
    const noManifest = code.indexOf('has no signed release manifest');
    const check = code.indexOf('$verifyFile, $ReleaseKey, $manifest, $signature, $tgz');
    const refused = code.indexOf('refusing to install');
    const install = code.indexOf("'install', '-g'");
    for (const at of [noKey, noManifest, check, refused]) {
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(install);
    }
    // no switch, parameter or environment variable skips the check
    expect(code).not.toMatch(/skip.?(sig|verif|check)|no.?verify|insecure|unsigned|allow.?unsigned/i);
    // every refusal is a throw: `Fail` on the same line
    for (const at of [noManifest, refused]) expect(code.slice(code.lastIndexOf('\n', at), at)).toContain('Fail');
  });

  describe('the verification script, run by node against real signatures', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'morse-ps1-verify-'));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));
    const { privateKey } = generateKeyPairSync('ed25519');
    const key = rawPublicKey(privateKey);
    const other = rawPublicKey(generateKeyPairSync('ed25519').privateKey);
    const tgz = Buffer.from('not really a tarball, but bytes with a sha256');
    const manifest = Buffer.from(`${JSON.stringify({ schema: 1, name: 'anytoany', version: '0.0.1', release: 20261115000000, file: 'morse.tgz', size: tgz.length, sha256: createHash('sha256').update(tgz).digest('hex') }, null, 2)}\n`);
    const sig = `${signManifest(manifest, privateKey)}\n`;
    const script = join(tmp, 'verify.js');
    writeFileSync(script, verifyPs1);
    let n = 0;
    const run = (o: { key?: string; manifest?: Buffer; sig?: string; tgz?: Buffer } = {}) => {
      const dir = join(tmp, String(n++));
      const f = (name: string, body: string | Buffer) => {
        const p = `${dir}-${name}`;
        writeFileSync(p, body);
        return p;
      };
      const args = [o.key ?? key, f('version.json', o.manifest ?? manifest), f('version.json.sig', o.sig ?? sig), f('morse.tgz', o.tgz ?? tgz)];
      const ps = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      // and install.sh's own copy, the way install.sh runs it — the two must agree
      const bash = spawnSync(process.execPath, ['-e', verifySh, ...args], { encoding: 'utf8' });
      expect(ps.status, `install.sh's script answered ${bash.status}`).toBe(bash.status);
      return { code: ps.status, out: `${ps.stdout}${ps.stderr}` };
    };

    it('accepts the package the signed manifest names', () => {
      expect(run()).toEqual({ code: 0, out: 'signature OK: 0.0.1 release 20261115000000\n' });
    });

    it('refuses a package that was changed', () => {
      const r = run({ tgz: Buffer.from('another tarball') });
      expect(r.code).toBe(1);
      expect(r.out).toContain('morse.tgz does not match the signed manifest');
    });

    it('refuses a manifest that was changed, a signature by another key, a missing or garbage signature', () => {
      const edited = Buffer.from(manifest.toString('utf8').replace('"release": 20261115000000', '"release": 20991115000000'));
      const otherSig = `${signManifest(manifest, generateKeyPairSync('ed25519').privateKey)}\n`;
      for (const o of [{ manifest: edited }, { key: other }, { sig: otherSig }, { sig: '' }, { sig: 'AAAA\n' }]) {
        const r = run(o);
        expect(r.code).toBe(1);
        expect(r.out).toContain('is not signed by the Morse release key');
      }
    });

    it('a key that is not a key at all is a refusal too (non-zero), never an accept', () => {
      expect(run({ key: '__MORSE_RELEASE_PUBLIC_KEY__' }).code).not.toBe(0);
      expect(run({ key: '' }).code).not.toBe(0);
    });
  });
});

describe('install.sh sends Windows users to the PowerShell installer', () => {
  it('names the command instead of "install WSL2"', () => {
    expect(sh).toContain('irm $SITE/install.ps1 | iex');
    expect(sh).not.toContain('Windows is not supported yet');
  });
});

describe('install.ps1 never names or renames an address by itself (ADR-088)', () => {
  it('no default name (it was `win`): -Agent / MORSE_AGENT are accepted and ignored (ADR-091)', () => {
    expect(code).not.toMatch(/'win'/);
    // (ADR-091) nothing is named at install: -Agent / -Name are accepted and ignored, and there is no `join`
    expect(code).not.toMatch(/agentArgs|'join'/);
    expect(code).not.toMatch(/'(agent|address)', '(add|rename|set|adopt)'/);
  });
});

