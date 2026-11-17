import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Minimal client for Tencent's iLink bot API (the WeChat "ClawBot"): QR binding, long-poll
 * receive, text send, file send (AES-128-ECB to the WeChat CDN), typing indicator. Ported
 * from weixin-bridge lib/ilink.mjs. An unofficial, community-documented protocol that
 * Tencent may change. Knows nothing about Morse.
 *
 * Safety: credentials are only ever sent to https hosts under weixin.qq.com / wechat.com;
 * file bytes only to the WeChat CDN upload endpoint; error messages never carry the token.
 */

export const LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com/';
export const CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const BOT_TYPE = '3';
const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6);
const BOT_AGENT = 'morse-plugin-ilink/0.1.0';
const LONG_POLL_MS = 35_000;
const SEND_RETRY_DELAYS_MS = [400, 1_200];
const STALE_TOKEN_CODE = '-14';
const UPLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_ATTEMPTS = 3;
const MEDIA_TYPE = { image: 1, file: 3 } as const; // getuploadurl media_type
const ITEM_TYPE = { image: 2, file: 4 } as const; // sendmessage item type

export type FetchImpl = typeof fetch;

export class IlinkError extends Error {
  code: string;
  status?: number;
  providerCode?: string;
  constructor(code: string, message: string, extra: { status?: number; providerCode?: string } = {}) {
    super(message);
    this.name = 'IlinkError';
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.providerCode !== undefined) this.providerCode = extra.providerCode;
  }
}

/** Credentials are only ever sent to https hosts under weixin.qq.com / wechat.com. */
export function trustedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(String(value).includes('://') ? value : `https://${value}`);
  } catch {
    throw new IlinkError('bad-base-url', 'iLink returned an invalid base URL');
  }
  const host = url.hostname.toLowerCase();
  const ok = ['weixin.qq.com', 'wechat.com'].some((d) => host === d || host.endsWith(`.${d}`));
  if (url.protocol !== 'https:' || !ok || (url.port && url.port !== '443') || url.username || url.password) {
    throw new IlinkError('untrusted-base-url', `refusing non-WeChat host ${host}`);
  }
  return `https://${host}/`;
}

function headers(token: string | undefined, bare: boolean): Record<string, string> {
  const base: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': CLIENT_VERSION };
  if (bare) return base;
  return {
    ...base,
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT });

type Json = Record<string, unknown>;

/** Non-zero `ret` / `errcode` in a 200 response means the service refused the call. */
function refusal(response: Json | null | undefined): string | null {
  for (const field of ['errcode', 'ret']) {
    const value = response?.[field];
    if (value !== undefined && value !== 0 && value !== '0') return String(value);
  }
  return null;
}

function check(response: Json, what: string): Json {
  const code = refusal(response);
  if (!code) return response;
  if (code === STALE_TOKEN_CODE) throw new IlinkError('stale-token', 'bot token is no longer valid', { providerCode: code });
  throw new IlinkError('rejected', `${what} rejected by iLink (code ${code})`, { providerCode: code });
}

export interface Creds {
  baseUrl: string;
  token: string;
}

export interface IlinkClient {
  fetchQr(o?: { localTokens?: string[]; signal?: AbortSignal }): Promise<{ qrcode: string; url: string }>;
  pollQr(o: { qrcode: string; baseUrl?: string; verifyCode?: string | undefined; signal?: AbortSignal | undefined }): Promise<Json>;
  notifyStart(c: Creds): Promise<void>;
  notifyStop(c: Creds): Promise<void>;
  getUpdates(o: Creds & { cursor?: string; signal?: AbortSignal }): Promise<{ msgs: Json[]; cursor: string }>;
  sendText(o: Creds & { to: string; text: string; contextToken?: string | null }): Promise<void>;
  sendFile(o: Creds & { to: string; name: string; bytes: Buffer; image?: boolean; contextToken?: string | null; signal?: AbortSignal }): Promise<void>;
  startTyping(o: Creds & { to: string; contextToken?: string | null; onError?: (e: IlinkError) => void; keepaliveMs?: number }): Promise<() => Promise<void>>;
}

export function createIlink({ fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {}): IlinkClient {
  async function request(o: { baseUrl: string; path: string; method?: string; body?: unknown; token?: string; bare?: boolean; timeoutMs?: number; signal?: AbortSignal | undefined }): Promise<Json> {
    const url = new URL(o.path, trustedBaseUrl(o.baseUrl));
    const timeoutMs = o.timeoutMs ?? 15_000;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: o.method ?? 'POST',
        headers: headers(o.token, o.bare ?? false),
        ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      });
    } catch (error) {
      if (o.signal?.aborted) throw new IlinkError('aborted', 'request aborted');
      if (timeout.aborted) throw new IlinkError('timeout', `${url.pathname} timed out after ${timeoutMs}ms`);
      const e = error as { cause?: { code?: string; message?: string }; message?: string };
      const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'unknown';
      throw new IlinkError('network', `${url.pathname} network error: ${cause}`);
    }
    if (!response.ok) throw new IlinkError('http', `${url.pathname} HTTP ${response.status}`, { status: response.status });
    try {
      return (await response.json()) as Json;
    } catch {
      throw new IlinkError('bad-json', `${url.pathname} returned a non-JSON body`);
    }
  }

  const message = (to: string, item: unknown, contextToken?: string | null) => ({
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `morse-ilink-${randomUUID()}`,
      message_type: 2,
      message_state: 2,
      item_list: [item],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: baseInfo(),
  });

  return {
    // Step 1 of binding: `url` is what the phone scans; `qrcode` is the handle to poll.
    async fetchQr({ localTokens = [], signal } = {}) {
      const response = check(
        await request({ baseUrl: LOGIN_BASE_URL, path: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`, body: { local_token_list: localTokens }, timeoutMs: 10_000, signal }),
        'QR request',
      );
      const qrcode = response['qrcode'];
      const url = response['qrcode_img_content'];
      if (typeof qrcode !== 'string' || !qrcode || typeof url !== 'string' || !url) throw new IlinkError('bad-qr', 'iLink did not return a QR code');
      if (new URL(url).protocol !== 'https:') throw new IlinkError('bad-qr', 'QR target is not https');
      trustedBaseUrl(new URL(url).origin);
      return { qrcode, url };
    },

    // Step 2: long-poll the scan status. A client-side timeout just means "still waiting".
    async pollQr({ qrcode, baseUrl = LOGIN_BASE_URL, verifyCode, signal }) {
      let path = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      if (verifyCode) path += `&verify_code=${encodeURIComponent(verifyCode)}`;
      try {
        return await request({ baseUrl, path, method: 'GET', bare: true, timeoutMs: LONG_POLL_MS, signal });
      } catch (error) {
        if ((error as IlinkError).code === 'timeout') return { status: 'wait' };
        throw error;
      }
    },

    async notifyStart({ baseUrl, token }) {
      check(await request({ baseUrl, token, path: 'ilink/bot/msg/notifystart', body: { base_info: baseInfo() }, timeoutMs: 10_000 }), 'start');
    },

    async notifyStop({ baseUrl, token }) {
      check(await request({ baseUrl, token, path: 'ilink/bot/msg/notifystop', body: { base_info: baseInfo() }, timeoutMs: 10_000 }), 'stop');
    },

    // Long-poll for inbound messages: the messages plus the cursor to send next time.
    async getUpdates({ baseUrl, token, cursor = '', signal }) {
      let response: Json;
      try {
        response = await request({ baseUrl, token, signal, path: 'ilink/bot/getupdates', body: { get_updates_buf: cursor, base_info: baseInfo() }, timeoutMs: LONG_POLL_MS });
      } catch (error) {
        if ((error as IlinkError).code === 'timeout') return { msgs: [], cursor };
        throw error;
      }
      check(response, 'getupdates');
      const buf = response['get_updates_buf'];
      const next = typeof buf === 'string' && buf ? buf : cursor;
      const msgs = response['msgs'];
      return { msgs: Array.isArray(msgs) ? (msgs as Json[]) : [], cursor: next };
    },

    // One text message (the caller chunks). Retried only when no HTTP response arrived at
    // all, because iLink does not de-duplicate and a timed-out send may have been delivered.
    async sendText({ baseUrl, token, to, text, contextToken }) {
      const body = message(to, { type: 1, text_item: { text } }, contextToken);
      for (let attempt = 0; ; attempt += 1) {
        try {
          check(await request({ baseUrl, token, path: 'ilink/bot/sendmessage', body }), 'send');
          return;
        } catch (error) {
          const wait = SEND_RETRY_DELAYS_MS[attempt];
          if ((error as IlinkError).code !== 'network' || wait === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    },

    // One image or file: (1) an upload slot, (2) the AES-128-ECB encrypted bytes to the
    // WeChat CDN, (3) a message whose item points at the upload.
    async sendFile({ baseUrl, token, to, name, bytes, image = false, contextToken, signal }) {
      const kind = image ? 'image' : 'file';
      const fileKey = randomBytes(16).toString('hex');
      const aesKey = randomBytes(16);
      const cipher = createCipheriv('aes-128-ecb', aesKey, null);
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const slot = check(
        await request({
          baseUrl, token, signal,
          path: 'ilink/bot/getuploadurl',
          body: {
            filekey: fileKey,
            media_type: MEDIA_TYPE[kind],
            to_user_id: to,
            rawsize: bytes.length,
            rawfilemd5: createHash('md5').update(bytes).digest('hex'),
            filesize: encrypted.length,
            no_need_thumb: true,
            aeskey: aesKey.toString('hex'),
            base_info: baseInfo(),
          },
        }),
        'upload request',
      );
      let uploadUrl: URL;
      const full = slot['upload_full_url'];
      const param = slot['upload_param'];
      if (typeof full === 'string' && full) uploadUrl = new URL(full);
      else if (typeof param === 'string' && param) {
        uploadUrl = new URL(`https://${CDN_HOST}/c2c/upload`);
        uploadUrl.searchParams.set('encrypted_query_param', param);
        uploadUrl.searchParams.set('filekey', fileKey);
      } else throw new IlinkError('upload-failed', 'iLink returned no upload address');
      // File bytes only ever go to the WeChat CDN upload endpoint.
      if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== CDN_HOST || (uploadUrl.port && uploadUrl.port !== '443') || uploadUrl.pathname !== '/c2c/upload' || uploadUrl.username || uploadUrl.password) {
        throw new IlinkError('upload-failed', 'iLink returned an untrusted upload address');
      }

      let downloadParam: string | null = null;
      for (let attempt = 1; !downloadParam; attempt += 1) {
        let failure: IlinkError | null = null;
        try {
          const timeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
          const response = await fetchImpl(uploadUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(encrypted.length) },
            body: encrypted,
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          downloadParam = response.status === 200 ? response.headers.get('x-encrypted-param') : null;
          await response.body?.cancel?.().catch(() => undefined);
          if (!downloadParam) failure = new IlinkError('upload-failed', `CDN upload answered HTTP ${response.status}${response.status === 200 ? ' without a download parameter' : ''}`, { status: response.status });
        } catch (error) {
          const e = error as { cause?: { code?: string }; name?: string };
          failure = new IlinkError('upload-failed', `CDN upload failed: ${e?.cause?.code ?? e?.name ?? 'unknown'}`);
        }
        if (!failure) break;
        const st = failure.status ?? 0;
        if (signal?.aborted || (st >= 400 && st < 500) || st === 200 || attempt >= UPLOAD_ATTEMPTS) throw failure;
      }

      const media = { encrypt_query_param: downloadParam, aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'), encrypt_type: 1 };
      const item = image
        ? { type: ITEM_TYPE.image, image_item: { media, mid_size: encrypted.length } }
        : { type: ITEM_TYPE.file, file_item: { media, file_name: name, len: String(bytes.length) } };
      let response: Json;
      try {
        response = await request({ baseUrl, token, signal, path: 'ilink/bot/sendmessage', body: message(to, item, contextToken) });
      } catch (error) {
        // no clear answer: it may or may not have been delivered — not retried (no de-duplication)
        const e = error as IlinkError;
        if (['network', 'timeout', 'bad-json'].includes(e.code) || (e.status ?? 0) >= 500) throw new IlinkError('uncertain', `file message result unknown: ${e.message}`);
        throw error;
      }
      check(response, 'file message');
    },

    // "typing…" until the returned function is called. Best effort: failures never throw.
    async startTyping({ baseUrl, token, to, contextToken, onError = () => undefined, keepaliveMs = 5_000 }) {
      const send = (ticket: string, status: number) =>
        request({ baseUrl, token, timeoutMs: 10_000, path: 'ilink/bot/sendtyping', body: { ilink_user_id: to, typing_ticket: ticket, status, base_info: baseInfo() } }).then((r) => check(r, 'typing'));
      let ticket: string | null = null;
      let timer: NodeJS.Timeout | undefined;
      try {
        const config = check(
          await request({ baseUrl, token, timeoutMs: 10_000, path: 'ilink/bot/getconfig', body: { ilink_user_id: to, ...(contextToken ? { context_token: contextToken } : {}), base_info: baseInfo() } }),
          'getconfig',
        );
        const t = config['typing_ticket'];
        ticket = typeof t === 'string' && t ? t : null;
        if (!ticket) return async () => undefined;
        await send(ticket, 1);
        const held = ticket;
        timer = setInterval(() => void send(held, 1).catch((e: IlinkError) => onError(e)), keepaliveMs);
        timer.unref?.();
      } catch (error) {
        onError(error as IlinkError);
      }
      return async () => {
        clearInterval(timer);
        if (ticket) await send(ticket, 2).catch((e: IlinkError) => onError(e));
      };
    },
  };
}
