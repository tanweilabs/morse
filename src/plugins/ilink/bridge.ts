import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginMessage } from '../../plugin/contract.js';
import { watchEvents } from '../../plugin/cli-client.js';
import { isInside, type IlinkConfig } from './config.js';
import type { FetchImpl, IlinkClient, IlinkError } from './ilink.js';
import { buildPrompt, collectMedia, failureLine, readItems, shapeOf, sweepMedia, unknownLine, type MediaPart } from './inbound.js';
import type { Account } from './login.js';
import { ILINK_AGENT, ILINK_SESSION, type MorseSide } from './morse.js';
import { extractSendMarkers, sendFiles, type SendRules } from './outbound.js';
import { preview, type Log, type Store } from './store.js';

/**
 * morse-plugin-ilink, the conversion between the two networks (ADR-053). WeChat and Morse
 * are two post offices: a WeChat message from the bound user (the owner himself) becomes a
 * Morse message from the plugin's identity — `@ilink:ilink-wechat`, a registered, pull-only
 * session of the owner, so it is internal mail of contact `self` — to the configured target
 * agent; that agent's reply (same thread), and anything one of the owner's own agents sends
 * to the identity, goes back to WeChat. Other people's Morse mail never does: at most a
 * one-line notice (who, how many) with `notify_others`.
 *
 * Durability: inbound — the long-poll cursor and the accepted queue are one file written in
 * one go (nothing replayed, nothing dropped); outbound — the core keeps the message
 * (claim / ack / nack), and what this plugin holds mid-send is recorded so a restart
 * hands it back, finishes it, or (half sent) fails it without sending it twice.
 */

export const MAX_CHARS = 1_800;
const SEEN_LIMIT = 500;
const NOTICED_LIMIT = 1_000;
const THREAD_KEEP_MS = 7 * 86_400_000;
const NO_REPLY_GRACE_MS = 30_000;
/** How often an open thread's Morse message is looked at — a failure is told within seconds (ADR-057). */
const STATUS_CHECK_MS = 3_000;
const INBOX_RETRY_MS = 30_000;
const INBOX_TRIES = 3;

export const TEXT = {
  timeout: '处理超时了，请稍后再试。',
  failed: '处理出错了，请稍后再试。',
  /** (ADR-089) every turn for it was cut off (restarts, crashes) and the core gave up — it may be done in part, or completely with only the confirmation lost */
  gaveUp: '这条消息处理了几次都在中途被打断（程序重启），没能确认结果，已经不再重试。它可能已经处理完了、只是没能确认，也可能只做了一部分；重发之前请先看一下。',
  interrupted: '上一条消息处理到一半时程序中断了，请重发一遍。',
  empty: '（没有文字回复）',
  noTarget: '还没有设置回答微信消息的 agent（plugins.ilink.target），这条消息没有转出去。',
  targetGone: '回答微信消息的那个 agent 会话不在了，消息放进了它的 Morse 信箱；请检查 plugins.ilink.target。',
  notForwarded: '这条消息没能转给 agent，请稍后再试。',
  waiting: '这条消息还在排队，没有开始处理（回答的 agent 没在运行，或它的会话正开着），开始处理后会回复你。',
};

/** Split text into chunks of at most `max` characters, preferring line breaks. */
export function splitText(text: string, max = MAX_CHARS): string[] {
  const chunks: string[] = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) {
      cut = max;
      const last = rest.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // keep surrogate pairs whole
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function isAllowedSender(from: unknown, allowedSender: string): boolean {
  return typeof from === 'string' && from !== '' && from === allowedSender;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export interface QueueItem {
  id: string;
  from: string;
  text: string | null;
  contextToken: string | null;
  media?: MediaPart[];
  unknown?: string[];
}

/** Reduce a raw iLink message to the fields used here. */
export function readMessage(raw: Record<string, unknown>) {
  return {
    id: raw?.['message_id'] != null ? String(raw['message_id']) : str(raw?.['client_id']),
    from: str(raw?.['from_user_id']),
    fromBot: raw?.['message_type'] === 2,
    ...readItems(raw),
    contextToken: str(raw?.['context_token']),
    order: Number(raw?.['seq'] ?? raw?.['create_time_ms']),
  };
}

/** Durable inbound queue: cursor + accepted messages in ONE file, saved in ONE write. */
export class Inbox {
  #store: Store;
  #file: string;
  #state: { cursor: string; pending: QueueItem[]; active: string | null; seen: string[] };

  constructor(store: Store, file = 'inbox.json') {
    this.#store = store;
    this.#file = file;
    const saved = store.readJson<Partial<Inbox['state']> | null>(file, null) ?? {};
    this.#state = {
      cursor: typeof saved.cursor === 'string' ? saved.cursor : '',
      pending: Array.isArray(saved.pending) ? saved.pending : [],
      active: saved.active ?? null,
      seen: Array.isArray(saved.seen) ? saved.seen : [],
    };
  }

  get state() {
    return this.#state;
  }
  #save() {
    this.#store.writeJson(this.#file, this.#state);
  }
  get cursor() {
    return this.#state.cursor;
  }
  get size() {
    return this.#state.pending.length;
  }

  /** Queue messages from the allowed sender, ignore everything else, advance the cursor. */
  accept(rawMessages: Array<Record<string, unknown>>, nextCursor: string, o: { allowedSender: string; log?: Log }): number {
    const log = o.log ?? (() => undefined);
    const messages = rawMessages.map((raw) => ({ ...readMessage(raw), raw }));
    if (messages.every((m) => Number.isFinite(m.order))) messages.sort((a, b) => a.order - b.order);
    let queued = 0;
    for (const message of messages) {
      if (message.fromBot || !message.id || this.#state.seen.includes(message.id)) continue;
      this.#state.seen.push(message.id);
      if (!isAllowedSender(message.from, o.allowedSender)) {
        log('ignored-sender', { id: message.id });
        continue;
      }
      const { id, text, contextToken, media, unknown } = message;
      this.#state.pending.push({ id, from: message.from!, text, contextToken, ...(media.length ? { media } : {}), ...(unknown.length ? { unknown } : {}) });
      queued += 1;
      const kind = media.length ? 'media' : text === null ? 'unsupported' : 'text';
      log('queued', { id, kind, ...(media.length ? { items: media.map((m) => m.kind).join(',') } : {}), ...(text === null ? {} : preview(text)) });
      if (media.length || unknown.length) {
        const list = (message.raw?.['item_list'] ?? []) as Array<{ type?: unknown }>;
        log('media-structure', { id, types: list.map((entry) => entry?.type ?? null), shape: shapeOf(message.raw) });
      }
    }
    this.#state.seen = this.#state.seen.slice(-SEEN_LIMIT);
    if (typeof nextCursor === 'string' && nextCursor) this.#state.cursor = nextCursor;
    this.#save();
    return queued;
  }

  begin(): QueueItem | null {
    const item = this.#state.pending[0] ?? null;
    if (item) {
      this.#state.active = item.id;
      this.#save();
    }
    return item;
  }

  finish() {
    this.#state.pending.shift();
    this.#state.active = null;
    this.#save();
  }

  /** After a crash: the message that was mid-flight is removed (never run twice) and returned. */
  takeInterrupted(): QueueItem | null {
    if (!this.#state.active) return null;
    const item = this.#state.pending[0]?.id === this.#state.active ? this.#state.pending.shift()! : null;
    this.#state.active = null;
    this.#save();
    return item;
  }
}

interface Thread {
  contextToken: string | null;
  morseId: string;
  wxId: string;
  at: number;
  open: boolean;
  checkedAt?: number;
  deliveredAt?: number;
  /** The "still queued" notice went out (once). */
  waitNoticed?: boolean;
}
interface Holding {
  claimed: boolean;
  sent: number;
  total: number;
}
interface PluginState {
  threads: Record<string, Thread>;
  lastContextToken: string | null;
  holding: Record<string, Holding>;
  inboxTries: Record<string, { n: number; at: number }>;
  noticed: string[];
}

export interface Wx {
  sendText(to: string, text: string, contextToken: string | null): Promise<void>;
  sendFile?(to: string, file: { name: string; bytes: Buffer; image: boolean }, contextToken: string | null): Promise<void>;
  startTyping?(to: string, contextToken: string | null): Promise<() => Promise<void>>;
}

/** Ours to forward: same-machine mail, or mail from your own devices. Never another person's. */
export function isOwnMail(m: PluginMessage): boolean {
  if (m.foreign) return false;
  if (m.direction === 'internal') return true;
  return m.direction === 'in' && m.contact?.self === true && (m.contact as { group?: string }).group === 'self';
}

const forUs = (m: PluginMessage) => m.to.agent === ILINK_AGENT && (m.to.sessionId === ILINK_SESSION || m.to.sessionId === 'inbox');

export interface Bridge {
  onUpdates(msgs: Array<Record<string, unknown>>, cursor: string): void;
  recover(): Promise<void>;
  sweep(): Promise<void>;
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export function createBridge(o: {
  store: Store;
  inbox: Inbox;
  morse: MorseSide;
  wx: Wx;
  account: Pick<Account, 'allowedSender'>;
  config: IlinkConfig;
  log: Log;
  signal?: AbortSignal;
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Bridge {
  const { store, inbox, morse, wx, config, log } = o;
  const owner = o.account.allowedSender;
  const now = o.now ?? Date.now;
  const loaded = store.readJson<Partial<PluginState>>('morse.json', {});
  const state: PluginState = {
    threads: loaded.threads ?? {},
    lastContextToken: loaded.lastContextToken ?? null,
    holding: loaded.holding ?? {},
    inboxTries: loaded.inboxTries ?? {},
    noticed: loaded.noticed ?? [],
  };
  const save = () => store.writeJson('morse.json', state);
  const typing = new Map<string, { stop: () => Promise<void>; timer: NodeJS.Timeout }>();
  const rules: SendRules = { root: config.sendRoot, stateDir: config.stateDir, mediaDir: config.mediaDir, morseDir: config.morseDir, maxBytes: config.maxMediaBytes };

  const say = async (text: string, contextToken: string | null, what: Record<string, unknown> = {}) => {
    for (const chunk of splitText(text)) await wx.sendText(owner, chunk, contextToken);
    log('wx-sent', { ...what, ...preview(text) });
  };
  // a short line to the owner; a failure to send it is logged, never thrown
  const notify = (line: string, contextToken: string | null) =>
    say(line, contextToken, { kind: 'notice' }).catch((e: IlinkError) => log('notice-error', { code: e?.code, message: String(e?.message ?? e).slice(0, 200) }));

  const stopTyping = async (contextId: string) => {
    const t = typing.get(contextId);
    if (!t) return;
    typing.delete(contextId);
    clearTimeout(t.timer);
    await t.stop().catch(() => undefined);
  };

  // ---- WeChat → Morse ----------------------------------------------------------------
  async function handleInbound(item: QueueItem) {
    // defence in depth: nothing from anyone but the bound user goes anywhere
    if (!isAllowedSender(item.from, owner)) return log('dropped-sender', { id: item.id });
    if (item.contextToken) {
      state.lastContextToken = item.contextToken;
      save();
    }
    const hasMedia = Boolean(item.media?.length);
    if (item.unknown?.length || (item.text === null && !hasMedia)) await notify(unknownLine(item.unknown ?? []), item.contextToken);
    if (item.text === null && !hasMedia) return;
    if (!config.target) {
      log('no-target', { id: item.id });
      return notify(TEXT.noTarget, item.contextToken);
    }
    const { saved, failed } = hasMedia
      ? await collectMedia(item as { id: string; media: MediaPart[] }, { dir: config.mediaDir, fetchImpl: o.fetchImpl, maxBytes: config.maxMediaBytes, timeoutMs: config.mediaTimeoutMs, signal: o.signal, log })
      : { saved: [], failed: [] };
    if (failed.length) await notify(failureLine(failed), item.contextToken);
    if (item.text === null && !saved.length) return;
    // one WeChat message = one Morse message, however many items it carried
    const text = buildPrompt({ text: item.text, saved, failed });
    let sent;
    try {
      sent = await morse.send(config.target, text);
    } catch (e) {
      log('morse-send-error', { id: item.id, message: String((e as Error).message).slice(0, 300) });
      return notify(TEXT.notForwarded, item.contextToken);
    }
    state.threads[sent.contextId] = { contextToken: item.contextToken, morseId: sent.id, wxId: item.id, at: now(), open: true };
    save();
    log('to-morse', { id: item.id, morse: sent.id.slice(0, 8), ...preview(text), ...(saved.length ? { files: saved.length } : {}) });
    const stop = await wx.startTyping?.(owner, item.contextToken);
    if (stop) {
      const timer = setTimeout(() => void stopTyping(sent.contextId), config.replyTimeoutMs);
      timer.unref?.();
      typing.set(sent.contextId, { stop, timer });
    }
  }

  let draining: Promise<void> | null = null;
  async function drain() {
    for (let item: QueueItem | null; !o.signal?.aborted && (item = inbox.begin()); ) {
      try {
        await handleInbound(item);
      } catch (error) {
        log('inbound-error', { id: item.id, code: (error as IlinkError)?.code, message: String((error as Error)?.message ?? error).slice(0, 300) });
      }
      inbox.finish();
    }
  }
  function kick() {
    draining ??= drain().finally(() => {
      draining = null;
      if (inbox.size && !o.signal?.aborted) void kick();
    });
    return draining;
  }

  // ---- Morse → WeChat ----------------------------------------------------------------
  const senderLabel = (m: PluginMessage) => `@${m.from.device ? `${m.from.device}/` : ''}${m.from.agent}`;

  async function deliverOut(input: PluginMessage) {
    let m = input;
    const claimed = m.to.sessionId === ILINK_SESSION;
    if (claimed) {
      const held = await morse.claim(m.id);
      if (!held) return; // not due (backoff), or someone else has it
      m = held;
    } else {
      const tries = state.inboxTries[m.id];
      if (tries && (tries.n >= INBOX_TRIES || now() - tries.at < INBOX_RETRY_MS)) return;
    }
    state.holding[m.id] = { claimed, sent: 0, total: 0 };
    save();
    const thread = state.threads[m.contextId];
    const contextToken = thread?.contextToken ?? state.lastContextToken;
    if (thread) {
      thread.open = false;
      await stopTyping(m.contextId);
    }
    const parsed = extractSendMarkers(m.text);
    // the answer in a WeChat thread goes as is; anything else says which agent of yours wrote it —
    // except what you sent yourself from the command line with no `--from` (`user`): there is no
    // agent to name, and "[@user]" in WeChat is an internal label that means nothing to a person
    let body = parsed.text;
    const unnamed = m.from.agent === 'user' && !m.from.device;
    if (!thread && body && !unnamed) body = `[${senderLabel(m)}] ${body}`;
    const chunks = splitText(body);
    const attachments = m.files.map((f) => f.path).filter(Boolean);
    if (!chunks.length && !parsed.paths.length && !attachments.length) chunks.push(TEXT.empty);
    const hold = state.holding[m.id]!;
    hold.total = chunks.length;
    save();
    try {
      for (const chunk of chunks) {
        await wx.sendText(owner, chunk, contextToken);
        hold.sent += 1;
        save();
      }
    } catch (error) {
      const e = error as IlinkError;
      const why = `WeChat send failed (${e?.code ?? 'error'}${e?.providerCode ? ` ${e.providerCode}` : ''})${hold.sent ? ` after ${hold.sent} of ${hold.total} parts` : ''} — the WeChat user may be outside the reply window (message the bot first)`;
      log('wx-send-error', { morse: m.id.slice(0, 8), code: e?.code, providerCode: e?.providerCode, sent: hold.sent, total: hold.total });
      delete state.holding[m.id];
      if (!claimed) {
        const t = state.inboxTries[m.id] ?? { n: 0, at: 0 };
        state.inboxTries[m.id] = { n: hold.sent ? INBOX_TRIES : t.n + 1, at: now() };
      }
      save();
      // reported back into Morse: retried later (nothing went out yet), or failed for good (half sent — never twice)
      if (claimed) await morse.nack(m.id, why, hold.sent > 0).catch((x: Error) => log('nack-error', { message: x.message.slice(0, 200) }));
      return;
    }
    if (parsed.paths.length || attachments.length) {
      await sendFiles([...attachments, ...parsed.paths], {
        to: owner,
        allowedSender: owner,
        contextToken,
        wx: { sendFile: (to, f, ctx) => (wx.sendFile ? wx.sendFile(to, f, ctx) : Promise.reject(new Error('file sending is off'))) },
        rules: { ...rules, allow: new Set(attachments) },
        notify: (line) => notify(line, contextToken),
        log,
      });
    }
    try {
      if (claimed) await morse.ack(m.id);
      else await morse.done(m.id);
      delete state.holding[m.id];
      delete state.inboxTries[m.id];
      save();
      log('to-wechat', { morse: m.id.slice(0, 8), from: senderLabel(m), parts: chunks.length, files: parsed.paths.length + attachments.length, reply: Boolean(thread) });
    } catch (e) {
      log('ack-error', { morse: m.id.slice(0, 8), message: String((e as Error).message).slice(0, 200) }); // recorded in holding: finished on restart
    }
  }

  async function noticeOthers(foreign: PluginMessage[], unread: Awaited<ReturnType<MorseSide['todo']>>['unread']) {
    const fresh = foreign.filter((m) => !state.noticed.includes(m.id));
    if (!fresh.length) return;
    const byContact = new Map<string, PluginMessage[]>();
    for (const m of fresh) {
      const k = m.contact?.id ?? '?';
      byContact.set(k, [...(byContact.get(k) ?? []), m]);
    }
    for (const [contactId, list] of byContact) {
      const u = unread.find((x) => x.contact === contactId);
      const c = list[0]!.contact as { remark?: string | null; handle?: string | null } | null;
      const who = u?.remark ?? c?.remark ?? u?.handle ?? c?.handle ?? contactId;
      const count = Math.max(u?.count ?? 0, list.length);
      // who and how many — never what
      await notify(`Morse：${who} 给你发来 ${count} 条消息（内容只在 Morse 里，用 morse read 查看）。`, state.lastContextToken);
      state.noticed.push(...list.map((m) => m.id));
    }
    state.noticed = state.noticed.slice(-NOTICED_LIMIT);
    save();
  }

  // the agent's answer is a separate message: if the one we sent died, or was handled without an answer, say so.
  // Each outcome is told exactly once: the thread is closed and saved BEFORE the line goes out (ADR-057).
  async function checkThreads() {
    const close = async (contextId: string, t: Thread, line: string) => {
      t.open = false;
      save();
      await stopTyping(contextId);
      await notify(line, t.contextToken);
    };
    for (const [contextId, t] of Object.entries(state.threads)) {
      if (now() - t.at > THREAD_KEEP_MS) {
        delete state.threads[contextId];
        continue;
      }
      if (!t.open || now() - (t.checkedAt ?? t.at) < STATUS_CHECK_MS) continue;
      t.checkedAt = now();
      const m = await morse.read(t.morseId);
      if (!m || !t.open) continue; // closed meanwhile: its answer was forwarded
      if (m.to.sessionId === 'inbox') {
        // the target session is gone: the dispatch plugin moved the message to that agent's mailbox
        log('target-gone', { morse: t.morseId.slice(0, 8) });
        await close(contextId, t, TEXT.targetGone);
      } else if (m.status === 'dead') {
        log('agent-failed', { morse: t.morseId.slice(0, 8), error: String(m.lastError ?? '').slice(0, 200) });
        const why = String(m.lastError ?? '');
        await close(contextId, t, /did not finish within/.test(why) ? TEXT.timeout : /deliveries in a row were interrupted/.test(why) ? TEXT.gaveUp : TEXT.failed);
      } else if (m.status === 'delivered') {
        t.deliveredAt ??= now();
        if (now() - t.deliveredAt >= NO_REPLY_GRACE_MS) await close(contextId, t, TEXT.empty);
      } else if (m.status === 'pending' && !t.waitNoticed && now() - t.at >= config.replyTimeoutMs) {
        // never started (dispatch not running, or the session is live and the profile waits): say so once, keep waiting
        t.waitNoticed = true;
        save();
        log('agent-waiting', { morse: t.morseId.slice(0, 8) });
        await notify(TEXT.waiting, t.contextToken);
      }
    }
    save();
  }

  let sweeping: Promise<void> | null = null;
  let sweepAgain = false;
  async function sweepOnce() {
    const { messages, unread } = await morse.todo();
    const mine = messages.filter(forUs);
    const foreign: PluginMessage[] = [];
    for (const m of mine) {
      if (o.signal?.aborted) return;
      if (!isOwnMail(m)) {
        foreign.push(m); // another person's: never forwarded, never marked processed
        continue;
      }
      if (m.status === 'dead' || m.status === 'delivering') continue;
      await deliverOut(m);
    }
    if (config.notifyOthers && foreign.length) await noticeOthers(foreign, unread);
    await checkThreads();
  }

  return {
    onUpdates(msgs, cursor) {
      inbox.accept(msgs, cursor, { allowedSender: owner, log });
      if (inbox.size) void kick();
    },
    async recover() {
      const lost = inbox.takeInterrupted();
      if (lost) {
        log('interrupted', { id: lost.id });
        await notify(TEXT.interrupted, lost.contextToken);
      }
      // what an earlier run held mid-send: finished, handed back, or (half sent) failed — never sent twice
      for (const [id, h] of Object.entries(state.holding)) {
        try {
          if (h.total > 0 && h.sent >= h.total) await (h.claimed ? morse.ack(id) : morse.done(id));
          else if (h.sent === 0) {
            if (h.claimed) await morse.release(id);
          } else if (h.claimed) await morse.nack(id, `interrupted after ${h.sent} of ${h.total} parts were sent to WeChat`, true);
          else await morse.done(id);
          log('recovered', { morse: id.slice(0, 8), sent: h.sent, total: h.total });
        } catch (e) {
          log('recover-error', { morse: id.slice(0, 8), message: String((e as Error).message).slice(0, 200) });
        }
        delete state.holding[id];
      }
      save();
      if (inbox.size) void kick();
    },
    sweep() {
      if (sweeping) {
        sweepAgain = true;
        return sweeping;
      }
      sweeping = (async () => {
        do {
          sweepAgain = false;
          try {
            await sweepOnce();
          } catch (e) {
            log('sweep-error', { message: String((e as Error).message).slice(0, 300) });
          }
        } while (sweepAgain && !o.signal?.aborted);
      })().finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
    async idle() {
      while (draining || sweeping) await (draining ?? sweeping);
    },
    async stop() {
      for (const id of [...typing.keys()]) await stopTyping(id);
    },
  };
}

/**
 * ADR-057: the default media folder sits inside the agent's working directory (often a git
 * repository): created 0700 with a `.gitignore` of `*`, so received files are never committed.
 */
export function ensureMediaDir(config: Pick<IlinkConfig, 'mediaDir' | 'mediaDefaulted' | 'agentCwd'>, log: Log = () => undefined): void {
  try {
    mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });
    const ignore = join(config.mediaDir, '.gitignore');
    if (config.mediaDefaulted && config.agentCwd && isInside(config.mediaDir, config.agentCwd) && !existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 });
  } catch (e) {
    log('media-dir-error', { message: String((e as Error).message).slice(0, 200) });
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface RunOptions {
  ilink: IlinkClient;
  store: Store;
  morse: MorseSide;
  account: Account;
  config: IlinkConfig;
  signal: AbortSignal;
  log: Log;
  fetchImpl?: FetchImpl;
  sweepIntervalMs?: number;
  /** Follow `morse plugin watch --json` for prompt forwarding (tests may rely on the interval only). */
  watch?: boolean;
}

/**
 * The receive loop. Returns 0 after a normal stop, 2 when the binding is no longer valid
 * (stale token) — then nothing is polled or claimed until the owner binds again.
 */
export async function runPlugin(o: RunOptions): Promise<number> {
  const creds = { baseUrl: o.account.baseUrl, token: o.account.token };
  const { log, store } = o;
  const status = (s: Record<string, unknown>) => store.writeJson('status.json', { ...store.readJson<Record<string, unknown>>('status.json', {}), ...s, at: new Date().toISOString(), pid: process.pid });
  const inbox = new Inbox(store);
  const bridge = createBridge({
    store,
    inbox,
    morse: o.morse,
    account: o.account,
    config: o.config,
    log,
    signal: o.signal,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    wx: {
      sendText: (to, text, contextToken) => o.ilink.sendText({ ...creds, to, text, contextToken }),
      sendFile: (to, file, contextToken) => o.ilink.sendFile({ ...creds, to, ...file, contextToken }),
      startTyping: (to, contextToken) => o.ilink.startTyping({ ...creds, to, contextToken, onError: (e) => log('typing-error', { code: e?.code }) }),
    },
  });
  let exitCode = 0;
  let watcher: ReturnType<typeof watchEvents> | null = null;
  const timers: NodeJS.Timeout[] = [];
  const stale = (where: string) => {
    exitCode = 2;
    status({ state: 'stale-token', lastError: `the WeChat binding is no longer valid (${where}) — bind again: morse plugin ilink login --force` });
    log('stale-token', { where });
  };
  try {
    status({ state: 'starting', lastError: null });
    await o.morse.register();
    try {
      await o.ilink.notifyStart(creds);
    } catch (e) {
      if ((e as IlinkError).code === 'stale-token') {
        stale('notifystart');
        return 2;
      }
      log('start-error', { code: (e as IlinkError).code, message: String((e as Error).message).slice(0, 200) });
    }
    log('started', { target: o.config.target, notifyOthers: o.config.notifyOthers, pid: process.pid });
    ensureMediaDir(o.config, log);
    try {
      const removed = sweepMedia(o.config.mediaDir, o.config.mediaKeepDays);
      if (removed) log('media-swept', { removed, keepDays: o.config.mediaKeepDays });
    } catch (e) {
      log('media-sweep-error', { message: String((e as Error).message).slice(0, 200) });
    }
    await bridge.recover();
    if (o.watch !== false) {
      watcher = watchEvents((e) => {
        if (e.type === 'message' && e.to.agent === ILINK_AGENT) void bridge.sweep();
      }, { cmd: o.morse.cmd, ...(o.morse.env ? { env: o.morse.env } : {}) });
    }
    timers.push(setInterval(() => void bridge.sweep(), o.sweepIntervalMs ?? 5_000));
    // a registration is kept for 7 days from the last refresh
    timers.push(setInterval(() => void o.morse.register().catch(() => undefined), 6 * 3_600_000));
    void bridge.sweep();
    status({ state: 'running', lastError: null });
    for (let failures = 0; !o.signal.aborted; ) {
      try {
        const { msgs, cursor } = await o.ilink.getUpdates({ ...creds, cursor: inbox.cursor, signal: o.signal });
        failures = 0;
        status({ lastPollAt: new Date().toISOString() });
        bridge.onUpdates(msgs, cursor);
      } catch (error) {
        if (o.signal.aborted) break;
        const e = error as IlinkError;
        if (e.code === 'stale-token') {
          stale('getupdates');
          break;
        }
        failures += 1;
        log('poll-error', { code: e.code, message: e.message, failures });
        status({ lastError: `poll: ${e.code}` });
        await sleep(Math.min(2_000 * 2 ** (failures - 1), 30_000), o.signal);
      }
    }
  } catch (e) {
    exitCode = exitCode || 1;
    log('fatal', { message: String((e as Error).message).slice(0, 300) });
    status({ state: 'error', lastError: String((e as Error).message).slice(0, 300) });
  } finally {
    for (const t of timers) clearInterval(t);
    watcher?.kill();
    await bridge.idle();
    await bridge.stop();
    if (exitCode !== 2) await o.ilink.notifyStop(creds).catch((e: IlinkError) => log('stop-error', { code: e.code }));
    if (exitCode === 0) status({ state: 'stopped' });
    log('stopped', { exitCode });
  }
  return exitCode;
}
