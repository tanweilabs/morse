import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOGIN_BASE_URL, trustedBaseUrl, type IlinkClient } from './ilink.js';
import { qrPng } from './qr.js';
import { beijingNow, type Log, type Store } from './store.js';

/**
 * QR binding (ported from weixin-bridge lib/login.mjs): fetch the link, write a PNG of it
 * (to --qr <path>, default <state>/qr.png), poll until the phone confirms, then store the
 * bot credentials in <state>/account.json (0600). The person who scans becomes the only
 * WeChat user whose messages are accepted.
 */

const QR_TTL_MS = 5 * 60_000;

export interface Account {
  token: string;
  botId: string;
  baseUrl: string;
  ownerUserId: string;
  allowedSender: string;
  boundAt: string;
}

export function readAccount(store: Store): Account | null {
  const a = store.readJson<Partial<Account> | null>('account.json', null);
  return a && typeof a.token === 'string' && a.token && typeof a.baseUrl === 'string' && typeof a.allowedSender === 'string' && a.allowedSender ? (a as Account) : null;
}

// WeChat may ask for a pairing code shown on the phone: from the terminal, or (no
// terminal) from <state>/verify_code.txt.
async function readVerifyCode(store: Store, out: (l: string) => void, deadline: number, signal?: AbortSignal): Promise<string | null> {
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question('Pairing code shown in WeChat: ', signal ? { signal } : {})).trim();
    } finally {
      rl.close();
    }
  }
  out(`WeChat asks for a pairing code: write it into ${store.path('verify_code.txt')} and this continues.`);
  while (Date.now() < deadline && !signal?.aborted) {
    if (existsSync(store.path('verify_code.txt'))) {
      const code = readFileSync(store.path('verify_code.txt'), 'utf8').trim();
      store.remove('verify_code.txt');
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

export type LoginStatus = 'bound' | 'already-bound' | 'qr-issued' | 'expired' | 'failed';

export async function login(o: { api: IlinkClient; store: Store; log: Log; out?: (l: string) => void; wait?: boolean; force?: boolean; qrPath?: string; signal?: AbortSignal; ttlMs?: number }): Promise<{ status: LoginStatus }> {
  const out = o.out ?? console.log;
  const existing = o.store.readJson<Partial<Account> | null>('account.json', null);
  if (existing && !o.force) {
    out(`already bound (${o.store.path('account.json')}). To bind again: login --force`);
    return { status: 'already-bound' };
  }
  // Our own previous token (if any) lets the service answer "already bound" instead of
  // issuing a second binding. Nobody else's tokens are ever read.
  const qr = await o.api.fetchQr({ localTokens: existing?.token ? [existing.token] : [], ...(o.signal ? { signal: o.signal } : {}) });
  const png = o.qrPath ?? o.store.path('qr.png');
  o.store.writeFile('qr.txt', `${qr.url}\n`);
  try {
    mkdirSync(dirname(png), { recursive: true });
    writeFileSync(png, qrPng(qr.url), { mode: 0o600 });
    chmodSync(png, 0o600);
    out(`QR code: ${png} — scan it with WeChat within 5 minutes (the link is in ${o.store.path('qr.txt')})`);
  } catch (error) {
    out(`could not write the QR image (${(error as Error).message}); turn the link in ${o.store.path('qr.txt')} into a QR code and scan it`);
  }
  o.log('qr-issued', {});
  if (o.wait === false) return { status: 'qr-issued' };

  const cleanup = () => {
    o.store.remove('qr.txt');
    rmSync(png, { force: true });
  };
  const deadline = Date.now() + (o.ttlMs ?? QR_TTL_MS);
  let baseUrl = LOGIN_BASE_URL;
  let verifyCode: string | undefined;
  let last = '';
  while (Date.now() < deadline && !o.signal?.aborted) {
    const response = await o.api.pollQr({ qrcode: qr.qrcode, baseUrl, verifyCode, signal: o.signal });
    const status = String(response['status'] ?? '');
    if (status !== last) o.log('qr-status', { status });
    last = status;
    if (status === 'scaned') {
      verifyCode = undefined;
      out('scanned — confirm on the phone');
    } else if (status === 'scaned_but_redirect') {
      baseUrl = trustedBaseUrl(String(response['redirect_host'] || baseUrl));
    } else if (status === 'need_verifycode') {
      const code = await readVerifyCode(o.store, out, deadline, o.signal);
      if (!code) break;
      verifyCode = code;
    } else if (status === 'verify_code_blocked') {
      cleanup();
      out('the pairing code was wrong too many times — run login again');
      return { status: 'failed' };
    } else if (status === 'binded_redirect') {
      cleanup();
      out(existing ? 'this WeChat account is already bound to the existing credentials — kept' : 'WeChat says the account is already bound, but returned no new credentials');
      return { status: existing ? 'already-bound' : 'failed' };
    } else if (status === 'expired') {
      break;
    } else if (status === 'confirmed') {
      const token = response['bot_token'];
      const botId = response['ilink_bot_id'];
      const ownerUserId = response['ilink_user_id'];
      if (![token, botId, ownerUserId].every((v) => typeof v === 'string' && v)) throw new Error('iLink confirmed the binding but returned incomplete credentials');
      const account: Account = {
        token: token as string,
        botId: botId as string,
        baseUrl: trustedBaseUrl(String(response['baseurl'] || baseUrl)),
        ownerUserId: ownerUserId as string,
        allowedSender: ownerUserId as string, // only the person who scanned may talk through it
        boundAt: beijingNow(),
      };
      o.store.writeJson('account.json', account);
      o.store.remove('inbox.json'); // a cursor belongs to one binding
      o.store.remove('status.json');
      cleanup();
      o.log('bound', {});
      out(`bound — credentials saved in ${o.store.path('account.json')} (0600)`);
      return { status: 'bound' };
    }
  }
  cleanup();
  out('the QR code expired or was cancelled — run login again');
  return { status: 'expired' };
}
