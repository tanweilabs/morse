import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake of Tencent's iLink bot API + the WeChat CDN for tests (never the real servers):
 * QR, notifystart/stop, long-poll getupdates, sendmessage, getuploadurl + CDN upload,
 * CDN download, getconfig/sendtyping. `fetchImpl` is the test's "DNS": it sends the
 * plugin's https://ilinkai.weixin.qq.com and https://novac2c.cdn.weixin.qq.com requests
 * here, and refuses any other host (so a test fails if credentials would go elsewhere).
 */

export const OWNER = 'owner-123@im.wechat';
export const TOKEN = 'BOT-TOKEN-secret-123';
const HOSTS = new Set(['ilinkai.weixin.qq.com', 'novac2c.cdn.weixin.qq.com', 'liteapp.weixin.qq.com']);

export interface Sent {
  to: string;
  contextToken?: string;
  text?: string;
  item: Record<string, unknown>;
  auth: string | undefined;
}

export interface FakeIlink {
  url: string;
  fetchImpl: typeof fetch;
  sent: Sent[];
  calls: string[];
  hosts: Set<string>;
  /** Next getupdates answer gets these messages. */
  push(...msgs: Array<Record<string, unknown>>): void;
  /** Encrypted media served on /c2c/download?encrypted_query_param=<q>; returns the item media fields. */
  media(bytes: Buffer): { encrypt_query_param: string; aes_key: string };
  uploads: Buffer[];
  mode: { stale: boolean; failSend: number };
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

let seq = 1000;
/** A raw iLink message from `from` (default: the bound owner). */
export function wxText(text: string, opts: { from?: string; context?: string; id?: number } = {}): Record<string, unknown> {
  const id = opts.id ?? ++seq;
  return { message_id: id, seq: id, from_user_id: opts.from ?? OWNER, message_type: 1, context_token: opts.context ?? `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }] };
}

export async function startFakeIlink(): Promise<FakeIlink> {
  let queue: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  const store = new Map<string, Buffer>();
  const sent: Sent[] = [];
  const calls: string[] = [];
  const uploads: Buffer[] = [];
  const mode = { stale: false, failSend: 0 };
  let cursor = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const raw = await body(req);
      const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(v));
      };
      const p = u.pathname;
      calls.push(p.split('/').pop() ?? p);
      const auth = req.headers['authorization'] as string | undefined;
      if (p === '/c2c/upload') {
        uploads.push(raw);
        res.writeHead(200, { 'x-encrypted-param': `dl-${uploads.length}` });
        return res.end();
      }
      if (p === '/c2c/download') {
        const b = store.get(u.searchParams.get('encrypted_query_param') ?? '');
        if (!b) return json({}, 404);
        res.writeHead(200, { 'content-length': String(b.length) });
        return res.end(b);
      }
      const b = raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {};
      if (p.endsWith('get_bot_qrcode')) return json({ qrcode: 'qr-handle', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/abc' });
      if (p.endsWith('get_qrcode_status')) return json({ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot-1@im.bot', ilink_user_id: OWNER, baseurl: 'https://ilinkai.weixin.qq.com' });
      if (auth !== `Bearer ${TOKEN}`) return json({ errcode: -14 });
      if (mode.stale) return json({ errcode: -14 });
      if (p.endsWith('notifystart') || p.endsWith('notifystop') || p.endsWith('sendtyping')) return json({ ret: 0 });
      if (p.endsWith('getconfig')) return json({ ret: 0, typing_ticket: 'tk' });
      if (p.endsWith('getupdates')) {
        if (!queue.length) await new Promise<void>((r) => {
          const t = setTimeout(r, 400);
          waiters.push(() => {
            clearTimeout(t);
            r();
          });
        });
        if (mode.stale) return json({ errcode: -14 });
        const msgs = queue;
        queue = [];
        if (msgs.length) cursor += 1;
        return json({ ret: 0, msgs, get_updates_buf: `cursor-${cursor}` });
      }
      if (p.endsWith('getuploadurl')) return json({ ret: 0, upload_param: 'up-param' });
      if (p.endsWith('sendmessage')) {
        if (mode.failSend > 0) {
          mode.failSend -= 1;
          return json({ ret: -2 });
        }
        const msg = b['msg'] as { to_user_id: string; context_token?: string; item_list: Array<Record<string, unknown>> };
        const item = msg.item_list[0]!;
        sent.push({ to: msg.to_user_id, ...(msg.context_token ? { contextToken: msg.context_token } : {}), ...(item['text_item'] ? { text: (item['text_item'] as { text: string }).text } : {}), item, auth });
        return json({ ret: 0 });
      }
      return json({ ret: 404 }, 404);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const hosts = new Set<string>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    hosts.add(u.hostname);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new TypeError(`fake: refused ${u.protocol}//${u.hostname}`);
    return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return {
    url: `http://127.0.0.1:${port}`,
    fetchImpl,
    sent,
    calls,
    hosts,
    uploads,
    mode,
    push(...msgs) {
      queue.push(...msgs);
      for (const w of waiters.splice(0)) w();
    },
    media(bytes) {
      const key = randomBytes(16);
      const c = createCipheriv('aes-128-ecb', key, null);
      const q = `q-${store.size + 1}`;
      store.set(q, Buffer.concat([c.update(bytes), c.final()]));
      return { encrypt_query_param: q, aes_key: key.toString('base64') };
    },
    close: () => new Promise<void>((r) => {
      for (const w of waiters.splice(0)) w();
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

/** Decrypt an upload the plugin made (AES-128-ECB, key from the getuploadurl request is not kept: tests compare sizes). */
export function decryptUpload(data: Buffer, keyHex: string): Buffer {
  const d = createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null);
  return Buffer.concat([d.update(data), d.final()]);
}
