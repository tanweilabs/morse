#!/usr/bin/env node
// Build the frozen old-alias table of identity v3 (P2) — run ONCE by the relay admin.
// Spec: docs/specs/identity-v3.zh-CN.md §7, §10.2, §12.3 step 4; relay side: relay-cf/src/aliases.ts;
// runbook: docs/DEPLOY-CLOUDFLARE.md "旧别名表".
//
//   MORSE_ADMIN_KEY=… node scripts/aliases-export.mjs --relay https://relay.example [--out aliases.json]
//   node scripts/aliases-export.mjs --from source.json [--out aliases.json]
//
//   --relay <url>           read the source data from that relay's admin API (GET only)
//   --admin-key-env <NAME>  the environment variable holding the admin key (default MORSE_ADMIN_KEY);
//                           the key itself is never taken from the command line
//   --from <file.json>      read the source data from a file instead ({handles: […]}, see below)
//   --out <file>            where to write the table (default aliases.json)
//   --save-source <file>    also keep the source data that was read (for the record, or for --from)
//   --namespace-id <id>     the ALLOWLIST KV namespace id for the printed command
//                           (default: the one in relay-cf/wrangler.toml)
//   --dry-run               build, verify and print, write no table
//   --allow-problems        write the table even when some agents were refused (they are left out)
//
// What it does: every v2 name — `alice` (a readable name or an 8-character random handle) and
// `alice/air` (handle/agent) — becomes an alias of the v3 address of the agent it meant. In v3
// the first agent of a computer keeps the computer's device key, so that address is computed
// from the Ed25519 key inside the device certificate the relay already holds:
//
//   source   {handles: [{handle, devices: [{id, cert}], agents: [{agent, device}], default}]}
//            = KV allowlist (handle → devices) + AgentBook (agent → device, default agent)
//              + each device's certificate (base64 DER, from its key bundle)
//   table    one KV record per handle:
//            alias:<handle> → {"v":1,"handle":…,"default":<agent>|null,"agents":{<agent>: <address>}}
//
// It VERIFIES before it writes: an agent is refused (reported, and left out) when its device is
// not an allowlisted device of that handle, the relay has no certificate for the device, the
// certificate is not the one the device ID stands for (device ID = SHA-256 of the certificate),
// or its key is not Ed25519. With any problem it exits 1 and writes nothing, unless
// --allow-problems.
//
// It never writes to the relay. It writes a file in the format `wrangler kv bulk put` takes and
// prints the exact command; the admin runs it. The Worker has no write path for alias keys, so
// after that load the table is read-only. Do not run the export again later: v2 data keeps
// changing while the old protocol is up, and loading a newer table would re-point aliases.
//
// Exit codes: 0 written (or a clean dry run) · 1 problems, or the source could not be read · 2 usage.
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALIAS_PREFIX = 'alias:';
export const DEFAULT_ADMIN_KEY_ENV = 'MORSE_ADMIN_KEY';

// the v2 name rules (relay-cf/src/protocol.ts), as the relay's alias lookup reads them
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const AGENT = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

// --- device ID and address (same derivations as relay-cf/src/crypto.ts and address.ts) ------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ADDRESS_ALPHABET = '23456789abcdefghjkmnpqrstvwxyz';
const ADDRESS_LENGTH = 26;

/** Device ID = SHA-256 of the certificate DER, base32, groups of 7 (ADR-028). */
export function deviceIdFromCert(der) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of createHash('sha256').update(der).digest()) {
    value = ((value << 8) | byte) >>> 0;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out.match(/.{1,7}/g)?.join('-') ?? out;
}

/** address = base30( SHA-256("morse-address-v1\n" ‖ 32-byte Ed25519 public key) mod 30^26 ) (ADR-073). */
export function addressFromPublicKey(pub) {
  if (pub.length !== 32) throw new Error('an address is computed from a 32-byte Ed25519 public key');
  const digest = createHash('sha256').update('morse-address-v1\n').update(pub).digest();
  let n = BigInt(`0x${digest.toString('hex')}`) % 30n ** BigInt(ADDRESS_LENGTH);
  let out = '';
  for (let i = 0; i < ADDRESS_LENGTH; i++) {
    out = ADDRESS_ALPHABET[Number(n % 30n)] + out;
    n /= 30n;
  }
  return out;
}

const short = (id) => String(id).slice(0, 7);

/**
 * The v3 address of the key in a device's certificate — only when the certificate really is
 * that device's and the key is Ed25519. {address} or {refused: why}.
 */
export function addressOfDevice(id, certB64) {
  if (typeof certB64 !== 'string' || !certB64) return { refused: `no certificate on the relay for device ${short(id)} (it never logged in with a key bundle)` };
  const der = Buffer.from(certB64, 'base64');
  if (deviceIdFromCert(der) !== id) return { refused: `the certificate does not match device ${short(id)}` };
  let x509;
  try {
    x509 = new X509Certificate(der);
  } catch {
    return { refused: `cannot read the certificate of device ${short(id)}` };
  }
  let spki = null;
  try {
    const key = x509.publicKey;
    if (key.asymmetricKeyType === 'ed25519') spki = key.export({ type: 'spki', format: 'der' });
  } catch {
    spki = null;
  }
  if (!spki) return { refused: `the key of device ${short(id)} is not Ed25519` };
  return { address: addressFromPublicKey(spki.subarray(spki.length - 32)) };
}

// --- the table ------------------------------------------------------------------------------

/**
 * Pure: source data → the alias records, verified.
 *
 *   source   {handles: [{handle, devices: [{id, cert}], agents: [{agent, device}], default}]}
 *   returns  {records: [{key: "alias:<handle>", value: {v:1, handle, default, agents}}],
 *             problems: [string],   what was refused (anything here = do not load blindly)
 *             notes: [string]}      what has no alias for an ordinary reason
 *
 * A refused agent is left out; a refused or repeated handle gets no record. A handle whose
 * default agent is missing or refused gets `default: null`.
 */
export function buildAliasRecords(source) {
  if (!source || !Array.isArray(source.handles)) throw new Error('source data must be {handles: [{handle, devices, agents, default}]}');
  const records = [];
  const problems = [];
  const notes = [];
  const count = new Map();
  for (const h of source.handles) {
    if (!h || typeof h.handle !== 'string' || !Array.isArray(h.devices) || !Array.isArray(h.agents)) {
      throw new Error(`source data: handle ${JSON.stringify(h?.handle)} must be {handle, devices: […], agents: […], default}`);
    }
    count.set(h.handle, (count.get(h.handle) ?? 0) + 1);
  }
  const reported = new Set();
  for (const h of [...source.handles].sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0))) {
    const { handle } = h;
    if (!HANDLE.test(handle)) {
      problems.push(`${JSON.stringify(handle)} is not a valid handle — skipped`);
      continue;
    }
    if (count.get(handle) > 1) {
      if (!reported.has(handle)) problems.push(`${handle}: listed more than once in the source data — skipped`);
      reported.add(handle);
      continue;
    }
    const certs = new Map();
    for (const d of h.devices) if (d && typeof d.id === 'string' && !certs.has(d.id)) certs.set(d.id, d.cert);
    const names = new Map();
    for (const a of h.agents) names.set(a?.agent, (names.get(a?.agent) ?? 0) + 1);
    const agents = {};
    const twice = new Set();
    for (const a of [...h.agents].sort((x, y) => (String(x?.agent) < String(y?.agent) ? -1 : 1))) {
      const agent = a?.agent;
      if (typeof agent !== 'string' || !AGENT.test(agent)) {
        problems.push(`${handle}: ${JSON.stringify(agent)} is not a valid agent name — left out`);
        continue;
      }
      const name = `${handle}/${agent}`;
      if (names.get(agent) > 1) {
        if (!twice.has(agent)) problems.push(`${name}: listed more than once in the source data — left out`);
        twice.add(agent);
        continue;
      }
      if (typeof a.device !== 'string' || !certs.has(a.device)) {
        problems.push(`${name}: device ${short(a.device)} is not an allowlisted device of ${handle} — left out`);
        continue;
      }
      const r = addressOfDevice(a.device, certs.get(a.device));
      if (r.refused) {
        problems.push(`${name}: ${r.refused} — left out`);
        continue;
      }
      agents[agent] = r.address;
    }
    if (h.agents.length === 0) {
      notes.push(`${handle}: no agents registered — no alias`);
      continue;
    }
    const wanted = typeof h.default === 'string' && h.default ? h.default : null;
    const def = wanted !== null && Object.hasOwn(agents, wanted) ? wanted : null;
    if (Object.keys(agents).length === 0) continue; // every agent was refused: reported above
    if (wanted !== null && def === null) problems.push(`${handle}: default agent ${JSON.stringify(wanted)} has no alias — the bare name ${handle} would have no default`);
    if (wanted === null) notes.push(`${handle}: no default agent — the bare name lists every agent, none marked default`);
    records.push({ key: ALIAS_PREFIX + handle, value: { v: 1, handle, default: def, agents } });
  }
  return { records, problems, notes };
}

/** The JSON array `wrangler kv bulk put` takes: every value a string. */
export const toBulkPut = (records) => records.map((r) => ({ key: r.key, value: JSON.stringify(r.value) }));

/** How many old names the records answer: bare handles with a default + handle/agent names. */
export function countNames(records) {
  const bare = records.filter((r) => r.value.default !== null).length;
  const full = records.reduce((n, r) => n + Object.keys(r.value.agents).length, 0);
  return { bare, full, total: bare + full };
}

// --- reading the relay (GET only) -----------------------------------------------------------

/**
 * The source data from a relay's admin API: GET /admin/allowlist (every device and its
 * handle), then GET /admin/handles/<handle>?certs=1 per handle (its devices with their
 * certificates, its agents and default agent). Nothing else is ever requested.
 */
export async function fetchSource({ relay, adminKey, fetch: f = fetch }) {
  const base = relay.replace(/\/+$/, '');
  const get = async (path) => {
    const res = await f(`${base}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${adminKey}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) throw new Error(`GET ${path} → 401: the relay rejected the admin key`);
    if (res.status === 404 && path === '/admin/allowlist') throw new Error(`GET ${path} → 404: no admin API there (is ADMIN_KEY set on the relay, and the URL right?)`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };
  const problems = [];
  const notes = [];
  const listed = (await get('/admin/allowlist')).devices;
  if (!Array.isArray(listed)) throw new Error('GET /admin/allowlist: expected {devices: […]}');
  const byHandle = new Map();
  for (const d of listed) {
    if (typeof d?.handle === 'string' && d.handle) byHandle.set(d.handle, [...(byHandle.get(d.handle) ?? []), d.id]);
    else notes.push(`device ${short(d?.id)}${d?.name ? ` (${d.name})` : ''} has no handle — nothing to alias`);
  }
  const names = [...byHandle.keys()].sort();
  const handles = [];
  const one = async (handle) => {
    // a name the relay itself would not accept is reported by buildAliasRecords
    if (!HANDLE.test(handle)) return { handle, devices: [], agents: [], default: null };
    const r = await get(`/admin/handles/${encodeURIComponent(handle)}?certs=1`);
    if (!Array.isArray(r.devices) || !Array.isArray(r.agents)) throw new Error(`GET /admin/handles/${handle}: expected {devices: […], agents: […], default}`);
    if (r.devices.some((d) => !d || !Object.hasOwn(d, 'cert'))) {
      throw new Error('this relay does not return device certificates (GET /admin/handles/<handle>?certs=1) — deploy the identity v3 P2 relay first');
    }
    const devices = [];
    for (const d of r.devices) {
      // a device belongs to the handle its OWN allowlist entry names (what the relay checks at login)
      if (d.handle === handle) devices.push({ id: d.id, cert: d.cert });
      else problems.push(`${handle}: device ${short(d.id)} is in the handle's index but its allowlist entry says ${JSON.stringify(d.handle ?? null)} — not counted`);
    }
    for (const id of byHandle.get(handle)) {
      if (!devices.some((d) => d.id === id)) problems.push(`${handle}: device ${short(id)} is on the allowlist under this handle but not in its index — its certificate was not read`);
    }
    return { handle, devices, agents: r.agents.map((a) => ({ agent: a?.agent, device: a?.device })), default: typeof r.default === 'string' ? r.default : null };
  };
  for (let i = 0; i < names.length; i += 8) handles.push(...(await Promise.all(names.slice(i, i + 8).map(one))));
  return { handles, problems, notes };
}

// --- CLI ------------------------------------------------------------------------------------

const USAGE = `usage:
  ${DEFAULT_ADMIN_KEY_ENV}=… node scripts/aliases-export.mjs --relay https://<relay> [--admin-key-env NAME] [--out aliases.json]
  node scripts/aliases-export.mjs --from <source.json> [--out aliases.json]
options: --save-source <file>  --namespace-id <id>  --dry-run  --allow-problems`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { relay: null, from: null, out: 'aliases.json', adminKeyEnv: DEFAULT_ADMIN_KEY_ENV, saveSource: null, namespaceId: null, dryRun: false, allowProblems: false, help: false };
  const valued = { '--relay': 'relay', '--from': 'from', '--out': 'out', '--admin-key-env': 'adminKeyEnv', '--save-source': 'saveSource', '--namespace-id': 'namespaceId' };
  const flags = { '--dry-run': 'dryRun', '--allow-problems': 'allowProblems', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].split('=')[0];
    // never echo an argument's value: it may be a secret pasted in the wrong place
    if (flag === '--admin-key') throw new UsageError('the admin key is never taken from the command line — put it in an environment variable and name it with --admin-key-env');
    if (flag in flags && argv[i] === flag) o[flags[flag]] = true;
    else if (flag in valued) {
      const value = argv[i].includes('=') ? argv[i].slice(flag.length + 1) : argv[++i];
      if (!value) throw new UsageError(`${flag} needs a value`);
      o[valued[flag]] = value;
    } else throw new UsageError(flag.startsWith('--') ? `unknown option ${flag}` : 'unexpected argument');
  }
  if (o.help) return o;
  if (!o.relay && !o.from) throw new UsageError('give the source: --relay <url> or --from <file.json>');
  if (o.relay && o.from) throw new UsageError('--relay and --from are two different sources: give one');
  return o;
}

/** https://host (the relay's HTTP side); plain http only to this computer. */
export function relayHttpUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new UsageError('--relay must be a URL like https://relay.example');
  }
  if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol === 'ws:') u.protocol = 'http:';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UsageError('--relay must be https (the admin key is not sent over plain http, except to this computer)');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function namespaceIdFromWrangler() {
  const toml = join(dirname(fileURLToPath(import.meta.url)), '..', 'relay-cf', 'wrangler.toml');
  if (!existsSync(toml)) return null;
  return /binding\s*=\s*"ALLOWLIST"\s*\n\s*id\s*=\s*"([^"]+)"/.exec(readFileSync(toml, 'utf8'))?.[1] ?? null;
}

export async function main(argv, env = process.env, print = console.log, fail = console.error) {
  let o;
  try {
    o = parseArgs(argv);
    if (o.help) {
      print(USAGE);
      return 0;
    }
    if (o.relay) o.relay = relayHttpUrl(o.relay);
    if (o.relay && !env[o.adminKeyEnv]) throw new UsageError(`the environment variable ${o.adminKeyEnv} is empty — it must hold the relay's admin key (or name another with --admin-key-env)`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    fail(`✗ aliases-export: ${e.message}\n${USAGE}`);
    return 2;
  }

  let source;
  let problems = [];
  let notes = [];
  try {
    if (o.from) source = JSON.parse(readFileSync(o.from, 'utf8'));
    else {
      print(`aliases-export: reading ${o.relay} (GET /admin/allowlist, GET /admin/handles/<handle>?certs=1) …`);
      const r = await fetchSource({ relay: o.relay, adminKey: env[o.adminKeyEnv] });
      source = { handles: r.handles };
      problems = r.problems;
      notes = r.notes;
    }
    if (o.saveSource) {
      writeFileSync(o.saveSource, `${JSON.stringify(source, null, 2)}\n`);
      print(`source data saved to ${resolve(o.saveSource)}`);
    }
  } catch (e) {
    fail(`✗ aliases-export: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let built;
  try {
    built = buildAliasRecords(source);
  } catch (e) {
    fail(`✗ aliases-export: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  problems = [...problems, ...built.problems];
  notes = [...notes, ...built.notes];
  const { records } = built;

  for (const r of records) {
    const { handle, agents } = r.value;
    print(`  ${handle}${r.value.default ? ` (default: ${r.value.default})` : ' (no default)'}`);
    for (const a of Object.keys(agents)) print(`    ${handle}/${a} → ${agents[a]}`);
  }
  if (notes.length) print(`notes:\n${notes.map((x) => `  · ${x}`).join('\n')}`);
  if (problems.length) print(`problems:\n${problems.map((x) => `  ✗ ${x}`).join('\n')}`);
  const names = countNames(records);
  print(
    `summary: ${source.handles.length} handles in the source → ${records.length} records, ${names.total} old names (${names.bare} bare + ${names.full} handle/agent), ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`,
  );

  if (problems.length && !o.allowProblems) {
    fail('✗ nothing written. Fix the problems on the relay, or pass --allow-problems to load the table without the refused agents.');
    return 1;
  }
  if (o.dryRun) {
    print('dry run: nothing written.');
    return 0;
  }
  const out = resolve(o.out);
  writeFileSync(out, `${JSON.stringify(toBulkPut(records), null, 2)}\n`);
  const id = o.namespaceId ?? namespaceIdFromWrangler() ?? '<ALLOWLIST namespace id>';
  const first = records[0]?.value.handle ?? '<handle>';
  print(`wrote ${out} (${records.length} keys).`);
  print('This script does not touch the relay. Load the table ONCE (the Worker never writes these keys):');
  print(`  cd relay-cf && npx wrangler kv bulk put ${out} --namespace-id ${id} --remote`);
  print('then check a name:');
  print(`  curl ${o.relay ?? 'https://<relay>'}/v3/alias/${first}`);
  return 0;
}

const invoked = process.argv[1] && existsSync(process.argv[1]) ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (invoked === import.meta.url) process.exit(await main(process.argv.slice(2)));
