import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { morseHome, dataDir } from '../home.js';
import type { MessageFile } from '../mailbox/mailbox.js';
import { uniqueFileName } from '../platform/filename.js';

/**
 * Morse large files (ADR-038): an attachment too big for one relay envelope is cut
 * into chunks. The message itself carries a MANIFEST (file names, sizes, whole-file
 * SHA-256, chunk size, chunk counts) instead of the bytes; every chunk then travels
 * as its own envelope — sealed and signed end to end like any message, numbered
 * (message ID + file index = file ID, chunk number, chunk count, whole-file SHA-256).
 * The recipient keeps chunks in a staging directory (~/.morse/incoming-chunks/,
 * capped, cleared after 24 h without progress), acknowledges them in batches
 * (which chunks it holds — so the sender re-sends only what is missing, after a
 * restart too), and files the message only once every file is complete and its
 * SHA-256 matches: text and files appear together, or not at all.
 *
 * This module is transport-free: chunk framing, the recipient's staging store and the
 * sender's transfer loop. morse.ts wires them to the relay and the LAN.
 */

/** Chunk payload size: comfortably inside one Cloudflare envelope (1 MB cap) after sealing. */
export const DEFAULT_CHUNK_BYTES = 512 * 1024;
/** One file, and all files of one message together, at most this (`morse.maxFileBytes`). */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Unfinished incoming transfers may hold at most this much in total (`morse.maxStagingBytes`). */
export const DEFAULT_MAX_STAGING_BYTES = 1024 * 1024 * 1024;
/** An incoming transfer with no new chunk for this long is deleted. */
export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_FILES_PER_MESSAGE = 64;
const MAX_CHUNKS_PER_FILE = 1_000_000;

/** `morse.maxFileBytes` / `morse.maxStagingBytes` from ~/.morse/config.json, defaults filled in. */
export function fileLimitsFrom(cfg: { maxFileBytes?: unknown; maxStagingBytes?: unknown } | undefined): { maxFileBytes: number; maxStagingBytes: number } {
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : d);
  const maxFileBytes = pos(cfg?.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  return { maxFileBytes, maxStagingBytes: Math.max(pos(cfg?.maxStagingBytes, DEFAULT_MAX_STAGING_BYTES), maxFileBytes) };
}

export const formatBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`;

// --- manifest ------------------------------------------------------------------------

export interface ChunkedFile {
  name: string;
  size: number;
  /** Whole-file SHA-256, hex. */
  sha256: string;
  /** How many chunks this file is cut into (at least 1; a 0-byte file is one empty chunk). */
  chunks: number;
}

/** What a message carries instead of the file bytes. */
export interface ChunkedManifest {
  chunkSize: number;
  files: ChunkedFile[];
}

export const chunkCount = (size: number, chunkSize: number): number => Math.max(1, Math.ceil(size / chunkSize));
export const chunkLength = (size: number, chunkSize: number, seq: number): number => Math.max(0, Math.min(chunkSize, size - seq * chunkSize));

/**
 * The chunk size for a relay that takes envelopes up to `maxBlob` bytes: the sealed
 * envelope base64s the plaintext once (×4/3) plus ~2 KB of header, certificate and
 * signature. 512 KiB on the Cloudflare relay (1,000,000 bytes) → ≈ 700 KB envelopes.
 */
export function chunkSizeFor(maxBlob: number, preferred = DEFAULT_CHUNK_BYTES): number {
  const fit = Math.floor(((maxBlob - 16 * 1024) * 3) / 4) - 2048;
  return Math.max(1024, Math.floor(Math.min(preferred, fit) / 1024) * 1024);
}

export function manifestFor(files: Array<Pick<MessageFile, 'name' | 'size' | 'sha256'>>, chunkSize: number): ChunkedManifest {
  return { chunkSize, files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, chunks: chunkCount(f.size, chunkSize) })) };
}

export const totalChunks = (m: Pick<ChunkedManifest, 'files'>): number => m.files.reduce((n, f) => n + f.chunks, 0);
export const totalBytes = (m: Pick<ChunkedManifest, 'files'>): number => m.files.reduce((n, f) => n + f.size, 0);

/** Check a manifest a sender declared; returns why it is refused, or null. */
export function manifestProblem(m: unknown, maxFileBytes: number): string | null {
  const x = m as Partial<ChunkedManifest> | null;
  if (!x || typeof x !== 'object' || !Array.isArray(x.files)) return 'malformed manifest';
  if (typeof x.chunkSize !== 'number' || !Number.isInteger(x.chunkSize) || x.chunkSize < 1024 || x.chunkSize > 4 * 1024 * 1024) return 'bad chunk size';
  if (x.files.length < 1 || x.files.length > MAX_FILES_PER_MESSAGE) return `a message carries 1–${MAX_FILES_PER_MESSAGE} files`;
  let total = 0;
  for (const f of x.files) {
    if (!f || typeof f.name !== 'string' || !f.name || f.name.length > 1024) return 'bad file name';
    if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0) return 'bad file size';
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return 'bad file checksum';
    if (f.chunks !== chunkCount(f.size, x.chunkSize) || f.chunks > MAX_CHUNKS_PER_FILE) return 'bad chunk count';
    if (f.size > maxFileBytes) return `file too large: ${f.name} is ${f.size} bytes, this address accepts at most ${maxFileBytes} (morse.maxFileBytes)`;
    total += f.size;
  }
  if (total > maxFileBytes) return `attachments too large: ${total} bytes in one message, this address accepts at most ${maxFileBytes} (morse.maxFileBytes)`;
  return null;
}

// --- chunk frames ----------------------------------------------------------------------

/** One chunk: message ID + file index (= the file ID), chunk number, chunk count, whole-file SHA-256. */
export interface ChunkHeader {
  kind: 'chunk';
  id: string;
  f: number;
  seq: number;
  n: number;
  sha256: string;
}

/** Relay plaintext of a chunk: a marker line, the JSON header, a newline, the raw bytes (no base64 inside). */
const MAGIC = Buffer.from('MORSE-CHUNK-1\n');

export function encodeChunk(h: ChunkHeader, data: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(h)), Buffer.from('\n'), data]);
}

/** A decrypted plaintext: a chunk frame, or null (then it is a JSON message / receipt / notice). */
export function decodeChunk(buf: Buffer): { header: ChunkHeader; data: Buffer } | null {
  if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const nl = buf.indexOf(0x0a, MAGIC.length);
  if (nl < 0) throw new Error('malformed chunk frame');
  const header = JSON.parse(buf.subarray(MAGIC.length, nl).toString('utf8')) as ChunkHeader;
  if (!isChunkHeader(header)) throw new Error('malformed chunk header');
  return { header, data: buf.subarray(nl + 1) };
}

export function isChunkHeader(h: unknown): h is ChunkHeader {
  const x = h as Partial<ChunkHeader> | null;
  return (
    x?.kind === 'chunk' &&
    typeof x.id === 'string' &&
    x.id.length > 0 &&
    Number.isInteger(x.f) &&
    Number.isInteger(x.seq) &&
    Number.isInteger(x.n) &&
    typeof x.sha256 === 'string'
  );
}

/** LAN form of a chunk (JSON body over mutual TLS): the header plus base64 data. */
export interface LanChunk extends ChunkHeader {
  data: string;
}

export const isLanChunk = (b: unknown): b is LanChunk => isChunkHeader(b) && typeof (b as Partial<LanChunk>).data === 'string';

// --- which chunks are held: ranges --------------------------------------------------

/** Per file: inclusive [first, last] runs of chunk numbers held. */
export type HaveRanges = Array<Array<[number, number]>>;

export function toRanges(bits: Uint8Array, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && (bits[i >> 3]! & (1 << (i & 7))) !== 0;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

export function fromRanges(ranges: unknown, n: number): Uint8Array {
  const bits = new Uint8Array(Math.ceil(n / 8));
  if (!Array.isArray(ranges)) return bits;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const a = Math.max(0, Number(r[0]));
    const b = Math.min(n - 1, Number(r[1]));
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    for (let i = a; i <= b; i++) bits[i >> 3]! |= 1 << (i & 7);
  }
  return bits;
}

export const hasBit = (bits: Uint8Array, i: number): boolean => (bits[i >> 3]! & (1 << (i & 7))) !== 0;
export const setBit = (bits: Uint8Array, i: number): void => {
  bits[i >> 3]! |= 1 << (i & 7);
};
export const countBits = (bits: Uint8Array, n: number): number => {
  let c = 0;
  for (let i = 0; i < n; i++) if (hasBit(bits, i)) c++;
  return c;
};

// --- recipient: staging store ------------------------------------------------------

export function incomingChunksDir(home: string = morseHome()): string {
  return join(dataDir(home), 'incoming-chunks');
}

/** Staging dir name for (sender device, message ID) — hashed: both are sender-chosen strings. */
export const stagingKey = (senderId: string, msgId: string): string => createHash('sha256').update(`${senderId}\n${msgId}`).digest('hex').slice(0, 40);

interface Meta {
  v: 1;
  senderId: string;
  senderName: string;
  msgId: string;
  via: string;
  /** The message plaintext (text, addresses, manifest) — filed once the files are complete. */
  plain: unknown;
  /**
   * ADR-081 (ADR-081 review F2): a transfer BY ADDRESS belongs to an address pair — their address and the
   * address of ours it was written to (`senderId` is then the staging id of that pair). Absent = a
   * transfer from a paired device.
   */
  pair?: { theirs: string; ours: string };
  /** (ADR-083) Whose staging room it counts against: unset = this computer's first address, else the address of mine. */
  scope?: string;
  chunkSize: number;
  files: ChunkedFile[];
  createdAt: number;
}

interface State {
  /** Per file: base64 bitmap of chunks held. */
  have: string[];
  updatedAt: number;
}

interface Entry {
  dir: string;
  meta: Meta;
  have: Uint8Array[];
  updatedAt: number;
}

export type BeginResult =
  | { ok: true; have: HaveRanges; complete: boolean; resumed: boolean }
  | { ok: false; busy?: true; error: string };

export type PutResult =
  | { ok: true; added: boolean; have: HaveRanges; complete: boolean; held: number; total: number }
  | { ok: false; unknown?: true; error: string };

/** One unfinished incoming transfer, as `morse message` shows it ("receiving x/y"). */
export interface IncomingSummary {
  senderId: string;
  senderName: string;
  msgId: string;
  files: Array<{ name: string; size: number }>;
  held: number;
  total: number;
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface IncomingStore {
  dir: string;
  has(senderId: string, msgId: string): boolean;
  /** A manifest arrived: create (or resume) the staging entry; answers which chunks are held. */
  begin(sender: { id: string; name: string; pair?: { theirs: string; ours: string }; /** (ADR-083) whose room it takes: '' = this computer's first address, else the address of mine it was written to */ scope?: string }, msgId: string, plain: unknown, manifest: ChunkedManifest, via: string): BeginResult;
  /** One chunk arrived (any order, duplicates fine). */
  put(senderId: string, h: ChunkHeader, data: Buffer): PutResult;
  have(senderId: string, msgId: string): HaveRanges | null;
  /** The stored plaintext and via of a transfer. */
  meta(senderId: string, msgId: string): { plain: unknown; via: string; files: ChunkedFile[] } | null;
  /**
   * Every chunk is in: check each file's SHA-256 and move it to `destDir` (0700 dir,
   * 0600 files, sender names sanitised). A file whose checksum does not match loses
   * all its chunks (the sender sends it again) and this throws.
   */
  assemble(senderId: string, msgId: string, destDir: string, safeName: (n: string) => string): Promise<MessageFile[]>;
  remove(senderId: string, msgId: string): void;
  list(): IncomingSummary[];
  usedBytes(): number;
  /** Delete transfers with no progress for the TTL; returns how many. */
  cleanup(): number;
}

export interface IncomingStoreOptions {
  home?: string;
  now?: () => number;
  maxFileBytes?: () => number;
  maxStagingBytes?: () => number;
  ttlMs?: number;
}

const b64bits = (bits: Uint8Array) => Buffer.from(bits).toString('base64');
const bitsFrom = (s: unknown, n: number): Uint8Array => {
  const out = new Uint8Array(Math.ceil(n / 8));
  if (typeof s === 'string') out.set(Buffer.from(s, 'base64').subarray(0, out.length));
  return out;
};

export function createIncomingStore(opts: IncomingStoreOptions = {}): IncomingStore {
  const home = opts.home ?? morseHome();
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? STAGING_TTL_MS;
  const maxFile = opts.maxFileBytes ?? (() => DEFAULT_MAX_FILE_BYTES);
  const maxStaging = opts.maxStagingBytes ?? (() => DEFAULT_MAX_STAGING_BYTES);
  const root = incomingChunksDir(home);
  const cache = new Map<string, Entry>();

  const load = (key: string): Entry | null => {
    const hit = cache.get(key);
    if (hit) return hit;
    const dir = join(root, key);
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
      let state: State = { have: [], updatedAt: meta.createdAt };
      try {
        state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as State;
      } catch {
        /* no chunk yet */
      }
      const e: Entry = { dir, meta, have: meta.files.map((f, i) => bitsFrom(state.have?.[i], f.chunks)), updatedAt: state.updatedAt || meta.createdAt };
      cache.set(key, e);
      return e;
    } catch {
      return null;
    }
  };

  const save = (e: Entry) => {
    const state: State = { have: e.have.map(b64bits), updatedAt: e.updatedAt };
    writeFileSync(join(e.dir, 'state.json'), JSON.stringify(state), { mode: 0o600 });
  };

  const rangesOf = (e: Entry): HaveRanges => e.have.map((b, i) => toRanges(b, e.meta.files[i]!.chunks));
  const heldOf = (e: Entry) => e.have.reduce((n, b, i) => n + countBits(b, e.meta.files[i]!.chunks), 0);
  const totalOf = (e: Entry) => totalChunks(e.meta);
  const keys = (): string[] => {
    try {
      return readdirSync(root).filter((k) => /^[0-9a-f]{40}$/.test(k));
    } catch {
      return [];
    }
  };
  // (ADR-083) the room for unfinished incoming files is per address of mine: a transfer running at one of this
  // computer's addresses never makes another one answer "busy"
  const usedBytes = (scope: string) => keys().reduce((n, k) => n + (load(k) && (load(k)!.meta.scope ?? '') === scope ? totalBytes(load(k)!.meta) : 0), 0);
  const drop = (key: string) => {
    cache.delete(key);
    rmSync(join(root, key), { recursive: true, force: true });
  };

  return {
    dir: root,
    has: (senderId, msgId) => load(stagingKey(senderId, msgId)) !== null,
    begin(sender, msgId, plain, manifest, via) {
      const problem = manifestProblem(manifest, maxFile());
      if (problem) return { ok: false, error: problem };
      const key = stagingKey(sender.id, msgId);
      const existing = load(key);
      if (existing) {
        const same =
          existing.meta.chunkSize === manifest.chunkSize &&
          existing.meta.files.length === manifest.files.length &&
          existing.meta.files.every((f, i) => f.sha256 === manifest.files[i]!.sha256 && f.size === manifest.files[i]!.size);
        if (same) {
          if (existing.meta.via !== via) {
            existing.meta.via = via;
            writeFileSync(join(existing.dir, 'meta.json'), JSON.stringify(existing.meta), { mode: 0o600 });
          }
          return { ok: true, have: rangesOf(existing), complete: heldOf(existing) === totalOf(existing), resumed: true };
        }
        drop(key); // the same message ID with other files: start over
      }
      const need = totalBytes(manifest);
      const used = usedBytes(sender.scope ?? '');
      if (used + need > maxStaging()) {
        return { ok: false, busy: true, error: `staging full: ${formatBytes(used)} of unfinished incoming files held, ${formatBytes(maxStaging())} allowed (morse.maxStagingBytes) — try again later` };
      }
      const dir = join(root, key);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
      chmodSync(dir, 0o700);
      const meta: Meta = {
        v: 1,
        senderId: sender.id,
        senderName: sender.name,
        msgId,
        via,
        plain,
        ...(sender.pair ? { pair: { theirs: sender.pair.theirs, ours: sender.pair.ours } } : {}),
        ...(sender.scope ? { scope: sender.scope } : {}),
        chunkSize: manifest.chunkSize,
        files: manifest.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, chunks: f.chunks })),
        createdAt: now(),
      };
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
      const e: Entry = { dir, meta, have: meta.files.map((f) => new Uint8Array(Math.ceil(f.chunks / 8))), updatedAt: now() };
      save(e);
      cache.set(key, e);
      return { ok: true, have: rangesOf(e), complete: false, resumed: false };
    },
    put(senderId, h, data) {
      const e = load(stagingKey(senderId, h.id));
      if (!e) return { ok: false, unknown: true, error: 'no such transfer (manifest first)' };
      const f = e.meta.files[h.f];
      if (!f) return { ok: false, error: 'bad file index' };
      if (h.n !== f.chunks || h.sha256 !== f.sha256 || h.seq < 0 || h.seq >= f.chunks) return { ok: false, error: 'chunk does not match the manifest' };
      if (data.length !== chunkLength(f.size, e.meta.chunkSize, h.seq)) return { ok: false, error: 'chunk has the wrong length' };
      const bits = e.have[h.f]!;
      let added = false;
      if (!hasBit(bits, h.seq)) {
        const path = join(e.dir, `${h.f}.part`);
        const fd = openSync(path, existsSync(path) ? 'r+' : 'w', 0o600);
        try {
          if (data.length) writeSync(fd, data, 0, data.length, h.seq * e.meta.chunkSize);
        } finally {
          closeSync(fd);
        }
        setBit(bits, h.seq);
        e.updatedAt = now();
        save(e);
        added = true;
      }
      const held = heldOf(e);
      const total = totalOf(e);
      return { ok: true, added, have: rangesOf(e), complete: held === total, held, total };
    },
    have(senderId, msgId) {
      const e = load(stagingKey(senderId, msgId));
      return e ? rangesOf(e) : null;
    },
    meta(senderId, msgId) {
      const e = load(stagingKey(senderId, msgId));
      return e ? { plain: e.meta.plain, via: e.meta.via, files: e.meta.files } : null;
    },
    async assemble(senderId, msgId, destDir, safeName) {
      const key = stagingKey(senderId, msgId);
      const e = load(key);
      if (!e) throw new Error('no such transfer');
      const bad: string[] = [];
      for (let i = 0; i < e.meta.files.length; i++) {
        const f = e.meta.files[i]!;
        const path = join(e.dir, `${i}.part`);
        if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 }); // a 0-byte file has no data written
        const digest = await sha256File(path);
        if (digest !== f.sha256 || statSync(path).size !== f.size) {
          bad.push(f.name);
          e.have[i] = new Uint8Array(Math.ceil(f.chunks / 8)); // everything of this file again
          rmSync(path, { force: true });
        }
      }
      if (bad.length) {
        e.updatedAt = now();
        save(e);
        throw new Error(`checksum mismatch: ${bad.join(', ')} — asking the sender for ${bad.length === 1 ? 'that file' : 'those files'} again`);
      }
      mkdirSync(destDir, { recursive: true, mode: 0o700 });
      chmodSync(destDir, 0o700);
      const used = new Set<string>();
      const out: MessageFile[] = [];
      for (let i = 0; i < e.meta.files.length; i++) {
        const f = e.meta.files[i]!;
        // (two names that are one file to a case-insensitive file system are told apart, never overwritten: the
        // rename below would silently replace the first)
        const name = uniqueFileName(safeName(f.name), used);
        const dest = join(destDir, name);
        renameSync(join(e.dir, `${i}.part`), dest);
        // 0600: readable by the owner only, never executable; never opened automatically
        chmodSync(dest, 0o600);
        out.push({ name, path: dest, size: f.size, sha256: f.sha256 });
      }
      return out;
    },
    remove(senderId, msgId) {
      drop(stagingKey(senderId, msgId));
    },
    list() {
      return keys()
        .map((k) => load(k))
        .filter((e): e is Entry => e !== null)
        .map((e) => summarize(e.meta, e.have, e.updatedAt));
    },
    usedBytes: () => keys().reduce((n, k) => n + (load(k) ? totalBytes(load(k)!.meta) : 0), 0),
    cleanup() {
      let n = 0;
      for (const k of keys()) {
        const e = load(k);
        const last = e ? e.updatedAt : 0;
        if (!e || now() - last > ttl) {
          drop(k);
          n++;
        }
      }
      return n;
    },
  };
}

const summarize = (meta: Meta, have: Uint8Array[], updatedAt: number): IncomingSummary => ({
  // (by address: the sender is their address — the staging id also names the address of ours it came to)
  senderId: meta.pair?.theirs ?? meta.senderId,
  senderName: meta.senderName,
  msgId: meta.msgId,
  files: meta.files.map((f) => ({ name: f.name, size: f.size })),
  held: have.reduce((n, b, i) => n + countBits(b, meta.files[i]!.chunks), 0),
  total: totalChunks(meta),
  bytes: totalBytes(meta),
  createdAt: meta.createdAt,
  updatedAt,
});

/** Read-only view of unfinished incoming transfers (for `morse message`, no daemon needed). */
export function listIncoming(home: string = morseHome()): IncomingSummary[] {
  const root = incomingChunksDir(home);
  let ks: string[] = [];
  try {
    ks = readdirSync(root).filter((k) => /^[0-9a-f]{40}$/.test(k));
  } catch {
    return [];
  }
  const out: IncomingSummary[] = [];
  for (const k of ks) {
    try {
      const meta = JSON.parse(readFileSync(join(root, k, 'meta.json'), 'utf8')) as Meta;
      let state: State = { have: [], updatedAt: meta.createdAt };
      try {
        state = JSON.parse(readFileSync(join(root, k, 'state.json'), 'utf8')) as State;
      } catch {
        /* none yet */
      }
      out.push(summarize(meta, meta.files.map((f, i) => bitsFrom(state.have?.[i], f.chunks)), state.updatedAt || meta.createdAt));
    } catch {
      /* half-written entry */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Synchronous SHA-256 of a file, read in 1 MiB pieces (no whole-file buffer). */
export function sha256FileSync(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** Read chunk `seq` of a file. */
export function readChunk(path: string, size: number, chunkSize: number, seq: number): Buffer {
  const len = chunkLength(size, chunkSize, seq);
  const buf = Buffer.alloc(len);
  if (!len) return buf;
  const fd = openSync(path, 'r');
  try {
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, seq * chunkSize + off);
      if (n <= 0) throw new Error(`${basename(path)}: file shorter than expected (changed since it was queued?)`);
      off += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}

// --- sender: one transfer -------------------------------------------------------------

/** What the recipient says about a transfer (a status, the final receipt, or a refusal). */
export interface TransferAnswer {
  /** Chunks it holds (per file ranges). */
  have?: HaveRanges;
  /** Receipt: the message is filed with all its files. */
  complete?: boolean;
  /** It went to their message requests (ADR-037) — no chunks are wanted. */
  request?: 'filed' | 'dropped';
  /** A plain receipt from an older Morse: it filed the text WITHOUT the files. */
  legacy?: boolean;
  /** Its staging area is full right now: try later. */
  busy?: boolean;
  /** Refused for good (too large for them, malformed). */
  error?: string;
  /** The recipient knows no such transfer (restarted with staging cleared): offer again. */
  unknown?: boolean;
  /** `have` is the complete truth (an answer to the manifest, or a file reset after a
   *  checksum mismatch) — otherwise it only adds to what is known (acks may arrive out of order). */
  reset?: boolean;
}

/** Why sending stopped for now. offline/link = not reachable (retry later; link = try the other path). */
export class TransferStop extends Error {
  constructor(
    readonly reason: 'offline' | 'link' | 'fatal',
    message: string,
  ) {
    super(message);
  }
}

/** How one transfer talks to the recipient (relay or LAN). */
export interface TransferIO {
  /** Send the manifest (the message itself); resolves with the first answer, null = none in time. */
  offer(): Promise<TransferAnswer | null>;
  /** Hand over one chunk. The LAN answers right away (returned); the relay answers later (via `answer`). */
  send(h: ChunkHeader, data: Buffer): Promise<TransferAnswer | void>;
  /** Wait for permission to send one more envelope (the relay rate limit). */
  throttle(): Promise<void>;
}

export type TransferState = 'sending' | 'waiting' | 'done' | 'request' | 'held' | 'failed';

export interface TransferProgress {
  msgId: string;
  to: string;
  via: 'lan' | 'direct' | 'relay' | null;
  state: TransferState;
  files: Array<{ name: string; size: number }>;
  bytes: number;
  total: number;
  /** Chunks the recipient confirmed. */
  acked: number;
  /** Chunk envelopes handed over (resends included). */
  sent: number;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export interface TransferTuning {
  /** Unacknowledged chunks in flight at most (default 24). */
  window?: number;
  /** Chunks handed over at the same time (default 3). */
  concurrency?: number;
  /** No answer at all for this long → ask for the status again (default 15 s). */
  ackIdleMs?: number;
  /** All chunks acknowledged → wait this long for the final receipt before asking again (default 30 s). */
  completeWaitMs?: number;
  /** Rounds in a row without a new acknowledged chunk before giving up for now (default 3). */
  maxIdleRounds?: number;
}

/**
 * One outgoing chunked message. `run(io)` drives it over one path until it is done, the
 * recipient answers something final (request, refusal), or it cannot get on (then
 * state `waiting` with the reason — the outbox runs it again later; the recipient's
 * staging means only missing chunks go again).
 */
export class OutboundTransfer {
  readonly msgId: string;
  readonly deviceId: string;
  readonly label: string;
  readonly manifest: ChunkedManifest;
  readonly paths: string[];
  state: TransferState = 'sending';
  via: 'lan' | 'direct' | 'relay' | null = null;
  error: string | undefined;
  sent = 0;
  readonly startedAt = Date.now();
  updatedAt = Date.now();
  /** What the recipient answered last (final answers are kept here for `send`). */
  final: TransferAnswer | null = null;
  /** The LAN path failed for this transfer: stay on the relay. */
  lanFailed = false;
  private have: Uint8Array[];
  private listeners = new Set<() => void>();
  private gotAnswer = false;

  constructor(opts: { msgId: string; deviceId: string; label: string; manifest: ChunkedManifest; paths: string[] }) {
    this.msgId = opts.msgId;
    this.deviceId = opts.deviceId;
    this.label = opts.label;
    this.manifest = opts.manifest;
    this.paths = opts.paths;
    this.have = opts.manifest.files.map((f) => new Uint8Array(Math.ceil(f.chunks / 8)));
  }

  get total(): number {
    return totalChunks(this.manifest);
  }

  acked(): number {
    return this.have.reduce((n, b, i) => n + countBits(b, this.manifest.files[i]!.chunks), 0);
  }

  progress(): TransferProgress {
    return {
      msgId: this.msgId,
      to: this.label,
      via: this.via,
      state: this.state,
      files: this.manifest.files.map((f) => ({ name: f.name, size: f.size })),
      bytes: totalBytes(this.manifest),
      total: this.total,
      acked: this.acked(),
      sent: this.sent,
      ...(this.error ? { error: this.error } : {}),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  /** Whatever the recipient said (relay acks arrive here; LAN answers are passed in by run). */
  answer(a: TransferAnswer): void {
    this.gotAnswer = true;
    if (a.have) {
      const next = this.manifest.files.map((f, i) => fromRanges(a.have![i], f.chunks));
      if (a.reset) this.have = next; // it may have LOST chunks (checksum mismatch → that file again)
      else this.have.forEach((b, i) => next[i]!.forEach((v, j) => (b[j]! |= v)));
    }
    if (a.complete) this.have = this.manifest.files.map((f) => fromRanges([[0, f.chunks - 1]], f.chunks));
    if (a.complete || a.request || a.legacy || a.error || a.busy || a.unknown) this.final = a;
    this.updatedAt = Date.now();
    for (const l of [...this.listeners]) l();
  }

  /** Resolves true on the next answer, false after `ms` without one. */
  private nextAnswer(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(t);
        this.listeners.delete(onAnswer);
        resolve(v);
      };
      const onAnswer = () => done(true);
      const t = setTimeout(() => done(false), ms);
      this.listeners.add(onAnswer);
    });
  }

  private missing(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    this.manifest.files.forEach((f, i) => {
      for (let s = 0; s < f.chunks; s++) if (!hasBit(this.have[i]!, s)) out.push([i, s]);
    });
    return out;
  }

  private isHeld(f: number, seq: number): boolean {
    return hasBit(this.have[f]!, seq);
  }

  /** A final answer → the state it means; null = keep going. */
  private settle(): TransferState | null {
    const a = this.final;
    if (!a) return null;
    if (a.complete) return this.finish('done');
    if (a.request === 'filed') return this.finish('request');
    if (a.request === 'dropped') return this.finish('held');
    if (a.legacy) {
      return this.finish('failed', `${this.label} runs an older Morse that cannot take large files — the text arrived WITHOUT the attachments; ask them to update Morse, then send the files again`);
    }
    if (a.error) return this.finish('failed', `${this.label} refused the files: ${a.error}`);
    if (a.busy) return this.finish('waiting', `${this.label} is busy receiving other files — will try again`);
    return null; // unknown: handled by the caller (offer again)
  }

  private finish(state: TransferState, error?: string): TransferState {
    this.state = state;
    this.error = error;
    this.updatedAt = Date.now();
    return state;
  }

  async run(io: TransferIO, tune: TransferTuning = {}): Promise<TransferState | 'link'> {
    const window = tune.window ?? 24;
    const concurrency = tune.concurrency ?? 3;
    const ackIdle = tune.ackIdleMs ?? 15_000;
    const completeWait = tune.completeWaitMs ?? 30_000;
    const maxIdle = tune.maxIdleRounds ?? 3;
    this.state = 'sending';
    this.error = undefined;
    let idleRounds = 0;
    try {
      for (;;) {
        const before = this.acked();
        this.final = null;
        const first = await io.offer();
        if (!first) {
          if (++idleRounds >= maxIdle) return this.finish('waiting', `${this.label} did not answer — will try again`);
          continue;
        }
        this.answer({ ...first, reset: true });
        const settled = this.settle();
        if (settled) return settled;
        this.final = null;

        const queue = this.missing();
        const outstanding = new Set<string>();
        let resync = false;
        const worker = async () => {
          while (queue.length && !resync && !this.final) {
            const [f, seq] = queue.shift()!;
            if (this.isHeld(f, seq)) continue;
            // flow control: wait for acknowledgements before running too far ahead
            for (const k of [...outstanding]) if (this.isHeld(Number(k.split(':')[0]), Number(k.split(':')[1]))) outstanding.delete(k);
            while (outstanding.size >= window && !resync && !this.final) {
              if (!(await this.nextAnswer(ackIdle))) resync = true;
              for (const k of [...outstanding]) if (this.isHeld(Number(k.split(':')[0]), Number(k.split(':')[1]))) outstanding.delete(k);
            }
            if (resync || this.final) break;
            await io.throttle();
            const file = this.manifest.files[f]!;
            const data = readChunk(this.paths[f]!, file.size, this.manifest.chunkSize, seq);
            const r = await io.send({ kind: 'chunk', id: this.msgId, f, seq, n: file.chunks, sha256: file.sha256 }, data);
            this.sent++;
            this.updatedAt = Date.now();
            outstanding.add(`${f}:${seq}`);
            if (r) this.answer(r);
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
        const s1 = this.settle();
        if (s1) return s1;
        if ((this.final as TransferAnswer | null)?.unknown) {
          idleRounds++;
          continue; // the recipient lost the transfer: offer again
        }
        // everything handed over: wait for the acknowledgements to catch up
        while (!resync && !this.final && this.acked() < this.total) {
          if (!(await this.nextAnswer(ackIdle))) break;
        }
        if (!this.final && this.acked() === this.total) {
          // the recipient checks the SHA-256 and files the message, then sends the receipt
          const end = Date.now() + completeWait;
          while (!this.final && Date.now() < end) await this.nextAnswer(Math.max(1, end - Date.now()));
        }
        const s2 = this.settle();
        if (s2) return s2;
        idleRounds = this.acked() > before ? 0 : idleRounds + 1;
        if (idleRounds >= maxIdle) return this.finish('waiting', `${this.label} stopped confirming chunks (${this.acked()}/${this.total}) — will try again`);
      }
    } catch (e) {
      if (e instanceof TransferStop) {
        if (e.reason === 'fatal') return this.finish('failed', e.message);
        this.finish('waiting', e.message);
        return e.reason === 'link' ? 'link' : 'waiting';
      }
      return this.finish('failed', e instanceof Error ? e.message : String(e));
    }
  }
}

/**
 * Token bucket for chunk envelopes on the relay: `perMinute` a minute, bursts up to the
 * same number. Shared by all transfers of a device, so together they stay under the
 * relay's per-device limit and leave room for ordinary messages and receipts.
 */
export class Throttle {
  private tokens: number;
  private at: number;
  constructor(
    private readonly perMinute: () => number,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
  ) {
    this.tokens = perMinute();
    this.at = this.clock.now();
  }
  private refill() {
    const rate = this.perMinute();
    const t = this.clock.now();
    this.tokens = Math.min(rate, this.tokens + ((t - this.at) / 60_000) * rate);
    this.at = t;
  }
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute()));
    }
  }
}

/** The share of the relay's per-device rate chunks may use: 5/6 (100 of 120 a minute). */
export const chunkRateFor = (relayPerMinute: number): number => Math.max(1, Math.floor((relayPerMinute * 5) / 6));
