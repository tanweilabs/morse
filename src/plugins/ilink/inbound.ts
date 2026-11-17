import { createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CDN_HOST, type FetchImpl } from './ilink.js';
import { beijingNow, type Log } from './store.js';

/**
 * Inbound media (ported from weixin-bridge lib/inbound.mjs): the non-text items of a
 * WeChat message (image, file, video, voice) become files under <media dir>/<Beijing
 * date>/ (0600, never overwritten), and one text that names them by absolute path —
 * that text is what the Morse message carries.
 */

export const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MEDIA_TIMEOUT_MS = 120_000;
export const DEFAULT_MEDIA_KEEP_DAYS = 30;
const MAX_NAME_CHARS = 80;
const AES_BLOCK = 16;

export type MediaKind = 'image' | 'voice' | 'file' | 'video';
const KINDS: Record<number, [MediaKind, string]> = { 2: ['image', 'image_item'], 3: ['voice', 'voice_item'], 4: ['file', 'file_item'], 5: ['video', 'video_item'] };
const KIND_LABEL: Record<MediaKind, string> = { image: '图片', file: '文件', video: '视频', voice: '语音' };
const REASON: Record<string, string> = {
  'too-large': '超过大小上限',
  timeout: '下载超时',
  'no-url': '没有下载地址',
  'untrusted-url': '下载地址不可信',
  'bad-key': '解密密钥无效',
  'decrypt-failed': '解密失败',
  'save-failed': '保存失败',
};

export interface MediaPart {
  kind: MediaKind;
  name?: string;
  size?: number;
  aeskey?: string;
  aesKeyB64?: string;
  query?: string;
  fullUrl?: string;
}
export interface SavedMedia {
  kind: MediaKind;
  path: string;
  name?: string | undefined;
}
export interface FailedMedia {
  kind: MediaKind;
  name?: string | undefined;
  index: number;
  reason: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

class MediaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Structure of a payload for the log: key names, value types and lengths, never values. */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value !== 'object') return typeof value;
  if (depth >= 6) return Array.isArray(value) ? `array(${value.length})` : 'object';
  if (Array.isArray(value)) {
    const shown = value.slice(0, 10).map((entry) => shapeOf(entry, depth + 1));
    return `[${shown.join(',')}${value.length > 10 ? `,…+${value.length - 10}` : ''}]`;
  }
  const obj = value as Record<string, unknown>;
  const fields = Object.keys(obj).slice(0, 40).map((key) => `${/^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : '?'}:${shapeOf(obj[key], depth + 1)}`);
  return `{${fields.join(',')}}`;
}

/** Split a raw item_list into text (typed text + voice transcriptions), media to download, unknown types. */
export function readItems(raw: unknown): { text: string | null; media: MediaPart[]; unknown: string[] } {
  const texts: string[] = [];
  const media: MediaPart[] = [];
  const unknown: string[] = [];
  const list = (raw as { item_list?: unknown } | null)?.item_list;
  for (const item of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
    if (!item || typeof item !== 'object') continue;
    if (item['type'] === 1 || item['text_item']) {
      const text = str((item['text_item'] as { text?: unknown } | undefined)?.text);
      if (text) texts.push(text);
      continue;
    }
    const kindEntry = KINDS[item['type'] as number] ?? Object.values(KINDS).find(([, name]) => item[name] && typeof item[name] === 'object');
    if (!kindEntry) {
      unknown.push(String(item['type'] ?? '?').slice(0, 20));
      continue;
    }
    const [kind, field] = kindEntry;
    const detail = (item[field] && typeof item[field] === 'object' ? item[field] : {}) as Record<string, unknown>;
    if (kind === 'voice' && str(detail['text'])) {
      texts.push(str(detail['text'])!); // WeChat already transcribed it: plain text
      continue;
    }
    const m = (detail['media'] ?? {}) as Record<string, unknown>;
    const size = Number(detail['len']);
    const part: MediaPart = { kind };
    const name = str(detail['file_name']);
    if (name) part.name = name;
    if (Number.isFinite(size) && size > 0) part.size = size;
    if (str(detail['aeskey'])) part.aeskey = str(detail['aeskey'])!;
    if (str(m['aes_key'])) part.aesKeyB64 = str(m['aes_key'])!;
    if (str(m['encrypt_query_param'])) part.query = str(m['encrypt_query_param'])!;
    if (str(m['full_url'])) part.fullUrl = str(m['full_url'])!;
    media.push(part);
  }
  return { text: texts.length ? texts.join('\n') : null, media, unknown };
}

/** The AES-128 key: 32 hex chars (`aeskey`) or base64 (`media.aes_key`) of the raw 16 bytes or of the hex. None = not encrypted. */
export function mediaKey(part: MediaPart): { key: Buffer; source: string } | null {
  if (part.aeskey) {
    if (!/^[0-9a-f]{32}$/i.test(part.aeskey)) throw new MediaError('bad-key', 'aeskey is not 32 hex characters');
    return { key: Buffer.from(part.aeskey, 'hex'), source: 'aeskey(hex)' };
  }
  if (!part.aesKeyB64) return null;
  const decoded = Buffer.from(part.aesKeyB64, 'base64');
  if (decoded.length === AES_BLOCK) return { key: decoded, source: 'media.aes_key(base64 raw)' };
  const asText = decoded.toString('latin1');
  if (/^[0-9a-f]{32}$/i.test(asText)) return { key: Buffer.from(asText, 'hex'), source: 'media.aes_key(base64 hex)' };
  throw new MediaError('bad-key', `media.aes_key decodes to ${decoded.length} bytes`);
}

/** Downloads only ever go to the WeChat CDN host over https. */
export function mediaUrl(part: MediaPart): { url: string; source: string } {
  if (part.query) return { url: `https://${CDN_HOST}/c2c/download?encrypted_query_param=${encodeURIComponent(part.query)}`, source: 'encrypt_query_param' };
  if (!part.fullUrl) throw new MediaError('no-url', 'item has no download address');
  let url: URL;
  try {
    url = new URL(part.fullUrl);
  } catch {
    throw new MediaError('untrusted-url', 'full_url is not a URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== CDN_HOST || (url.port && url.port !== '443') || !url.pathname.startsWith('/c2c/') || url.username || url.password) {
    throw new MediaError('untrusted-url', 'full_url is not on the WeChat CDN');
  }
  url.hash = '';
  return { url: url.toString(), source: 'full_url' };
}

export function decryptMedia(ciphertext: Buffer, key: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK !== 0) throw new MediaError('decrypt-failed', `ciphertext length ${ciphertext.length} is not a multiple of 16`);
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null); // PKCS#7 padding
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new MediaError('decrypt-failed', 'AES-128-ECB decryption failed');
  }
}

export interface MediaOptions {
  fetchImpl?: FetchImpl | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** Download one media part; plaintext bytes. Bounded in size and time. */
export async function fetchMedia(part: MediaPart, opts: MediaOptions = {}): Promise<{ bytes: Buffer; encrypted: boolean; keySource: string; urlSource: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  if ((part.size ?? 0) > maxBytes) throw new MediaError('too-large', `declared size ${part.size} exceeds ${maxBytes}`);
  const { url, source: urlSource } = mediaUrl(part);
  const keyInfo = mediaKey(part);
  const limit = maxBytes + (keyInfo ? AES_BLOCK : 0);
  const timeout = AbortSignal.timeout(timeoutMs);
  const chunks: Buffer[] = [];
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new MediaError('http', `CDN answered HTTP ${response.status}`);
    }
    if (Number(response.headers?.get?.('content-length')) > limit) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new MediaError('too-large', `content-length exceeds ${maxBytes}`);
    }
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > limit) throw new MediaError('too-large', `download exceeds ${maxBytes}`);
        chunks.push(Buffer.from(chunk));
      }
    }
  } catch (error) {
    const code = (error as MediaError).code;
    if (code && (code in REASON || code === 'http')) throw error;
    if (opts.signal?.aborted) throw new MediaError('aborted', 'download aborted');
    if (timeout.aborted) throw new MediaError('timeout', `download exceeded ${timeoutMs}ms`);
    const e = error as { cause?: { code?: string }; message?: string };
    throw new MediaError('network', `download failed: ${e?.cause?.code ?? e?.message ?? 'unknown'}`);
  }
  const body = Buffer.concat(chunks);
  const bytes = keyInfo ? decryptMedia(body, keyInfo.key) : body;
  if (bytes.length > maxBytes) throw new MediaError('too-large', `file exceeds ${maxBytes}`);
  return { bytes, encrypted: Boolean(keyInfo), keySource: keyInfo?.source ?? 'none', urlSource };
}

/** File type by magic bytes, used only when WeChat gave no usable extension. */
export function sniffExtension(bytes: Buffer): string {
  const head = bytes.subarray(0, 16);
  const ascii = head.toString('latin1');
  if (head[0] === 0x89 && ascii.startsWith('PNG', 1)) return '.png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (ascii.startsWith('GIF8')) return '.gif';
  if (ascii.startsWith('RIFF') && ascii.startsWith('WEBP', 8)) return '.webp';
  if (ascii.startsWith('BM')) return '.bmp';
  if (ascii.startsWith('ftyp', 4)) return /^(heic|heix|hevc|mif1|msf1)/.test(ascii.slice(8, 12)) ? '.heic' : '.mp4';
  if (ascii.startsWith('%PDF')) return '.pdf';
  if (ascii.includes('#!SILK')) return '.silk';
  if (ascii.startsWith('#!AMR')) return '.amr';
  return '';
}

/** A file name that is safe to create: one segment, no leading dots, no hostile characters, bounded, extension kept. */
export function sanitizeName(name: unknown, fallback = 'file'): string {
  let clean = (String(name ?? '').normalize('NFC').split(/[/\\]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|`$;&'!]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+/, '')
    .trim();
  if (!clean || /^_+$/.test(clean)) clean = fallback;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(clean.slice(dot)) ? clean.slice(dot) : '';
  let stem = ext ? clean.slice(0, dot) : clean.replace(/\.+$/, '');
  stem = Array.from(stem).slice(0, MAX_NAME_CHARS - ext.length).join('').trim() || fallback;
  return `${stem}${ext}`;
}

/** Write to <dir>/<YYYY-MM-DD>/<msgid>-<safe name>, mode 0600, never overwriting. */
export function saveMedia(o: { dir: string; messageId: string; part: MediaPart; bytes: Buffer; index?: number; many?: boolean }): string {
  const dayDir = join(o.dir, beijingNow().slice(0, 10));
  mkdirSync(dayDir, { recursive: true, mode: 0o700 });
  let name = sanitizeName(o.part.name, `${o.part.kind}${o.many ? `-${(o.index ?? 0) + 1}` : ''}`);
  if (!/\.[A-Za-z0-9]{1,10}$/.test(name)) name += sniffExtension(o.bytes) || (o.part.name ? '' : '.bin');
  const prefix = String(o.messageId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'msg';
  const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
  let path = resolve(dayDir, `${prefix}-${name}`);
  for (let n = 2; existsSync(path); n += 1) path = resolve(dayDir, `${prefix}-${name.slice(0, dot)}-${n}${name.slice(dot)}`);
  writeFileSync(path, o.bytes, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}

/** Fetch and save every media part of one message. Never throws: each part is saved or failed. */
export async function collectMedia(
  item: { id: string; media?: MediaPart[] },
  opts: MediaOptions & { dir: string; log?: Log },
): Promise<{ saved: SavedMedia[]; failed: FailedMedia[] }> {
  const saved: SavedMedia[] = [];
  const failed: FailedMedia[] = [];
  const parts = item.media ?? [];
  const log = opts.log ?? (() => undefined);
  for (const [index, part] of parts.entries()) {
    try {
      const { bytes, ...how } = await fetchMedia(part, opts);
      let path: string;
      try {
        path = saveMedia({ dir: opts.dir, messageId: item.id, part, bytes, index, many: parts.length > 1 });
      } catch (error) {
        throw new MediaError('save-failed', `cannot write file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
      }
      saved.push({ kind: part.kind, path, name: part.name });
      log('media-saved', { id: item.id, index, kind: part.kind, bytes: bytes.length, ...how, file: path.split('/').slice(-2).join('/') });
    } catch (error) {
      const code = (error as MediaError)?.code ?? 'failed';
      failed.push({ kind: part.kind, name: part.name, index, reason: REASON[code] ?? '下载失败' });
      log('media-error', { id: item.id, index, kind: part.kind, code, message: String((error as Error)?.message ?? error).slice(0, 200) });
    }
  }
  return { saved, failed };
}

const describe = (entry: { kind: MediaKind; name?: string | undefined }) => `${KIND_LABEL[entry.kind] ?? '附件'}${entry.kind === 'file' && entry.name ? `「${sanitizeName(entry.name)}」` : ''}`;

/** One short line for the sender about attachments that could not be fetched. */
export function failureLine(failed: FailedMedia[]): string {
  return `有 ${failed.length} 个附件没能取到：${failed.map((f) => `${describe(f)}（${f.reason}）`).join('、')}。`;
}

export function unknownLine(types: string[]): string {
  return types.length ? `暂不支持这种消息（类型 ${[...new Set(types)].join('、')}）。` : '暂不支持这种消息。';
}

/** The message text: every saved attachment with its absolute path, a note about failed ones, and the typed text. */
export function buildPrompt({ text, saved = [], failed = [] }: { text: string | null; saved?: SavedMedia[]; failed?: FailedMedia[] }): string {
  if (!saved.length && !failed.length) return text ?? '';
  const lines: string[] = [];
  const note = (entry: SavedMedia) => (entry.kind === 'voice' ? '（语音原始文件，多半是 SILK 编码，你可能无法直接播放）' : '');
  if (saved.length === 1) {
    const only = saved[0]!;
    const unit = { image: '一张图片', file: '一个文件', video: '一段视频', voice: '一段语音' }[only.kind] ?? '一个附件';
    lines.push(`用户通过微信发来${unit}${only.kind === 'file' && only.name ? `「${sanitizeName(only.name)}」` : ''}，已保存到 ${only.path}${note(only)}。`);
  } else if (saved.length > 1) {
    lines.push(`用户通过微信发来 ${saved.length} 个附件，已保存到本机：`);
    saved.forEach((entry, i) => lines.push(`${i + 1}. ${describe(entry)}：${entry.path}${note(entry)}`));
  }
  if (failed.length) lines.push(`另有 ${failed.length} 个附件没能取到（${failed.map(describe).join('、')}），已告知用户。`);
  lines.push(text ? `用户同时写道：\n${text}` : saved.length ? '请查看后回应。' : '');
  return lines.filter(Boolean).join('\n');
}

/** Delete saved media older than keepDays (by mtime) and empty day folders. */
export function sweepMedia(dir: string, keepDays = DEFAULT_MEDIA_KEEP_DAYS, now = Date.now()): number {
  let removed = 0;
  if (!existsSync(dir)) return removed;
  for (const day of readdirSync(dir)) {
    const dayDir = join(dir, day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !lstatSync(dayDir).isDirectory()) continue;
    for (const name of readdirSync(dayDir)) {
      const file = join(dayDir, name);
      const info = lstatSync(file);
      if (info.isFile() && now - info.mtimeMs > keepDays * 86_400_000) {
        rmSync(file);
        removed += 1;
      }
    }
    if (readdirSync(dayDir).length === 0) rmdirSync(dayDir);
  }
  return removed;
}
