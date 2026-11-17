import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { addressFromPublicKey, rawPublicKey } from '../../src/identity/address.js';
import { loadPrimaryAddress } from '../../src/identity/address-key.js';
import { addressFromPublicKey as relayAddress } from '../../relay-cf/src/address.js';
import { entriesFor, parseAliasRecord, type AliasRecord } from '../../relay-cf/src/aliases.js';
import { b64decode, deviceIdFromCert as relayDeviceId, ed25519PublicKeyFromCert } from '../../relay-cf/src/crypto.js';
// @ts-expect-error — a plain .mjs admin script, no type declarations
import * as script from '../aliases-export.mjs';

/**
 * scripts/aliases-export.mjs (relay admin tooling, identity v3 P2 — spec §12.3 step 4): the
 * frozen old-alias table is built from the relay's own data and verified before anything
 * is written. The addresses must be the ones the migrated clients will log in with (the
 * first agent of a computer reuses its device key, spec §12.2), and every record must be
 * one the relay accepts (relay-cf/src/aliases.ts).
 */

interface Source {
  handles: Array<{ handle: string; devices: Array<{ id: string; cert?: string | null }>; agents: Array<{ agent: string; device: string }>; default?: string | null }>;
}
interface Built {
  records: Array<{ key: string; value: AliasRecord }>;
  problems: string[];
  notes: string[];
}
const build = (source: Source): Built => (script as { buildAliasRecords(s: Source): Built }).buildAliasRecords(source);
const toBulkPut = (records: Built['records']): Array<{ key: string; value: string }> => (script as { toBulkPut(r: Built['records']): Array<{ key: string; value: string }> }).toBulkPut(records);

const tmp = mkdtempSync(join(tmpdir(), 'morse-aliases-export-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tmpFile = (name: string) => join(tmp, `${n++}-${name}`);

/** A computer as the relay knows it: device ID + certificate; `address` is what its client will use in v3. */
const device = () => {
  const home = mkdtempSync(join(tmp, 'home-'));
  const id = loadOrCreateIdentity(home);
  const x509 = new X509Certificate(id.certPem);
  return { id: id.id, cert: x509.raw.toString('base64'), address: addressFromPublicKey(rawPublicKey(x509.publicKey)), home };
};
const mini = device();
const air = device();
const pro = device();

// a self-signed certificate with an EC P-256 key (openssl, CN=anytoany): not a Morse device key
const EC_CERT =
  'MIICDDCCAbICCQC706nD7K9rjDAKBggqhkjOPQQDAjATMREwDwYDVQQDDAhhbnl0b2FueTAgFw0yNjExMTQxMzQ5MDRaGA8yMTI2MTAyMTEzNDkwNFowEzERMA8GA1UEAwwIYW55dG9hbnkwggFLMIIBAwYHKoZIzj0CATCB9wIBATAsBgcqhkjOPQEBAiEA/////wAAAAEAAAAAAAAAAAAAAAD///////////////8wWwQg/////wAAAAEAAAAAAAAAAAAAAAD///////////////wEIFrGNdiqOpPns+u9VXaYhrxlHQawzFOw9jvOPD4n0mBLAxUAxJ02CIbnBJNqZnjhE50mt4GffpAEQQRrF9Hy4SxCR/i85uVjpEDydwN9gS3rM6D0oTlF2JjClk/jQuL+Gn+bjufrSnwPnhYrzjNXazFezsu2QGg3v1H1AiEA/////wAAAAD//////////7zm+q2nF56E87nKwvxjJVECAQEDQgAEaAISrKEt+E/t5FwndR4MckpAfbYaVJROlg64wzLDRuS+20J+WvUDtvPXHzteJCOzCkcT+7boUWv678rVJFed+DAKBggqhkjOPQQDAgNIADBFAiEAjMrvqhWpaor3OYSvVspcKsxnNfCpTNPtnMq/WQos45QCIARPC16WFFvYqIGgHoT4QSMiN0COWbY01Q2c0yxs7TtX';

const good: Source = {
  handles: [
    {
      handle: 'alice',
      devices: [
        { id: mini.id, cert: mini.cert },
        { id: air.id, cert: air.cert },
      ],
      agents: [
        { agent: 'mini', device: mini.id },
        { agent: 'air', device: air.id },
        { agent: 'claude', device: mini.id },
      ],
      default: 'mini',
    },
    { handle: 'k7f3a9xq', devices: [{ id: pro.id, cert: pro.cert }], agents: [{ agent: 'pro', device: pro.id }], default: 'pro' },
  ],
};

describe('buildAliasRecords', () => {
  it('one record per handle; each agent gets the address of the device key that hosts it', () => {
    const r = build(good);
    expect(r.problems).toEqual([]);
    expect(r.records).toEqual([
      { key: 'alias:alice', value: { v: 1, handle: 'alice', default: 'mini', agents: { air: air.address, claude: mini.address, mini: mini.address } } },
      { key: 'alias:k7f3a9xq', value: { v: 1, handle: 'k7f3a9xq', default: 'pro', agents: { pro: pro.address } } },
    ]);
  });

  it('the addresses are the ones the clients compute, three ways', async () => {
    const r = build(good);
    const agents = r.records[0]!.value.agents;
    for (const d of [mini, air]) {
      const name = d === mini ? 'mini' : 'air';
      // the client's first address of that computer (the device key reused, spec §12.2)
      expect(agents[name]).toBe(loadPrimaryAddress(d.home).address);
      // the relay's own WebCrypto reading of the same certificate
      const der = b64decode(d.cert);
      expect(agents[name]).toBe(await relayAddress(ed25519PublicKeyFromCert(der)));
      expect(await relayDeviceId(der)).toBe(d.id);
    }
    expect(agents['claude']).toBe(agents['mini']); // two agents on one computer: one address
  });

  it('every record is one the relay accepts, and answers as the wire contract says', () => {
    const r = build(good);
    for (const rec of r.records) expect(parseAliasRecord(JSON.parse(JSON.stringify(rec.value)))).toEqual(rec.value);
    expect(entriesFor(r.records[0]!.value)).toEqual([
      { name: 'alice', address: mini.address, agent: 'mini', default: true },
      { name: 'alice/air', address: air.address, agent: 'air' },
      { name: 'alice/claude', address: mini.address, agent: 'claude' },
    ]);
    expect(entriesFor(r.records[0]!.value, 'air')).toEqual([{ name: 'alice/air', address: air.address, agent: 'air' }]);
  });

  it('refuses an agent whose device is not an allowlisted device of that handle', () => {
    const r = build({
      handles: [
        { handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }], agents: [{ agent: 'mini', device: mini.id }, { agent: 'air', device: air.id }], default: 'mini' },
        // air is allowlisted — under ANOTHER handle: still not alice's
        { handle: 'bob', devices: [{ id: air.id, cert: air.cert }], agents: [], default: null },
      ],
    });
    expect(r.records).toEqual([{ key: 'alias:alice', value: { v: 1, handle: 'alice', default: 'mini', agents: { mini: mini.address } } }]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/alice\/air/);
    expect(r.problems[0]).toMatch(/not an allowlisted device of alice/);
    expect(r.problems[0]).toContain(air.id.slice(0, 7));
  });

  it('refuses an agent whose device has no certificate on the relay', () => {
    for (const cert of [undefined, null, '']) {
      const r = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert }], agents: [{ agent: 'mini', device: mini.id }], default: 'mini' }] });
      expect(r.records).toEqual([]);
      expect(r.problems.some((p) => /alice\/mini/.test(p) && /no certificate/.test(p))).toBe(true);
    }
  });

  it('refuses a certificate that is not the one the device ID stands for', () => {
    const r = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: air.cert }], agents: [{ agent: 'mini', device: mini.id }], default: 'mini' }] });
    expect(r.records).toEqual([]);
    expect(r.problems.some((p) => /alice\/mini/.test(p) && /does not match device/.test(p))).toBe(true);
    // one flipped byte is another certificate
    const der = Buffer.from(mini.cert, 'base64');
    der[der.length - 1] = der[der.length - 1]! ^ 1;
    const r2 = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: der.toString('base64') }], agents: [{ agent: 'mini', device: mini.id }], default: 'mini' }] });
    expect(r2.records).toEqual([]);
    expect(r2.problems.some((p) => /does not match device/.test(p))).toBe(true);
  });

  it('refuses a key that is not Ed25519, and bytes that are not a certificate', async () => {
    const ecId = await relayDeviceId(b64decode(EC_CERT));
    const r = build({ handles: [{ handle: 'alice', devices: [{ id: ecId, cert: EC_CERT }], agents: [{ agent: 'mini', device: ecId }], default: 'mini' }] });
    expect(r.records).toEqual([]);
    expect(r.problems.some((p) => /alice\/mini/.test(p) && /not Ed25519/.test(p))).toBe(true);

    const junk = Buffer.from('not a certificate at all').toString('base64');
    const junkId = await relayDeviceId(b64decode(junk));
    const r2 = build({ handles: [{ handle: 'alice', devices: [{ id: junkId, cert: junk }], agents: [{ agent: 'mini', device: junkId }], default: 'mini' }] });
    expect(r2.records).toEqual([]);
    expect(r2.problems.some((p) => /alice\/mini/.test(p) && /cannot read the certificate/.test(p))).toBe(true);
  });

  it('a refused agent is left out; the rest of the handle stays', () => {
    const r = build({
      handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }, { id: air.id, cert: null }], agents: [{ agent: 'mini', device: mini.id }, { agent: 'air', device: air.id }], default: 'mini' }],
    });
    expect(r.records).toEqual([{ key: 'alias:alice', value: { v: 1, handle: 'alice', default: 'mini', agents: { mini: mini.address } } }]);
    expect(r.problems).toHaveLength(1);
  });

  it('no default → default: null (not a problem); a default that was refused → null and a problem', () => {
    const none = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }], agents: [{ agent: 'mini', device: mini.id }] }] });
    expect(none.problems).toEqual([]);
    expect(none.records[0]!.value).toEqual({ v: 1, handle: 'alice', default: null, agents: { mini: mini.address } });
    expect(none.notes.some((x) => /alice/.test(x) && /no default/.test(x))).toBe(true);
    expect(entriesFor(none.records[0]!.value)).toEqual([{ name: 'alice/mini', address: mini.address, agent: 'mini' }]);

    const refused = build({
      handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }, { id: air.id, cert: null }], agents: [{ agent: 'mini', device: mini.id }, { agent: 'air', device: air.id }], default: 'air' }],
    });
    expect(refused.records[0]!.value).toEqual({ v: 1, handle: 'alice', default: null, agents: { mini: mini.address } });
    expect(refused.problems.some((p) => /default agent "air"/.test(p))).toBe(true);

    const unknown = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }], agents: [{ agent: 'mini', device: mini.id }], default: 'ghost' }] });
    expect(unknown.records[0]!.value.default).toBeNull();
    expect(unknown.problems.some((p) => /default agent "ghost"/.test(p))).toBe(true);
  });

  it('a handle with no agents gets no record (a note, not a problem)', () => {
    const r = build({ handles: [{ handle: 'alice', devices: [{ id: mini.id, cert: mini.cert }], agents: [], default: null }] });
    expect(r.records).toEqual([]);
    expect(r.problems).toEqual([]);
    expect(r.notes.some((x) => /alice/.test(x) && /no agents/.test(x))).toBe(true);
  });

  it('bad or repeated names are refused; what is left of the handle stays', () => {
    const dev = { devices: [{ id: mini.id, cert: mini.cert }] };
    const on = (agent: string) => ({ agent, device: mini.id });
    const r = build({
      handles: [
        { handle: 'Alice', ...dev, agents: [on('mini')], default: 'mini' },
        { handle: 'alias:x', ...dev, agents: [on('mini')], default: 'mini' },
        { handle: 'bob', ...dev, agents: [on('Bad_Name'), on('ok'), on('ok'), on('fine')], default: 'ok' },
        // the same handle twice: which one is right? neither is written
        { handle: 'carol', ...dev, agents: [on('mini')], default: 'mini' },
        { handle: 'carol', ...dev, agents: [on('mini')], default: 'mini' },
      ],
    });
    expect(r.records).toEqual([{ key: 'alias:bob', value: { v: 1, handle: 'bob', default: null, agents: { fine: mini.address } } }]);
    expect(r.problems.some((p) => /"Alice"/.test(p) && /not a valid handle/.test(p))).toBe(true);
    expect(r.problems.some((p) => /"alias:x"/.test(p) && /not a valid handle/.test(p))).toBe(true);
    expect(r.problems.some((p) => /bob/.test(p) && /"Bad_Name"/.test(p) && /not a valid agent name/.test(p))).toBe(true);
    expect(r.problems.filter((p) => /bob\/ok/.test(p) && /more than once/.test(p))).toHaveLength(1);
    expect(r.problems.some((p) => /bob/.test(p) && /default agent "ok"/.test(p))).toBe(true);
    expect(r.problems.filter((p) => /carol/.test(p) && /more than once/.test(p))).toHaveLength(1);
    expect(r.problems).toHaveLength(6);
  });

  it('malformed source data is an error, not an empty table', () => {
    expect(() => build({} as Source)).toThrow(/handles/);
    expect(() => build({ handles: [{ handle: 'alice' }] } as unknown as Source)).toThrow(/alice/);
  });

  it('toBulkPut: the file `wrangler kv bulk put` takes — values are JSON strings', () => {
    const r = build(good);
    const bulk = toBulkPut(r.records);
    expect(bulk.map((x) => x.key)).toEqual(['alias:alice', 'alias:k7f3a9xq']);
    for (const [i, x] of bulk.entries()) {
      expect(typeof x.value).toBe('string');
      expect(JSON.parse(x.value)).toEqual(r.records[i]!.value);
    }
  });
});

// --- the CLI -----------------------------------------------------------------------------

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [join(repo, 'scripts', 'aliases-export.mjs'), ...args], { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
const sourceFile = (s: Source) => {
  const f = tmpFile('source.json');
  writeFileSync(f, JSON.stringify(s));
  return f;
};
const withProblem: Source = { handles: [...good.handles, { handle: 'carol', devices: [{ id: air.id, cert: null }], agents: [{ agent: 'air', device: air.id }], default: 'air' }] };

describe('aliases-export CLI (--from: no relay involved)', () => {
  it('writes the bulk file, prints the summary and the exact command to load it', async () => {
    const out = tmpFile('aliases.json');
    const r = await cli(['--from', sourceFile(good), '--out', out, '--namespace-id', 'abc123']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 handles/);
    expect(r.out).toMatch(/2 records/);
    expect(r.out).toMatch(/6 old names/); // alice, alice/mini, alice/air, alice/claude, k7f3a9xq, k7f3a9xq/pro
    const bulk = JSON.parse(readFileSync(out, 'utf8')) as Array<{ key: string; value: string }>;
    expect(bulk.map((x) => x.key)).toEqual(['alias:alice', 'alias:k7f3a9xq']);
    expect(JSON.parse(bulk[0]!.value)).toEqual({ v: 1, handle: 'alice', default: 'mini', agents: { air: air.address, claude: mini.address, mini: mini.address } });
    expect(r.out).toContain(`wrangler kv bulk put ${out} --namespace-id abc123 --remote`);
    expect(r.out).toMatch(/0 problems/);
  });

  it('problems: exits 1 and writes nothing, unless --allow-problems', async () => {
    const out = tmpFile('aliases.json');
    const src = sourceFile(withProblem);
    const r = await cli(['--from', src, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/carol\/air/);
    expect(r.out).toMatch(/1 problem/);
    expect(existsSync(out)).toBe(false);

    const ok = await cli(['--from', src, '--out', out, '--allow-problems']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/carol\/air/);
    expect((JSON.parse(readFileSync(out, 'utf8')) as Array<{ key: string }>).map((x) => x.key)).toEqual(['alias:alice', 'alias:k7f3a9xq']);
  });

  it('--dry-run writes nothing', async () => {
    const out = tmpFile('aliases.json');
    const r = await cli(['--from', sourceFile(good), '--out', out, '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run/);
    expect(existsSync(out)).toBe(false);
  });

  it('usage errors exit 2: no source, both sources, unknown flags, an admin key on the command line', async () => {
    expect((await cli([])).code).toBe(2);
    expect((await cli(['--from', sourceFile(good), '--relay', 'https://relay.example'])).code).toBe(2);
    expect((await cli(['--from', sourceFile(good), '--frobnicate'])).code).toBe(2);
    const k = await cli(['--relay', 'https://relay.example', '--admin-key', 'secret-value']);
    expect(k.code).toBe(2);
    expect(k.out).toMatch(/--admin-key-env/);
    expect(k.out).not.toContain('secret-value');
  });

  it('the admin key comes from the named environment variable; plain http only to this computer', async () => {
    const missing = await cli(['--relay', 'https://relay.example', '--admin-key-env', 'NO_SUCH_VAR_HERE']);
    expect(missing.code).toBe(2);
    expect(missing.out).toMatch(/NO_SUCH_VAR_HERE/);
    const plain = await cli(['--relay', 'http://relay.example', '--admin-key-env', 'K'], { K: 'secret-value' });
    expect(plain.code).toBe(2);
    expect(plain.out).toMatch(/https/);
    expect(plain.out).not.toContain('secret-value');
  });
});

describe('aliases-export CLI against the relay admin API (a local stand-in; read-only)', () => {
  const ADMIN = 'test-admin-key-1234';
  const seen: Array<{ method: string; url: string; auth: string }> = [];
  let server: Server | null = null;
  afterAll(() => server?.close());

  /** What the Worker's admin routes answer (relay-cf/src/worker.ts) for `good` + carol. */
  const start = (opts: { certs: boolean }): Promise<string> =>
    new Promise((done) => {
      server?.close();
      const byHandle = new Map(withProblem.handles.map((h) => [h.handle, h]));
      server = createServer((req: IncomingMessage, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? '' });
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${ADMIN}`) return json(401, { error: 'unauthorized' });
        if (req.method !== 'GET') return json(405, {});
        if (url.pathname === '/admin/allowlist') {
          return json(200, { devices: [...withProblem.handles.flatMap((h) => h.devices.map((d) => ({ id: d.id, handle: h.handle, name: 'x', addedAt: 'now' }))), { id: 'ZZZZZZZ-NOHANDLE', name: 'legacy' }] });
        }
        const m = /^\/admin\/handles\/([^/]+)$/.exec(url.pathname);
        const h = m ? byHandle.get(decodeURIComponent(m[1]!)) : undefined;
        if (h) {
          const withCerts = opts.certs && url.searchParams.get('certs') === '1';
          return json(200, {
            handle: h.handle,
            devices: h.devices.map((d) => ({ id: d.id, handle: h.handle, name: 'x', ...(withCerts ? { cert: d.cert ?? null } : {}) })),
            default: h.default ?? null,
            agents: h.agents.map((a) => ({ ...a, addedAt: 1 })),
            nickname: null,
            claim: null,
          });
        }
        return json(404, {});
      });
      server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    });

  it('reads allowlist + handles (+ certs) with GETs only, the key from the environment', async () => {
    const relay = await start({ certs: true });
    seen.length = 0;
    const out = tmpFile('aliases.json');
    const saved = tmpFile('source.json');
    const r = await cli(['--relay', relay, '--admin-key-env', 'MY_RELAY_KEY', '--out', out, '--save-source', saved, '--allow-problems'], { MY_RELAY_KEY: ADMIN });
    expect(r.out).not.toContain(ADMIN);
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((q) => q.method === 'GET' && q.auth === `Bearer ${ADMIN}`)).toBe(true);
    expect(seen.map((q) => q.url).sort()).toEqual(['/admin/allowlist', '/admin/handles/alice?certs=1', '/admin/handles/carol?certs=1', '/admin/handles/k7f3a9xq?certs=1']);
    const bulk = JSON.parse(readFileSync(out, 'utf8')) as Array<{ key: string; value: string }>;
    expect(bulk.map((x) => x.key)).toEqual(['alias:alice', 'alias:k7f3a9xq']);
    expect((JSON.parse(bulk[0]!.value) as AliasRecord).agents['air']).toBe(air.address);
    expect(r.out).toMatch(/carol\/air/); // no certificate → refused, reported
    expect(r.out).toMatch(/ZZZZZZZ/); // a device with no handle: noted
    expect(r.out).toContain(`curl ${relay}/v3/alias/alice`);
    // the saved source reproduces the same table offline
    const again = tmpFile('aliases.json');
    expect((await cli(['--from', saved, '--out', again, '--allow-problems'])).code).toBe(0);
    expect(readFileSync(again, 'utf8')).toBe(readFileSync(out, 'utf8'));
  });

  it('a wrong key, or a relay that does not return certificates yet, stops with a clear message', async () => {
    const relay = await start({ certs: true });
    const bad = await cli(['--relay', relay, '--admin-key-env', 'K'], { K: 'wrong' });
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/401/);
    const old = await start({ certs: false });
    const out = tmpFile('aliases.json');
    const r = await cli(['--relay', old, '--admin-key-env', 'K', '--out', out], { K: ADMIN });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/does not return device certificates/);
    expect(existsSync(out)).toBe(false);
  });
});
