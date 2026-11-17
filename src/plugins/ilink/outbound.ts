import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DEFAULT_MAX_MEDIA_BYTES, sniffExtension } from './inbound.js';
import type { Log } from './store.js';

/**
 * Outbound files (ported from weixin-bridge lib/outbound.mjs): an agent asks for a file to
 * be sent by writing a line `[[send-file: /abs/path]]` in its message; the plugin strips
 * those lines, checks every path against the rules below, and only then hands the file to
 * WeChat. Rules: a regular file inside the configured send root (or the plugin's own
 * received-media folder), real path checked so links cannot escape, no hidden component,
 * nothing from the plugin's state or Morse's data directory, no credential-looking name,
 * not empty, under the size cap, at most 5 per message, only ever to the bound user.
 */

export const MAX_FILES_PER_REPLY = 5;
const MARKER = /^\s*\[\[send-file:\s*(.*?)\s*\]\]\s*$/;
const FENCE = /^\s*(```|~~~)/;
const CREDENTIAL_NAME = /(\.pem|\.key|\.p12|\.pfx)$|^id_(rsa|dsa|ecdsa|ed25519)|secret|token|password|credential|^account\.json$/i;
const SENDABLE_IMAGE = new Set(['.png', '.jpg', '.gif']);

export interface SendRules {
  /** Files must be inside this directory (null = sending files is off). */
  root: string | null;
  /** The plugin's state directory: never sent from (except mediaDir). */
  stateDir?: string;
  /** Received media: may be sent back even when outside root. */
  mediaDir?: string;
  /** Morse's data directory (~/.morse): never sent from (except mediaDir). */
  morseDir?: string;
  maxBytes?: number;
  /** Exact files that may be sent wherever they are (attachments of your own Morse mail);
   *  the name, hidden-path, empty and size rules still apply. */
  allow?: Set<string>;
}

/** What an agent must be told (put it in the dispatch launch profile's appendSystemPrompt). */
export function sendInstruction({ root }: { root: string }): string {
  return [
    '你正在通过微信和用户对话。用户要你把某个文件或图片发给他时，在回复里单独写一行（每个文件一行，一次最多 5 个）：',
    '[[send-file: /绝对路径/文件名]]',
    `路径必须是绝对路径，文件必须已经存在，并且位于 ${root} 之内（需要的话先生成并保存）；隐藏目录、凭据和密钥类文件不会被发送。`,
    '这一行不会显示给用户，文件会作为微信图片或文件消息单独送达；不需要发文件时不要写这种行。',
  ].join('\n');
}

/** Split a message into the text for WeChat and the requested paths. Markers inside fenced code are examples, not requests. */
export function extractSendMarkers(reply: string): { text: string; paths: string[] } {
  const kept: string[] = [];
  const paths: string[] = [];
  let fenced = false;
  for (const line of String(reply ?? '').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const match = fenced ? null : MARKER.exec(line);
    if (match) paths.push(match[1] ?? '');
    else kept.push(line);
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), paths };
}

export class Refusal extends Error {
  code: string;
  reason: string;
  constructor(code: string, reason: string) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const hasDotPart = (path: string) => path.split(sep).some((part) => part.startsWith('.') && part !== '.');
const real = (p: string | undefined): string | null => {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** The rules. Returns { path, name, size } for a file that may be sent, or throws a Refusal whose reason is a short line for the owner. */
export function checkSendPath(requested: string, rules: SendRules): { path: string; name: string; size: number } {
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || !isAbsolute(requested)) throw new Refusal('not-absolute', '不是绝对路径');
  const lexical = resolve(requested);
  const realRoot = real(rules.root ?? undefined) ?? '';
  if (!realRoot && !rules.allow?.size && !rules.mediaDir) throw new Refusal('disabled', '当前没有开启发文件');
  let file: string;
  try {
    file = realpathSync(lexical); // follows every link, so a link cannot escape
  } catch {
    throw new Refusal('not-found', '文件不存在');
  }
  const realMedia = real(rules.mediaDir);
  const allowed = Boolean(rules.allow && [...rules.allow].some((a) => real(a) === file));
  const inMedia = allowed || Boolean(realMedia && inside(file, realMedia) && file !== realMedia);
  if (!inMedia && !realRoot) throw new Refusal(rules.root ? 'no-root' : 'disabled', rules.root ? '发送目录不可用' : '当前没有开启发文件');
  if (!inMedia && (!inside(file, realRoot) || file === realRoot)) throw new Refusal('outside-root', '不在允许发送的目录内');
  const info = lstatSync(file);
  if (!info.isFile()) throw new Refusal('not-a-file', '不是普通文件');
  const base = allowed ? dirname(file) : inMedia ? realMedia! : realRoot;
  const lexBase = allowed ? dirname(lexical) : inMedia ? resolve(rules.mediaDir!) : resolve(rules.root!);
  // dot-prefixed components (.env, .git, .ssh …) refused as written and as resolved
  if (hasDotPart(relative(base, file)) || hasDotPart(inside(lexical, lexBase) ? relative(lexBase, lexical) : lexical)) throw new Refusal('hidden-path', '路径里有隐藏目录或隐藏文件');
  // the plugin's own state and Morse's data (credentials, mailbox, keys) are off limits
  if (!inMedia) {
    for (const dir of [real(rules.stateDir), real(rules.morseDir)]) {
      if (dir && inside(file, dir)) throw new Refusal('plugin-state', '是插件或 Morse 自己的状态文件');
    }
  }
  if (CREDENTIAL_NAME.test(basename(file)) || CREDENTIAL_NAME.test(basename(lexical))) throw new Refusal('credential-name', '文件名像凭据或密钥');
  if (info.size === 0) throw new Refusal('empty', '是空文件');
  if (info.size > (rules.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES)) throw new Refusal('too-large', '超过大小上限');
  return { path: file, name: basename(file), size: info.size };
}

const shortName = (path: string) => Array.from(basename(String(path)) || String(path)).slice(0, 60).join('');

export interface FileSender {
  sendFile(to: string, file: { name: string; bytes: Buffer; image: boolean }, contextToken: string | null): Promise<void>;
}

/** Send the requested files to the bound user, in order. Never throws: each refusal or failure is one line via notify. */
export async function sendFiles(
  paths: string[],
  o: { to: string; allowedSender: string; contextToken: string | null; wx: FileSender; rules: SendRules; notify: (line: string) => Promise<void>; log?: Log },
): Promise<{ sent: number; failed: number }> {
  const log = o.log ?? (() => undefined);
  let sent = 0;
  let failed = 0;
  for (const [index, requested] of paths.entries()) {
    const name = shortName(requested);
    try {
      if (!o.allowedSender || o.to !== o.allowedSender) throw new Refusal('recipient', '收件人不是绑定的微信号');
      if (index >= MAX_FILES_PER_REPLY) throw new Refusal('too-many', `一次最多发 ${MAX_FILES_PER_REPLY} 个文件`);
      const file = checkSendPath(requested, o.rules);
      const bytes = readFileSync(file.path);
      if (bytes.length > (o.rules.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES)) throw new Refusal('too-large', '超过大小上限');
      const image = SENDABLE_IMAGE.has(sniffExtension(bytes));
      try {
        await o.wx.sendFile(o.allowedSender, { name: file.name, bytes, image }, o.contextToken);
      } catch (error) {
        failed += 1;
        const code = (error as { code?: string })?.code ?? 'failed';
        log('file-error', { name: file.name, bytes: bytes.length, code, message: String((error as Error)?.message ?? error).slice(0, 200) });
        await o.notify(`文件「${name}」没发出去：${code === 'uncertain' ? '发送结果不确定，请看一下是否已收到' : '上传或发送失败'}。`);
        continue;
      }
      sent += 1;
      log('file-sent', { name: file.name, bytes: bytes.length, as: image ? 'image' : 'file' });
    } catch (error) {
      failed += 1;
      log('file-refused', { name, code: (error as Refusal)?.code ?? 'failed' });
      await o.notify(`文件「${name}」没发出去：${(error as Refusal)?.reason ?? '读取失败'}。`);
    }
  }
  return { sent, failed };
}
