import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ExecFn } from '../../adapters/types.js';
import { classifyReply } from '../../envelope.js';
import type { PluginMessage } from '../../plugin/contract.js';
import { APPROVAL_MAX_AGE_MS, type ApprovalRequest, type ApprovalStore, newApprovalId, type RunFile } from './approvals.js';
import { type AttendantProfile, type AttendantSettings, isInside, profileFor } from './config.js';
import type { AttendantCore } from './core.js';
import { approvedPrompt, isAttendantText, looksLikeToolCall, splitAskOwner, systemPrompt, userPrompt, type Who, whoOf, whoOfContact, withFooter } from './envelope.js';
import { hookCommandFor, runTurn, type TurnResult } from './runner.js';
import { type AttendantState, type AttendantStateData, contextKey, launchCounts, type MessageMark } from './state.js';

/**
 * The attendant's loop (ADR-059): a contact who is not you writes to one of your agents;
 * if the contact's group (or the contact) has a profile, your agent answers them — in a
 * session of its own per (agent, contact), inside the profile's directory and tools, and
 * anything destructive or outward-facing stops for your approval (ADR-060). Any other
 * accepted contact gets the built-in conversation-only default (ADR-066): no tools, an
 * empty directory of its own; the agent replies or answers NOOP, and an `ASK_OWNER:` line
 * becomes a notice to you. Strangers (requests), blocked contacts, switched-off groups and
 * your own mail are never touched.
 *
 * Guards: coalescing (a burst from one contact is one turn), one turn per lane, a global
 * concurrency cap, rate limits per contact and turns per thread (only if the owner sets
 * them, ADR-068 / ADR-072 — another attendant's automatic reply goes to the agent, which
 * decides, unless answerAttendants is false), at most 3 tries, restart recovery (a turn that
 * was running is retried, marked as a possible retry), missing-session recovery, and
 * attachment path checks.
 */

export interface EngineDeps {
  core: AttendantCore;
  exec: ExecFn;
  state: AttendantState;
  approvals: ApprovalStore;
  settings: () => AttendantSettings;
  /** Tell the owner on WeChat too (the ilink plugin is on). */
  ilinkEnabled?: () => boolean;
  /** How to run this plugin (the hook command is built from it). */
  pluginArgv: string[];
  stateDir: string;
  home: string;
  /** Where the core keeps received files (~/.morse/inbox-files). */
  inboxFilesDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
  /** An OS notification for the owner (best effort). */
  osNotify?: (title: string, body: string) => void;
  maxAttachmentBytes?: number;
}

export interface Engine {
  /** Look for work now (a new message arrived). */
  kick(): void;
  /** One pass: approvals first, then new mail. */
  tick(): Promise<void>;
  /** Resolves when nothing runs and nothing is due right now (tests). */
  idle(): Promise<void>;
  /** At start: turns that were running when the plugin stopped are retried. */
  recover(): number;
  running(): string[];
}

const MAX_TRIES = 3;
const RETRY_MS = [30_000, 120_000];

export const laneOf = (m: Pick<PluginMessage, 'agent' | 'to' | 'contact'>): string => `${m.agent ?? m.to.agent}/${m.contact?.id ?? '?'}`;

/**
 * A message a profile may answer (in from another person, not processed, not yours) — never
 * their reply in a thread you started (ADR-071): that is the answer your session asked for.
 */
function candidate(m: PluginMessage): boolean {
  const c = m.contact as { id?: string; self?: boolean } | null;
  return m.direction === 'in' && !m.processed && m.ownThread !== true && Boolean(c?.id) && c?.id !== 'self' && c?.self !== true && m.status !== 'dead';
}

const contactOf = (m: PluginMessage): ApprovalRequest['contact'] => {
  const c = (m.contact ?? {}) as { id?: string; handle?: string | null; remark?: string | null; group?: string };
  return { id: c.id ?? '?', handle: c.handle ?? null, remark: c.remark ?? null, group: c.group ?? 'other' };
};

/**
 * Copies of a message's files the agent can read: `<cwd>/.morse-attachments/<id>/<name>`.
 * Only regular files inside the core's received-files directory are copied (no symlinks,
 * nothing else on the disk), up to `maxBytes` each.
 */
export function stageAttachments(m: Pick<PluginMessage, 'id' | 'files'>, cwd: string, inboxFilesDir: string, maxBytes: number): string[] {
  if (!m.files.length) return [];
  let root: string;
  try {
    root = realpathSync(inboxFilesDir);
  } catch {
    return m.files.map((f) => `${f.name}: not available (no received-files directory)`);
  }
  const out: string[] = [];
  const base = join(cwd, '.morse-attachments');
  for (const f of m.files) {
    try {
      const st = lstatSync(f.path);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('not a regular file');
      if (!isInside(realpathSync(f.path), root)) throw new Error('not a received file');
      if (st.size > maxBytes) throw new Error(`larger than ${maxBytes} bytes`);
      const dir = join(base, m.id.slice(0, 12));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(join(base, '.gitignore'))) writeFileSync(join(base, '.gitignore'), '*\n');
      const name = basename(f.name).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '_') || 'file';
      const dest = join(dir, name);
      copyFileSync(f.path, dest);
      out.push(relative(cwd, dest));
    } catch (e) {
      out.push(`${basename(f.name)}: not available (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return out;
}

export function createEngine(deps: EngineDeps): Engine {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const newId = deps.newId ?? randomUUID;
  const running = new Map<string, Promise<void>>();
  const busyMessages = new Set<string>();
  let scanning: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;
  const loggedOnce = new Set<string>();
  const once = (key: string, line: string) => {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(line);
  };

  const mark = (ids: string[], m: Omit<MessageMark, 'at'> & { at?: number }) =>
    deps.state.update((s) => {
      for (const id of ids) s.messages[id] = { ...m, at: m.at ?? now() };
    });
  const clear = (ids: string[]) =>
    deps.state.update((s) => {
      for (const id of ids) delete s.messages[id];
    });

  const notifyOwner = async (title: string, body: string, wechat: boolean) => {
    deps.osNotify?.(title, body);
    if (wechat && deps.ilinkEnabled?.() && deps.settings().notifyWechat) {
      const ok = await deps.core.notifyOwner(`${title}: ${body}`).catch(() => false);
      if (!ok) log('could not tell the owner on WeChat (ilink)');
    }
  };

  /** Send the agent's answer (or a notice) to the contact; the other batch messages are done too. */
  const answer = async (msgs: PluginMessage[], replyTo: string, text: string): Promise<boolean> => {
    const r = await deps.core.reply(replyTo, text);
    if (!r.ok) {
      log(`reply to ${replyTo.slice(0, 8)} not sent: ${r.error}`);
      return false;
    }
    await deps.core.done(msgs.map((m) => m.id).filter((id) => id !== replyTo));
    return true;
  };

  /** Approval requests a turn filed (hook) or asked for (Codex NEEDS_APPROVAL). */
  const filedApprovals = (run: RunFile, result: TurnResult): ApprovalRequest[] => {
    const filed = deps.approvals.list().filter((a) => a.runId === run.runId && a.status === 'pending');
    for (const action of result.needsApproval ?? []) {
      const a: ApprovalRequest = { id: newApprovalId(), status: 'pending', createdAt: now(), runId: run.runId, lane: run.lane, agent: run.agent, contact: run.contact, messageIds: run.messageIds, replyTo: run.replyTo, tool: 'codex', key: action.slice(0, 500), input: action.slice(0, 2000), pattern: 'NEEDS_APPROVAL' };
      deps.approvals.put(a);
      filed.push(a);
    }
    return filed;
  };

  interface TurnPlan {
    lane: string;
    profile: AttendantProfile;
    who: Who;
    contact: ApprovalRequest['contact'];
    agent: string;
    msgs: PluginMessage[];
    replyTo: string;
    prompt: (newSession: boolean) => Promise<string>;
    grant?: RunFile['grant'];
  }

  /** Run one turn in the lane's session (creating it, or again once if it is gone). */
  const runInSession = async (p: TurnPlan): Promise<{ run: RunFile; result: TurnResult }> => {
    const runId = newId();
    const run: RunFile = { runId, lane: p.lane, agent: p.agent, contact: p.contact, messageIds: p.msgs.map((m) => m.id), replyTo: p.replyTo, cwd: p.profile.cwd, approvals: p.profile.approvals, denyPaths: p.profile.denyPaths, ...(p.grant ? { grant: p.grant } : {}) };
    deps.approvals.writeRun(run);
    try {
      // the default profile's own empty directory (ADR-066) — never the owner's files
      if (p.profile.conversationOnly) mkdirSync(p.profile.cwd, { recursive: true, mode: 0o700 });
      let sess = deps.state.read().sessions[p.lane];
      if (sess && (sess.cwd !== p.profile.cwd || sess.runtime !== p.profile.agent)) {
        log(`${p.lane}: the profile's directory or agent changed — a new session`);
        sess = undefined;
      }
      const attempt = async (sessionId: string | null) => {
        const created = newId();
        const prompt = await p.prompt(!sessionId);
        return runTurn(deps.exec, {
          profile: p.profile,
          sessionId,
          newId: created,
          prompt,
          systemPrompt: systemPrompt(p.profile),
          hookCommand: hookCommand(runId),
          runId,
          runDir: join(deps.stateDir, 'runs'),
          env: { ...(deps.env ?? process.env), MORSE_ATTENDANT_RUN: runId },
        });
      };
      let result = await attempt(sess?.sessionId ?? null);
      if (!result.ok && result.missingSession) {
        log(`${p.lane}: session ${sess?.sessionId.slice(0, 8)} is gone — starting a new one`);
        result = await attempt(null);
      }
      if (result.sessionId) {
        const sid = result.sessionId;
        deps.state.update((s) => {
          const prev = s.sessions[p.lane];
          const same = prev && prev.sessionId === sid;
          s.sessions[p.lane] = { runtime: p.profile.agent, sessionId: sid, cwd: p.profile.cwd, createdAt: same ? prev.createdAt : now(), turns: (same ? prev.turns : 0) + 1, lastTurnAt: now(), ...(result.ok ? {} : { fresh: true }) };
        });
      }
      return { run, result };
    } finally {
      deps.approvals.removeRun(runId);
    }
  };

  const hookCommand = (runId: string) => hookCommandFor(deps.pluginArgv, runId, deps.stateDir);

  /** ADR-066: the agent asked for the owner — a line in `morse plugin attendant status`, a desktop notice, WeChat (ilink). */
  const askOwner = async (p: TurnPlan, asks: string[]) => {
    const recorded = asks.map((request) => ({ id: newApprovalId(), at: now(), lane: p.lane, contact: p.contact, request: request.slice(0, 500), replyTo: p.replyTo }));
    deps.state.update((s) => {
      s.asks.push(...recorded);
    });
    for (const a of recorded) {
      log(`${p.lane}: your agent asks you (${a.id}): ${a.request}`);
      await notifyOwner(`Morse: ${p.who.name} (${p.who.group}) — your agent asks you`, `${a.request} — answer them yourself: morse reply ${a.replyTo.slice(0, 8)} "…"`, true);
    }
  };

  /** After a turn: waiting for approval / the answer / NOOP / failure. */
  const settle = async (p: TurnPlan, run: RunFile, result: TurnResult, approval?: ApprovalRequest) => {
    const ids = p.msgs.map((m) => m.id);
    const asked = filedApprovals(run, result);
    if (asked.length) {
      const sent = await answer(p.msgs, p.replyTo, withFooter(p.profile.notices.waiting, p.profile.notices.footer));
      clear(ids);
      const what = asked.map((a) => `${a.tool} ${a.key.slice(0, 80)}`).join('; ');
      log(`${p.lane}: waiting for your approval (${asked.map((a) => a.id).join(', ')}): ${what}${sent ? '' : ' — the waiting notice was not sent'}`);
      await notifyOwner(`Morse: ${p.who.name} (${p.who.group}) is waiting for your approval`, `${what} — morse plugin attendant approve ${asked[0]!.id}`, true);
      if (approval) deps.approvals.put({ ...approval, status: 'done', closedAt: now(), outcome: `asked again: ${asked.map((a) => a.id).join(', ')}` });
      return;
    }
    if (result.ok) {
      // ADR-066: ASK_OWNER lines go to the owner, never to the contact
      const split = splitAskOwner(result.text);
      let text = split.text.trim();
      if (p.profile.conversationOnly && looksLikeToolCall(text)) {
        mark(ids, { state: 'failed', attempts: MAX_TRIES, reason: 'the answer was a written-out tool call (this profile has no tools) — not sent' });
        log(`${p.lane}: the answer looked like a tool call (no tools in a conversation-only session) — not sent, left for you`);
        await notifyOwner(`Morse: your agent did not answer ${p.who.name}`, 'its answer looked like a tool call and was not sent — the message waits for you (morse read)', false);
        if (approval) deps.approvals.put({ ...approval, status: 'done', closedAt: now(), outcome: 'not sent (a tool call)' });
        return;
      }
      const incoming = p.msgs.map((m) => m.text).join('\n');
      if (split.asks.length && (!text || classifyReply(incoming, text) !== 'file')) text = p.profile.notices.askOwner;
      const verdict = text ? classifyReply(incoming, text) : 'noop';
      let outcome: string;
      if (verdict !== 'file') {
        await deps.core.done(ids);
        outcome = 'NOOP — nothing sent';
      } else {
        const sent = await answer(p.msgs, p.replyTo, withFooter(text, p.profile.notices.footer));
        if (!sent) {
          mark(ids, { state: 'failed', attempts: MAX_TRIES, reason: 'the reply could not be sent' });
          if (approval) deps.approvals.put({ ...approval, status: 'done', closedAt: now(), outcome: 'reply not sent' });
          return;
        }
        outcome = 'answered';
      }
      clear(ids);
      log(`${p.lane}: ${outcome} (${ids.length} message(s))`);
      if (split.asks.length) await askOwner(p, split.asks);
      if (approval) deps.approvals.put({ ...approval, status: 'done', closedAt: now(), outcome });
      return;
    }
    // failed
    const prev = deps.state.read().messages[ids[0]!];
    const attempts = (prev?.attempts ?? 1);
    if (approval) {
      deps.approvals.put({ ...approval, status: 'done', closedAt: now(), outcome: `failed: ${result.error ?? 'error'}` });
      log(`${p.lane}: the approved re-run failed: ${result.error}`);
      return;
    }
    if (result.terminal || attempts >= MAX_TRIES) {
      mark(ids, { state: 'failed', attempts, reason: result.error ?? 'failed' });
      log(`${p.lane}: gave up — left for you (morse read): ${result.error}`);
      await notifyOwner(`Morse: your agent could not answer ${p.who.name}`, `${(result.error ?? 'failed').slice(0, 160)} — the message waits for you (morse read)`, false);
      return;
    }
    mark(ids, { state: 'retry', attempts, reason: result.error ?? 'failed', notBefore: now() + RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)]! });
    log(`${p.lane}: failed (try ${attempts} of ${MAX_TRIES}), retrying later: ${result.error}`);
  };

  /** A new turn for a contact's unprocessed messages. */
  const runLane = async (lane: string, msgs: PluginMessage[], profile: AttendantProfile) => {
    const unlock = deps.state.lock(lane);
    if (!unlock) return;
    for (const m of msgs) busyMessages.add(m.id);
    try {
      const st = deps.state.read();
      const contact = contactOf(msgs[0]!);
      const who = whoOf(msgs[0]!);
      const agent = msgs[0]!.agent ?? msgs[0]!.to.agent;
      let batch = msgs;
      // ADR-072: another attendant's automatic reply goes to the agent like any other message
      // (it sees the marker and decides); only an owner who set answerAttendants: false keeps them
      if (!profile.answerAttendants) {
        const auto = batch.filter((m) => isAttendantText(m.text));
        if (auto.length) {
          mark(auto.map((m) => m.id), { state: 'deferred', attempts: 0, reason: 'an automatic reply from an attendant (answerAttendants: false)' });
          log(`${lane}: ${auto.length} automatic reply(ies) from an attendant — not answered (answerAttendants: false), left for you`);
          batch = batch.filter((m) => !auto.includes(m));
        }
      }
      // the owner's own cap on turns per thread a day, only if one is set (ADR-072: none by default)
      const t = now();
      const cap = profile.maxTurnsPerContext;
      // (ADR-083 review R5) counted per (this contact, thread): the same thread id used by the same person at another
      // address of yours — another contact — is another count
      const hot = cap === null ? [] : batch.filter((m) => (st.contextTurns[contextKey(contact.id, m.contextId)] ?? []).filter((x) => t - x < 86_400_000).length >= cap);
      if (hot.length) {
        mark(hot.map((m) => m.id), { state: 'deferred', attempts: 0, reason: `thread limit (${profile.maxTurnsPerContext} turns a day)` });
        log(`${lane}: thread limit reached — ${hot.length} message(s) left for you`);
        batch = batch.filter((m) => !hot.includes(m));
      }
      if (!batch.length) return;
      // the owner's own cap per contact, only if one is set (ADR-068: no limit by default)
      const counts = launchCounts(st, contact.id, t);
      const { perHour, perDay } = profile.rate;
      const overHour = perHour !== null && counts.hour >= perHour;
      const overDay = perDay !== null && counts.day >= perDay;
      if (overHour || overDay) {
        const why = overHour ? `${perHour} an hour` : `${perDay} a day`;
        mark(batch.map((m) => m.id), { state: 'deferred', attempts: 0, reason: `rate limit (${why})` });
        log(`${lane}: rate limit (${why}) — ${batch.length} message(s) left for you`);
        const last = st.notices[contact.id] ?? 0;
        if (t - last > 3_600_000) {
          deps.state.update((s) => {
            s.notices[contact.id] = t;
          });
          await notifyOwner(`Morse: ${who.name} hit the attendant's rate limit`, `${batch.length} message(s) wait for you (morse read)`, false);
        }
        return;
      }
      const retry = batch.some((m) => (st.messages[m.id]?.attempts ?? 0) > 0);
      const ids = batch.map((m) => m.id);
      deps.state.update((s) => {
        (s.launches[contact.id] ??= []).push(t);
        for (const c of new Set(batch.map((m) => m.contextId))) (s.contextTurns[contextKey(contact.id, c)] ??= []).push(t);
        for (const id of ids) s.messages[id] = { state: 'running', at: t, attempts: (s.messages[id]?.attempts ?? 0) + 1 };
      });
      const replyTo = batch[batch.length - 1]!.id;
      const max = deps.maxAttachmentBytes ?? 50 * 1024 * 1024;
      const plan: TurnPlan = {
        lane,
        profile,
        who,
        contact,
        agent,
        msgs: batch,
        replyTo,
        prompt: async (newSession) => {
          let history: PluginMessage[] = [];
          if (profile.historyMessages > 0) {
            const since = newSession ? 0 : (deps.state.read().sessions[lane]?.lastTurnAt ?? 0);
            history = (await deps.core.history(contact.id, profile.historyMessages + batch.length).catch(() => [])).filter((h) => !ids.includes(h.id) && h.at > since).slice(-profile.historyMessages);
          }
          const attachments: Record<string, string[]> = {};
          for (const m of batch) {
            if (!m.files.length) continue;
            // conversation only (ADR-066): no file access, so nothing is copied
            attachments[m.id] = profile.conversationOnly ? m.files.map((f) => `${basename(f.name)}: not available to you (no file access in this conversation)`) : stageAttachments(m, profile.cwd, deps.inboxFilesDir, max);
          }
          return userPrompt({ who, messages: batch, history, attachments, retry, newSession });
        },
      };
      log(`${lane}: running ${profile.agent} for ${batch.length} message(s) from ${who.name} (${who.group})${retry ? ' — a retry' : ''}`);
      const { run, result } = await runInSession(plan);
      await settle(plan, run, result);
    } catch (e) {
      log(`${lane}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const m of msgs) busyMessages.delete(m.id);
      unlock();
    }
  };

  /** The owner decided: an approved one re-runs with that one action allowed; a rejected one is answered. */
  const runApproval = async (a: ApprovalRequest) => {
    const unlock = deps.state.lock(a.lane);
    if (!unlock) return;
    try {
      const fresh = deps.approvals.get(a.id);
      if (!fresh || fresh.closedAt) return;
      const profile = profileFor(deps.settings(), { ...a.contact, self: false });
      const who: Who = whoOfContact(a.contact);
      if (fresh.status === 'rejected') {
        const footer = profile?.notices.footer ?? 'Automatic reply from my agent.';
        const r = await deps.core.reply(fresh.replyTo, withFooter(profile?.notices.rejected ?? 'Sorry, I did not approve that request.', footer));
        deps.approvals.put({ ...fresh, closedAt: now(), outcome: r.ok ? 'told them' : `not sent: ${r.error}` });
        log(`${a.lane}: approval ${a.id} rejected — ${r.ok ? 'told them' : `the notice was not sent: ${r.error}`}`);
        return;
      }
      if (!profile) {
        deps.approvals.put({ ...fresh, status: 'done', closedAt: now(), outcome: 'no profile for this contact any more' });
        log(`${a.lane}: approval ${a.id} approved, but the contact has no profile any more — nothing run`);
        return;
      }
      const msg = { id: fresh.replyTo, text: '', contextId: '', time: new Date(fresh.createdAt).toISOString(), at: fresh.createdAt } as PluginMessage;
      const plan: TurnPlan = {
        lane: a.lane,
        profile,
        who,
        contact: a.contact,
        agent: a.agent,
        msgs: [msg],
        replyTo: fresh.replyTo,
        prompt: async () => approvedPrompt(who, { tool: fresh.tool, key: fresh.key, id: fresh.id }),
        ...(profile.agent === 'claude' ? { grant: { approvalId: fresh.id, tool: fresh.tool, key: fresh.key } } : {}),
      };
      log(`${a.lane}: approval ${a.id} approved — running it`);
      deps.approvals.put({ ...fresh, closedAt: now() }); // taken: never twice, even if this crashes
      const { run, result } = await runInSession(plan);
      await settle(plan, run, result, { ...fresh, closedAt: now() });
    } catch (e) {
      log(`${a.lane}: approval ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      unlock();
    }
  };

  /** The first time the default profile is on: from now on (ADR-066). */
  const markDefaultSince = () =>
    deps.state.update((s) => {
      s.defaultSince ??= now();
    });

  const start = (lane: string, job: () => Promise<void>) => {
    const p = job().finally(() => {
      running.delete(lane);
      engine.kick();
    });
    running.set(lane, p);
  };

  const scan = async () => {
    const settings = deps.settings();
    const t = now();
    for (const a of deps.approvals.expire(t, APPROVAL_MAX_AGE_MS)) log(`approval ${a.id} expired after 7 days`);
    // the owner's decisions first
    for (const a of deps.approvals.list()) {
      if ((a.status !== 'approved' && a.status !== 'rejected') || a.closedAt) continue;
      if (running.has(a.lane) || running.size >= settings.concurrency) continue;
      start(a.lane, () => runApproval(a));
    }
    let todo: PluginMessage[];
    try {
      todo = await deps.core.todo();
    } catch (e) {
      log(`morse message: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    let st: AttendantStateData = deps.state.read();
    if (settings.defaultProfile && st.defaultSince === undefined) st = markDefaultSince();
    const lanes = new Map<string, { profile: AttendantProfile; msgs: PluginMessage[] }>();
    let wakeAt = Infinity;
    for (const m of todo) {
      if (!candidate(m) || busyMessages.has(m.id)) continue;
      const profile = profileFor(settings, m.contact as Parameters<typeof profileFor>[1]);
      if (!profile) continue; // no profile for this group: stored only
      const markOf = st.messages[m.id];
      if (markOf && (markOf.state === 'deferred' || markOf.state === 'failed')) continue;
      if (markOf?.state === 'running') continue; // another process runs it (recover() handles ours)
      if (markOf?.state === 'retry' && (markOf.notBefore ?? 0) > t) {
        wakeAt = Math.min(wakeAt, markOf.notBefore!);
        continue;
      }
      if (m.at < st.startedAt) {
        once(`old:${m.id}`, `${laneOf(m)}: ${m.id.slice(0, 8)} arrived before the attendant was first on — left for you`);
        continue;
      }
      // the default profile never answers backlog: mail from before it was first on (ADR-066)
      if (profile.conversationOnly && m.at < (st.defaultSince ?? t)) {
        once(`old:${m.id}`, `${laneOf(m)}: ${m.id.slice(0, 8)} arrived before the default profile was first on — left for you`);
        continue;
      }
      const maxAgeMin = profile.conversationOnly ? settings.defaultMaxAgeMin : settings.maxAgeMin;
      if (t - m.at > maxAgeMin * 60_000) {
        mark([m.id], { state: 'deferred', attempts: 0, reason: `older than ${maxAgeMin} min` });
        log(`${laneOf(m)}: ${m.id.slice(0, 8)} is older than ${maxAgeMin} min — left for you`);
        continue;
      }
      const lane = laneOf(m);
      const entry = lanes.get(lane) ?? { profile, msgs: [] };
      entry.msgs.push(m);
      lanes.set(lane, entry);
    }
    for (const [lane, { profile, msgs }] of lanes) {
      if (running.has(lane)) continue; // the next turn picks these up
      const newest = Math.max(...msgs.map((m) => m.at));
      if (t - newest < settings.coalesceMs) {
        wakeAt = Math.min(wakeAt, newest + settings.coalesceMs);
        continue;
      }
      if (running.size >= settings.concurrency) break;
      start(lane, () => runLane(lane, msgs, profile));
    }
    if (wakeAt !== Infinity) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => engine.kick(), Math.max(10, wakeAt - now()));
      timer.unref?.();
    }
  };

  const engine: Engine = {
    kick() {
      void engine.tick();
    },
    async tick() {
      if (scanning) {
        again = true;
        return scanning;
      }
      scanning = (async () => {
        try {
          do {
            again = false;
            await scan();
          } while (again);
        } catch (e) {
          log(`scan: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          scanning = null;
        }
      })();
      return scanning;
    },
    async idle() {
      for (;;) {
        await engine.tick();
        if (!running.size) {
          await engine.tick();
          if (!running.size) return;
        }
        await Promise.all([...running.values()]);
      }
    },
    recover() {
      let n = 0;
      if (deps.settings().defaultProfile) markDefaultSince();
      deps.state.update((s) => {
        for (const [id, m] of Object.entries(s.messages)) {
          if (m.state !== 'running') continue;
          n++;
          s.messages[id] = m.attempts >= MAX_TRIES ? { ...m, state: 'failed', reason: 'interrupted too often' } : { ...m, state: 'retry', notBefore: 0, reason: 'interrupted (the plugin stopped mid-turn)' };
        }
      });
      if (n) log(`${n} message(s) were mid-turn when the plugin stopped — retried (the agent is told it may be a retry)`);
      return n;
    },
    running: () => [...running.keys()],
  };
  return engine;
}
