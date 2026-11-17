import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Inbox, isAllowedSender, readMessage, splitText } from '../src/plugins/ilink/bridge.js';
import { createIlink, LOGIN_BASE_URL, trustedBaseUrl, CDN_HOST, type IlinkClient } from '../src/plugins/ilink/ilink.js';
import { buildPrompt, collectMedia, decryptMedia, fetchMedia, mediaKey, mediaUrl, readItems, sanitizeName, saveMedia, sniffExtension, sweepMedia } from '../src/plugins/ilink/inbound.js';
import { login } from '../src/plugins/ilink/login.js';
import { checkSendPath, extractSendMarkers, MAX_FILES_PER_REPLY, sendFiles, sendInstruction } from '../src/plugins/ilink/outbound.js';
import { qrMatrix, qrPng } from '../src/plugins/ilink/qr.js';
import { beijingNow, createStore, preview } from '../src/plugins/ilink/store.js';

/**
 * ADR-053: the iLink half of weixin-bridge, ported into morse-plugin-ilink with its tests
 * (ilink / inbound / outbound / login / qr / core) — the safety properties unchanged.
 */

const BASE = 'https://ilinkai.weixin.qq.com/';
const TOKEN = 'TOKEN-abc';
const OWNER = 'owner@im.wechat';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(300)]);
const tmp = (p = 'ilink-') => realpathSync(mkdtempSync(join(tmpdir(), p)));

function fakeFetch(responses: unknown[]) {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), ...(init.method ? { method: init.method } : {}), headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => next } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('iLink client (ported)', () => {
  it('trustedBaseUrl: only https WeChat hosts', () => {
    expect(trustedBaseUrl('ilinkai-sh.weixin.qq.com')).toBe('https://ilinkai-sh.weixin.qq.com/');
    expect(trustedBaseUrl(LOGIN_BASE_URL)).toBe(LOGIN_BASE_URL);
    for (const bad of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.com', 'https://evil.com/?weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443', 'https://u:p@ilinkai.weixin.qq.com', 'http://127.0.0.1:8080']) {
      expect(() => trustedBaseUrl(bad), bad).toThrow(/base URL|non-WeChat/);
    }
  });

  it('a request to a non-WeChat base URL never leaves: no fetch, no token', async () => {
    const { impl, calls } = fakeFetch([{ ret: 0 }]);
    await expect(createIlink({ fetchImpl: impl }).sendText({ baseUrl: 'https://evil.example.com', token: TOKEN, to: 'u', text: 'x' })).rejects.toMatchObject({ code: 'untrusted-base-url' });
    expect(calls).toEqual([]);
  });

  it('fetchQr: request shape, no Authorization header', async () => {
    const { impl, calls } = fakeFetch([{ qrcode: 'h', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x' }]);
    expect(await createIlink({ fetchImpl: impl }).fetchQr()).toEqual({ qrcode: 'h', url: 'https://liteapp.weixin.qq.com/q/x' });
    expect(calls[0]!.url).toBe(`${BASE}ilink/bot/get_bot_qrcode?bot_type=3`);
    expect(calls[0]!.body).toEqual({ local_token_list: [] });
    expect(calls[0]!.headers['iLink-App-ClientVersion']).toBe('132102');
    expect(calls[0]!.headers['Authorization']).toBeUndefined();
  });

  it('getUpdates: cursor in, next cursor out; errcode -14 is a stale token; errors never carry the token', async () => {
    const { impl, calls } = fakeFetch([{ ret: 0, msgs: [{ message_id: 1 }], get_updates_buf: 'next' }, { ret: 0 }, { errcode: -14 }, new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })]);
    const api = createIlink({ fetchImpl: impl });
    expect(await api.getUpdates({ baseUrl: BASE, token: TOKEN, cursor: 'cur' })).toEqual({ msgs: [{ message_id: 1 }], cursor: 'next' });
    expect(calls[0]!.body!['get_updates_buf']).toBe('cur');
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(await api.getUpdates({ baseUrl: BASE, token: TOKEN, cursor: 'next' })).toEqual({ msgs: [], cursor: 'next' });
    await expect(api.getUpdates({ baseUrl: BASE, token: TOKEN })).rejects.toMatchObject({ code: 'stale-token' });
    const err = await api.getUpdates({ baseUrl: BASE, token: TOKEN }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'network' });
    expect((err as Error).message).toMatch(/ECONNRESET/);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('sendText: message shape; retried only when the connection failed', async () => {
    const { impl, calls } = fakeFetch([new TypeError('fetch failed'), { ret: 0 }, { ret: 1 }]);
    const api = createIlink({ fetchImpl: impl });
    await api.sendText({ baseUrl: BASE, token: TOKEN, to: 'u@im.wechat', text: '收到', contextToken: 'ctx' });
    expect(calls).toHaveLength(2);
    const msg = calls[1]!.body!['msg'] as Record<string, unknown>;
    expect({ ...msg, client_id: undefined }).toEqual({ from_user_id: '', to_user_id: 'u@im.wechat', client_id: undefined, message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: '收到' } }], context_token: 'ctx' });
    await expect(api.sendText({ baseUrl: BASE, token: TOKEN, to: 'u', text: 'x' })).rejects.toMatchObject({ code: 'rejected' });
    expect(calls).toHaveLength(3);
  });

  it('startTyping: ticket, on, off; failures never throw', async () => {
    const { impl, calls } = fakeFetch([{ ret: 0, typing_ticket: 'tk' }, { ret: 0 }, { ret: 0 }]);
    const stop = await createIlink({ fetchImpl: impl }).startTyping({ baseUrl: BASE, token: TOKEN, to: 'u', contextToken: 'ctx', keepaliveMs: 60_000 });
    await stop();
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['getconfig', 'sendtyping', 'sendtyping']);
    const errors: string[] = [];
    const broken = fakeFetch([new TypeError('fetch failed')]);
    const stopBroken = await createIlink({ fetchImpl: broken.impl }).startTyping({ baseUrl: BASE, token: TOKEN, to: 'u', onError: (e) => errors.push(e.code) });
    await stopBroken();
    expect(errors).toEqual(['network']);
  });

  it('sendFile: an upload address outside the WeChat CDN is refused before any bytes leave', async () => {
    const { impl, calls } = fakeFetch([{ ret: 0, upload_full_url: 'https://evil.example.com/c2c/upload' }]);
    await expect(createIlink({ fetchImpl: impl }).sendFile({ baseUrl: BASE, token: TOKEN, to: OWNER, name: 'a.png', bytes: PNG, image: true })).rejects.toMatchObject({ code: 'upload-failed' });
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['getuploadurl']);
  });
});

describe('core helpers (ported)', () => {
  it('splitText: within the limit, prefers line breaks, keeps surrogate pairs whole', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('short')).toEqual(['short']);
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`).join('\n');
    const chunks = splitText(lines, 1800);
    expect(chunks.every((c) => c.length <= 1800)).toBe(true);
    expect(chunks.join('\n')).toBe(lines);
    for (const c of splitText('😀'.repeat(1000), 1800)) expect(/[\ud800-\udbff]$/.test(c)).toBe(false);
  });

  it('isAllowedSender / readMessage / preview', () => {
    expect(isAllowedSender(OWNER, OWNER)).toBe(true);
    for (const x of ['', 'other', null, undefined]) expect(isAllowedSender(x, OWNER)).toBe(false);
    expect(readMessage({ message_id: 5, from_user_id: OWNER, context_token: 'c', item_list: [{ type: 1, text_item: { text: 'hi' } }], message_type: 1 })).toMatchObject({ id: '5', from: OWNER, fromBot: false, text: 'hi', contextToken: 'c' });
    expect(readMessage({ message_id: 6, message_type: 2 }).fromBot).toBe(true);
    expect(preview('一二三四五六七八九十一二三四五六七八九十多出来的')).toEqual({ len: 24, head: '一二三四五六七八九十一二三四五六七八九十' });
  });

  it('Inbox: cursor and queue survive a restart; others and bot echoes are ignored; interrupted once', () => {
    const store = createStore(tmp());
    const inbox = new Inbox(store);
    inbox.accept([{ message_id: 2, seq: 2, from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: 'b' } }] }, { message_id: 1, seq: 1, from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: 'a' } }] }, { message_id: 3, from_user_id: 'stranger', seq: 3 }, { message_id: 4, message_type: 2, seq: 4 }], 'c1', { allowedSender: OWNER });
    const again = new Inbox(store);
    expect(again.cursor).toBe('c1');
    expect(again.size).toBe(2);
    expect(again.begin()!.text).toBe('a');
    // a crash here: the active one is handed back once and never re-run
    const after = new Inbox(store);
    expect(after.takeInterrupted()!.id).toBe('1');
    expect(after.takeInterrupted()).toBeNull();
    expect(after.begin()!.text).toBe('b');
    // a replayed id is not queued twice
    after.accept([{ message_id: 2, from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: 'b' } }] }], '', { allowedSender: OWNER });
    expect(after.size).toBe(1);
    expect(statSync(store.path('inbox.json')).mode & 0o777).toBe(0o600);
    expect(statSync(store.dir).mode & 0o777).toBe(0o700);
  });

  it('log: secret-looking fields never reach the log', () => {
    const store = createStore(tmp());
    store.log('x', { token: TOKEN, Authorization: 'Bearer y', aeskey: 'k', id: '1', ...preview('a long message that should be cut here') });
    const log = readFileSync(store.path('ilink.log'), 'utf8');
    expect(log).not.toMatch(/TOKEN-abc|Bearer|aeskey/);
    expect(log).toContain('head="a long message that "');
    expect(statSync(store.path('ilink.log')).mode & 0o777).toBe(0o600);
  });
});

describe('inbound media (ported)', () => {
  const encrypt = (plain: Buffer, key: Buffer) => {
    const c = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([c.update(plain), c.final()]);
  };
  const cdn = (files: Record<string, Buffer | (() => Response)>) =>
    (async (url: string | URL, init: RequestInit) => {
      const u = new URL(String(url));
      expect(u.hostname).toBe(CDN_HOST);
      expect(init.redirect).toBe('manual');
      const e = files[u.searchParams.get('encrypted_query_param') ?? ''];
      if (typeof e === 'function') return e();
      return e ? new Response(new Uint8Array(e), { status: 200 }) : new Response('missing', { status: 404 });
    }) as unknown as typeof fetch;

  it('readItems: text, attachments, transcribed voice, unknown types', () => {
    const r = readItems({ item_list: [{ type: 1, text_item: { text: ' hi ' } }, { type: 2, image_item: { aeskey: 'a'.repeat(32), media: { encrypt_query_param: 'q' } } }, { type: 3, voice_item: { text: '语音转文字' } }, { type: 4, file_item: { file_name: 'r.pdf', len: '12', media: { aes_key: 'b64', encrypt_query_param: 'q2' } } }, { type: 99 }] });
    expect(r.text).toBe('hi\n语音转文字');
    expect(r.media).toEqual([{ kind: 'image', aeskey: 'a'.repeat(32), query: 'q' }, { kind: 'file', name: 'r.pdf', size: 12, aesKeyB64: 'b64', query: 'q2' }]);
    expect(r.unknown).toEqual(['99']);
  });

  it('mediaKey and mediaUrl: three key encodings; downloads only from the WeChat CDN', () => {
    const key = randomBytes(16);
    expect(mediaKey({ kind: 'image', aeskey: key.toString('hex') })!.key).toEqual(key);
    expect(mediaKey({ kind: 'image', aesKeyB64: key.toString('base64') })!.key).toEqual(key);
    expect(mediaKey({ kind: 'image', aesKeyB64: Buffer.from(key.toString('hex')).toString('base64') })!.key).toEqual(key);
    expect(mediaKey({ kind: 'image' })).toBeNull();
    expect(() => mediaKey({ kind: 'image', aeskey: 'zz' })).toThrow();
    expect(mediaUrl({ kind: 'image', query: 'a+b/c=' }).url).toBe(`https://${CDN_HOST}/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D`);
    for (const bad of [`http://${CDN_HOST}/c2c/x`, 'https://evil.example.com/c2c/x', `https://${CDN_HOST}.evil.com/c2c/x`, `https://${CDN_HOST}/other/x`, `https://u:p@${CDN_HOST}/c2c/x`]) {
      expect(() => mediaUrl({ kind: 'image', fullUrl: bad })).toThrow(/CDN|URL/);
    }
  });

  it('download + decrypt round trip, saved 0600 under media/<date>/; size caps; wrong key', async () => {
    const dir = tmp('ilink-media-');
    const key = randomBytes(16);
    // "bad": fixed bytes and fixed keys. AES-ECB has no integrity check — a wrong key is only noticed by
    // the padding, and with RANDOM keys the padding happens to look valid once in about 256 runs.
    const fetchImpl = cdn({ ok: encrypt(PNG, key), big: randomBytes(5000), bad: encrypt(Buffer.alloc(40, 7), Buffer.alloc(16, 1)) });
    const { saved, failed } = await collectMedia({ id: '7001', media: [{ kind: 'image', query: 'ok', aeskey: key.toString('hex') }, { kind: 'file', query: 'big', name: 'b.bin' }] }, { dir, fetchImpl, maxBytes: 2000, timeoutMs: 2000 });
    expect(saved).toHaveLength(1);
    expect(isAbsolute(saved[0]!.path)).toBe(true);
    expect(saved[0]!.path).toBe(join(dir, beijingNow().slice(0, 10), '7001-image-1.png'));
    expect(readFileSync(saved[0]!.path)).toEqual(PNG);
    expect(statSync(saved[0]!.path).mode & 0o777).toBe(0o600);
    expect(failed).toEqual([{ kind: 'file', name: 'b.bin', index: 1, reason: '超过大小上限' }]);
    await expect(fetchMedia({ kind: 'image', query: 'bad', aeskey: Buffer.alloc(16, 2).toString('hex') }, { fetchImpl })).rejects.toMatchObject({ code: 'decrypt-failed' });
    expect(() => decryptMedia(Buffer.alloc(0), randomBytes(16))).toThrow();
  });

  it('sanitizeName / sniffExtension / saveMedia naming / buildPrompt / sweepMedia', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('.env')).toBe('env');
    expect(sanitizeName('x$(rm -rf ~)`id`;.sh')).toBe('x_(rm -rf ~)_id__.sh');
    expect(Array.from(sanitizeName(`${'长'.repeat(300)}.docx`))).toHaveLength(80);
    expect(sniffExtension(PNG)).toBe('.png');
    expect(sniffExtension(Buffer.from('\x02#!SILK_V3', 'latin1'))).toBe('.silk');
    const dir = tmp('ilink-media-');
    const day = beijingNow().slice(0, 10);
    expect(saveMedia({ dir, messageId: '12/..', part: { kind: 'file', name: '../a b.txt' }, bytes: Buffer.from('1') })).toBe(join(dir, day, '12___-a b.txt'));
    expect(saveMedia({ dir, messageId: '12/..', part: { kind: 'file', name: 'a b.txt' }, bytes: Buffer.from('2') })).toBe(join(dir, day, '12___-a b-2.txt'));
    expect(buildPrompt({ text: '你好' })).toBe('你好');
    expect(buildPrompt({ text: '看看', saved: [{ kind: 'image', path: '/m/1.png' }] })).toBe('用户通过微信发来一张图片，已保存到 /m/1.png。\n用户同时写道：\n看看');
    const old = join(dir, '2020-01-01');
    mkdirSync(old);
    writeFileSync(join(old, 'x.png'), 'x');
    utimesSync(join(old, 'x.png'), new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(sweepMedia(dir, 30)).toBe(1);
    expect(existsSync(old)).toBe(false);
  });
});

describe('outbound files (ported, ADR-053 rules)', () => {
  function sandbox() {
    const base = tmp('ilink-out-');
    const root = join(base, 'root');
    const morseDir = join(base, 'home', '.morse');
    const stateDir = join(morseDir, 'plugins', 'ilink');
    const mediaDir = join(root, 'wechat-media');
    const outside = join(base, 'outside');
    for (const d of [join(root, 'docs', '.cache'), join(root, '.git'), join(stateDir), join(mediaDir, '2026-11-12'), outside]) mkdirSync(d, { recursive: true });
    const put = (path: string, data: string | Buffer = 'content') => {
      writeFileSync(path, data);
      return path;
    };
    return { base, root, stateDir, mediaDir, morseDir, outside, put, rules: { root, stateDir, mediaDir, morseDir, maxBytes: 1_000 } };
  }
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'allowed';
  };

  it('extractSendMarkers: exact marker lines are stripped, in order; fenced ones are examples', () => {
    const { text, paths } = extractSendMarkers(['文件：', '[[send-file: /x/a b.pdf]]', '  [[send-file:/x/图.png]]  ', '行内的 [[send-file: /no]] 不算', '```', '[[send-file: /inside/fence]]', '```'].join('\n'));
    expect(paths).toEqual(['/x/a b.pdf', '/x/图.png']);
    expect(text).toBe('文件：\n行内的 [[send-file: /no]] 不算\n```\n[[send-file: /inside/fence]]\n```');
    expect(sendInstruction({ root: '/w' })).toContain('[[send-file: /绝对路径/文件名]]');
  });

  it('rules: inside the root only (links cannot escape), no hidden parts, no credentials, size cap, never the plugin state or ~/.morse', () => {
    const box = sandbox();
    const file = box.put(join(box.root, 'docs', '报告.pdf'));
    expect(checkSendPath(file, box.rules)).toEqual({ path: file, name: '报告.pdf', size: 7 });
    expect(refusal(() => checkSendPath('docs/x', box.rules))).toBe('not-absolute');
    expect(refusal(() => checkSendPath(join(box.root, 'nope'), box.rules))).toBe('not-found');
    const secret = box.put(join(box.outside, 'private.txt'));
    symlinkSync(secret, join(box.root, 'docs', 'innocent.txt'));
    expect(refusal(() => checkSendPath(secret, box.rules))).toBe('outside-root');
    expect(refusal(() => checkSendPath(join(box.root, 'docs', 'innocent.txt'), box.rules))).toBe('outside-root');
    box.put(join(box.root, '.env'));
    box.put(join(box.root, 'docs', '.cache', 'p.html'));
    expect(refusal(() => checkSendPath(join(box.root, '.env'), box.rules))).toBe('hidden-path');
    expect(refusal(() => checkSendPath(join(box.root, 'docs', '.cache', 'p.html'), box.rules))).toBe('hidden-path');
    for (const name of ['server.pem', 'id_rsa', 'api_token.txt', 'account.json', 'passwords.csv']) {
      box.put(join(box.root, 'docs', name));
      expect(refusal(() => checkSendPath(join(box.root, 'docs', name), box.rules)), name).toBe('credential-name');
    }
    box.put(join(box.root, 'docs', 'big.bin'), Buffer.alloc(1001));
    box.put(join(box.root, 'docs', 'empty.txt'), '');
    expect(refusal(() => checkSendPath(join(box.root, 'docs', 'big.bin'), box.rules))).toBe('too-large');
    expect(refusal(() => checkSendPath(join(box.root, 'docs', 'empty.txt'), box.rules))).toBe('empty');
    // the plugin's state and Morse's data are off limits even when the root contains them
    const wide = { ...box.rules, root: box.base };
    expect(refusal(() => checkSendPath(box.put(join(box.stateDir, 'inbox.json')), wide))).toBe('hidden-path');
    const visible = join(box.base, 'state-copy');
    mkdirSync(visible);
    expect(refusal(() => checkSendPath(box.put(join(visible, 'x.txt')), { ...wide, stateDir: visible }))).toBe('plugin-state');
    // received media may go back; files sending off without a root
    expect(checkSendPath(box.put(join(box.mediaDir, '2026-11-12', '1-image.png')), box.rules).name).toBe('1-image.png');
    expect(refusal(() => checkSendPath(file, { root: null }))).toBe('disabled');
  });

  it('at most 5 files per message; the recipient is only ever the bound user', async () => {
    const box = sandbox();
    const paths = Array.from({ length: 7 }, (_, i) => box.put(join(box.root, 'docs', `f${i}.txt`), `file ${i}`));
    const sent: string[] = [];
    const lines: string[] = [];
    const wx = { sendFile: async (to: string, f: { name: string }) => void sent.push(`${to}:${f.name}`) };
    const r = await sendFiles(paths, { to: OWNER, allowedSender: OWNER, contextToken: null, wx, rules: box.rules, notify: async (l) => void lines.push(l) });
    expect(r).toEqual({ sent: MAX_FILES_PER_REPLY, failed: 2 });
    expect(sent.every((s) => s.startsWith(`${OWNER}:`))).toBe(true);
    expect(lines).toHaveLength(2);
    sent.length = 0;
    await sendFiles(paths.slice(0, 1), { to: 'someone-else', allowedSender: OWNER, contextToken: null, wx, rules: box.rules, notify: async () => undefined });
    expect(sent).toEqual([]);
  });
});

describe('login and QR (ported)', () => {
  const QR = { qrcode: 'qr-handle', url: 'https://liteapp.weixin.qq.com/q/abc' };
  const api = (statuses: Array<Record<string, unknown>>) => {
    const seen: unknown[] = [];
    return {
      seen,
      client: { fetchQr: async (o: unknown) => (seen.push(o), QR), pollQr: async (o: unknown) => (seen.push(o), statuses.shift() ?? { status: 'expired' }) } as unknown as IlinkClient,
    };
  };

  it('--no-wait writes a PNG to --qr and stops; confirmed scan stores credentials 0600 with the scanner as the only sender', async () => {
    const store = createStore(tmp());
    const png = join(tmp(), 'qr', 'code.png');
    const a = api([]);
    expect((await login({ api: a.client, store, log: store.log, out: () => undefined, wait: false, qrPath: png })).status).toBe('qr-issued');
    expect([...readFileSync(png).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(existsSync(store.path('account.json'))).toBe(false);

    const b = api([{ status: 'scaned' }, { status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot', ilink_user_id: OWNER, baseurl: 'https://ilinkai.weixin.qq.com' }]);
    expect((await login({ api: b.client, store, log: store.log, out: () => undefined, qrPath: png })).status).toBe('bound');
    const acc = JSON.parse(readFileSync(store.path('account.json'), 'utf8'));
    expect(acc).toMatchObject({ token: TOKEN, allowedSender: OWNER, baseUrl: 'https://ilinkai.weixin.qq.com/' });
    expect(statSync(store.path('account.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(png)).toBe(false);
    expect(readFileSync(store.path('ilink.log'), 'utf8')).not.toContain(TOKEN);
    // not overwritten without --force
    expect((await login({ api: api([]).client, store, log: store.log, out: () => undefined })).status).toBe('already-bound');
  });

  it('refuses a base URL outside WeChat', async () => {
    const store = createStore(tmp());
    const a = api([{ status: 'confirmed', bot_token: TOKEN, ilink_bot_id: 'bot', ilink_user_id: OWNER, baseurl: 'https://evil.example.com' }]);
    await expect(login({ api: a.client, store, log: store.log, out: () => undefined, qrPath: join(tmp(), 'q.png') })).rejects.toThrow(/non-WeChat/);
    expect(existsSync(store.path('account.json'))).toBe(false);
  });

  it('qr: picks a version that fits, draws the finder patterns, valid PNG', () => {
    const m = qrMatrix('https://liteapp.weixin.qq.com/q/abc?qrcode=x&bot_type=3');
    expect(m.length % 4).toBe(1);
    expect(m[0]!.slice(0, 7).every(Boolean)).toBe(true);
    const png = qrPng('hello', { scale: 2, margin: 1 });
    expect(png.readUInt32BE(16)).toBe((21 + 2) * 2);
  });
});
