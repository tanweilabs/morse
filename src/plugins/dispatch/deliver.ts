import { randomUUID } from 'node:crypto';
import type { DeliveryAdapter, DeliveryResult, LaunchOptions, SessionInfo } from '../../adapters/types.js';
import { spawnWatch, type SpawnWatcher } from '../../adapters/exec.js';
import { classifyReply, extractReply, renderEnvelope, withRepeatLine } from '../../envelope.js';
import { isLeaseLost, type CoreClient, type PluginMessage } from '../../plugin/contract.js';
import { DISPATCH_AGENT, matchLaunch, type LaunchProfile } from './launch.js';
import type { DispatchState } from './state.js';

/**
 * morse-plugin-dispatch ("own agents", ADR-052): runs YOUR agents for YOUR mail — a
 * headless resume of the target session (claude -p --resume, codex exec resume …), the
 * shared-plan footer, the auto-reply capture with the NOOP / BLOCKED-pingpong rules.
 *
 * It only ever acts on mail between sessions on this computer (internal) and from your
 * own devices (contact `self`, group `self`). It talks to the core through the plugin
 * contract only (claim / ack / nack / reply) — no mailbox, no database.
 */

export interface DispatchEvent {
  kind: 'delivered' | 'failed' | 'waiting' | 'reply-filed' | 'reply-rejected' | 'redirected' | 'skipped' | 'superseded' | 'interrupted';
  messageId: string;
  /** The message as the core gave it (for logs and notifications). */
  message: PluginMessage;
  detail?: string;
}

export interface DispatchDeps {
  core: CoreClient;
  /** agent name -> delivery adapter */
  adapters: Map<string, DeliveryAdapter>;
  directory: () => Promise<SessionInfo[]>;
  onEvent?: (e: DispatchEvent) => void;
  /** Sessions that pull their own mail — never resumed behind their back (ADR-023/024/026). */
  isMonitored?: (sessionId: string) => boolean;
  isSessionLive?: (sessionId: string) => boolean;
  isPullOnly?: (sessionId: string) => boolean;
  /** ADR-054: the owner's per-agent launch settings (plugins.dispatch.launch). */
  launchProfiles?: () => LaunchProfile[];
  /** ADR-055 / ADR-056: the plugin's own state — dedicated sessions, per-session locks. */
  state?: DispatchState;
  /** A new session id (tests pin it). */
  newSessionId?: () => string;
  /** A line for the plugin's log. */
  log?: (line: string) => void;
  /**
   * ADR-089: claim under a lease (default) — the delivery belongs to this plugin run until it reports, the
   * lease is renewed while the turn runs and follows the agent CLI's process. false: the semantics of before.
   */
  lease?: boolean;
  /** How long a lease lasts without renewal (default: the core's, 45 s); it is renewed every third of it. */
  leaseTtlMs?: number;
  /** This plugin's pid (tests pin it). */
  pid?: number;
  /**
   * (ADR-089 review F3) false = the daemon that supervises this plugin is gone: nothing is claimed any more
   * (asked before every claim — a new daemon has its own plugin by now).
   */
  daemonAlive?: () => boolean;
  /** (ADR-089 review N1) true = this plugin has been told to stop: a turn that fails now was cut off, not refused. */
  stopping?: () => boolean;
}

/** Exit codes of a process that a signal ended, as a shell or the program itself reports them (128 + n): HUP, INT, KILL, TERM. */
const SIGNAL_EXITS = new Set([129, 130, 137, 143]);
/** Past the agent CLI's own time limit by this much, a turn that neither reported nor renewed is given up on. */
const TURN_LIMIT_MARGIN_MS = 60_000;

/** The holder option of a report on a claimed message (nothing when it was claimed without a lease). */
const held = (m: PluginMessage): { holder?: string } => (m.lease ? { holder: m.lease.holder } : {});
const leaseOf = (deps: DispatchDeps) => (deps.lease === false ? {} : { lease: { pid: deps.pid ?? process.pid, ...(deps.leaseTtlMs ? { ttlMs: deps.leaseTtlMs } : {}) } });

/**
 * ADR-089: keep the lease of a message alive while its turn runs — renewed every third of its life, tied to
 * the agent CLI's process as soon as that is started, with the turn's own time limit. It is also what the
 * agent CLIs started for the delivery report to (`spawnWatch`): `cut()` says that one of them was ended by a
 * signal that was not ours. `stop()` when the delivery is over.
 */
function keepLease(deps: DispatchDeps, m: PluginMessage, log?: (line: string) => void) {
  let cut: string | null = null;
  const watcher: SpawnWatcher = {
    spawned: () => undefined,
    ended: (_pid, how) => {
      if (how.timedOut) return; // our own time limit: reported as what it is
      if (how.signal) cut = how.signal;
      else if (how.code !== null && SIGNAL_EXITS.has(how.code)) cut = `exit ${how.code}`;
    },
  };
  const base = { watcher, cut: () => cut };
  if (!m.lease) return { ...base, start: async () => true, abandon: async () => undefined, stop: () => undefined };
  const holder = m.lease.holder;
  const ttlMs = deps.leaseTtlMs ?? 45_000;
  let pid: number | undefined;
  let limitAt: number | undefined;
  let lost = false;
  const now = () => ({ ...(pid ? { pid } : {}), ...(limitAt ? { maxMs: Math.max(1000, limitAt - Date.now()) } : {}), ...(deps.leaseTtlMs ? { ttlMs } : {}) });
  const extend = () =>
    void deps.core
      .extend(m.id, holder, now())
      .then((ok) => {
        if (!ok && !lost) {
          lost = true;
          log?.(`lease of ${m.id.slice(0, 8)} lost while its turn runs — its report will not count`);
        }
      })
      .catch(() => undefined);
  const timer = setInterval(extend, Math.max(50, Math.floor(ttlMs / 3)));
  timer.unref?.();
  watcher.spawned = (p, info) => {
    pid = p;
    limitAt = Date.now() + info.timeoutMs + TURN_LIMIT_MARGIN_MS;
    extend();
  };
  return {
    ...base,
    /**
     * (review F3) Said BEFORE the agent is started: from here on a takeover of this claim is a possible repeat;
     * a claim that dies before this was never worked on and is handed out again unlabelled. false = the lease
     * is not ours any more — no turn is started.
     */
    start: () => deps.core.extend(m.id, holder, { started: true, ...(deps.leaseTtlMs ? { ttlMs } : {}) }),
    /**
     * (review N1) The turn was cut off and this holder will not report on it: the lease is kept — started,
     * tied to the process that is gone — and ends NOW, so that the next claim takes the message over as an
     * interrupted delivery (labelled, counted) instead of waiting for the lease to run out. Best effort: if
     * this cannot be said any more (the plugin is being stopped), the lease runs out by itself.
     */
    abandon: async () => {
      clearInterval(timer);
      await deps.core.extend(m.id, holder, { ...(pid ? { pid } : {}), ttlMs: 0 }).catch(() => undefined);
    },
    stop: () => clearInterval(timer),
  };
}

/** ADR-054 `prompt: "plain"`: the owner in person, through a channel plugin — no agent protocol. */
export function renderPlain(input: { messageId: string; fromLabel: string; text: string }): string {
  return [
    `[Morse] This is your owner writing to you in person through ${input.fromLabel} (message id: ${input.messageId}). Answer as you would in a chat with them: your whole final answer is sent back.`,
    input.text,
  ].join('\n\n');
}

/**
 * Ours to handle: same-machine session mail, or mail from our own devices — and (ADR-071)
 * another person's reply in a thread one of our sessions started, to that session. Never
 * anything else of another person's.
 */
export function isOwnAgentMail(m: PluginMessage): boolean {
  if (m.foreign) return isOwnThreadReply(m);
  if (m.direction === 'internal') return true;
  return m.direction === 'in' && m.contact?.self === true && (m.contact as { group?: string }).group === 'self';
}

/** ADR-071: a reply in a thread one of our sessions started, filed to that session. */
export function isOwnThreadReply(m: PluginMessage): boolean {
  return m.foreign && m.ownThread === true && m.direction === 'in' && m.to.agent !== 'user' && m.to.sessionId !== 'inbox' && Boolean(m.to.sessionId);
}

/** ADR-071: the answer to what a session asked — another person's words, information only; nothing is sent back by itself. */
export function renderOwnThreadReply(m: Pick<PluginMessage, 'id' | 'text' | 'contextId' | 'from' | 'contact'>): string {
  const c = (m.contact ?? {}) as { remark?: string | null; handle?: string | null };
  // ADR-077: a remark that is just the old handle is not said twice
  const name = c.remark && c.remark !== c.handle ? `${c.remark} (${c.handle ?? m.from.device ?? '?'})` : (c.handle ?? m.from.device ?? 'unknown');
  return [
    `[Morse] This is the reply to the message you sent to ${name} (thread ${m.contextId}) — delivered to you because you started this thread.`,
    renderEnvelope({ messageId: m.id, fromLabel: `@${m.from.agent}`, text: m.text, replyVia: 'command', peer: { name: m.from.device ?? name } }),
    `Nothing you write in this turn is sent to them automatically. Tell your user what they answered; only if you have something new to ask or say, write back yourself: morse reply ${m.id} "<text>".`,
  ].join('\n');
}

const label = (s: SessionInfo | undefined, fallbackAgent: string, fallbackId: string): string =>
  s ? `@${s.agent}:${s.title}` : `@${fallbackAgent}:${fallbackId.slice(0, 8)}`;

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
const profilesOf = (deps: DispatchDeps): LaunchProfile[] => deps.launchProfiles?.() ?? [];
/**
 * The launch settings that may apply to this message. ADR-071 / ADR-082: a profile keyed on the
 * sender's agent name never applies to another person's reply (they could call their agent
 * "ilink" and pass for you in person) — neither how it is run nor whether it runs while the
 * session is live.
 */
const profilesFor = (m: PluginMessage, deps: DispatchDeps): LaunchProfile[] => (isOwnThreadReply(m) ? profilesOf(deps).filter((p) => !p.from) : profilesOf(deps));
/** A dedicated profile's current session id (ADR-056), or null. */
const dedicatedIdOf = (deps: DispatchDeps) => (name: string): string | null => deps.state?.dedicated(name)?.sessionId ?? null;

/** ADR-055: could a `whenLive: "resume"` profile apply to this session (whatever the sender)? */
export function mayResumeLive(profiles: LaunchProfile[], s: Pick<SessionInfo, 'agent' | 'sessionId' | 'cwd'>, dedicatedId: (name: string) => string | null = () => null): boolean {
  return profiles.some(
    (p) =>
      p.whenLive === 'resume' &&
      !p.to &&
      p.agent === s.agent &&
      (p.dedicated ? dedicatedId(p.name!) === s.sessionId : (!p.session || p.session === s.sessionId) && (!p.cwd || p.cwd === trimSlash(s.cwd))),
  );
}

/**
 * What one claimed message runs on (ADR-055): its lane is the real session — one turn per
 * lane at a time. Mail to `@dispatch:<profile>` and mail to that profile's current session
 * id share one lane.
 */
export interface Plan {
  lane: string;
  /** `@dispatch:<name>`: the dedicated profile (null = no such profile any more). */
  dedicated?: { name: string; profile: LaunchProfile | null };
  /** The session that would be resumed (null = a dedicated one not created yet). */
  sessionId: string | null;
}

export function planFor(m: Pick<PluginMessage, 'to'>, deps: DispatchDeps): Plan {
  if (m.to.agent === DISPATCH_AGENT) {
    const name = m.to.sessionId;
    const profile = profilesOf(deps).find((p) => p.dedicated && p.name === name) ?? null;
    return { lane: `${DISPATCH_AGENT}:${name}`, dedicated: { name, profile }, sessionId: deps.state?.dedicated(name)?.sessionId ?? null };
  }
  const owner = Object.entries(deps.state?.allDedicated() ?? {}).find(([, d]) => d.sessionId === m.to.sessionId)?.[0];
  return { lane: owner ? `${DISPATCH_AGENT}:${owner}` : m.to.sessionId, sessionId: m.to.sessionId };
}

/** The session ids (as messages address them) that belong to a lane. */
function laneAliases(lane: string, deps: DispatchDeps): string[] {
  if (!lane.startsWith(`${DISPATCH_AGENT}:`)) return [lane];
  const name = lane.slice(DISPATCH_AGENT.length + 1);
  const id = deps.state?.dedicated(name)?.sessionId;
  return id ? [name, id] : [name];
}

/** Sessions to pass over right now: pull-only ones, and live / monitored ones no `whenLive: "resume"` profile could run. */
export async function sessionsToSkip(deps: DispatchDeps): Promise<string[]> {
  if (!deps.isMonitored && !deps.isSessionLive && !deps.isPullOnly) return [];
  let sessions: SessionInfo[] = [];
  try {
    sessions = await deps.directory();
  } catch {
    return [];
  }
  const profiles = profilesOf(deps);
  const dedicatedId = dedicatedIdOf(deps);
  const live = (sid: string) => (deps.isMonitored?.(sid) ?? false) || (deps.isSessionLive?.(sid) ?? false);
  const skip = sessions
    .filter((s) => {
      if (s.device || s.agent === DISPATCH_AGENT) return false; // @dispatch:<profile> is ours to run
      if (deps.isPullOnly?.(s.sessionId)) return true;
      return live(s.sessionId) && !mayResumeLive(profiles, s, dedicatedId);
    })
    .map((s) => s.sessionId);
  // a dedicated profile that waits while its session is live: pass its address over too
  for (const p of profiles) {
    const id = p.dedicated && p.whenLive !== 'resume' ? dedicatedId(p.name!) : null;
    if (id && live(id)) skip.push(p.name!, id);
  }
  return skip;
}

const isMissingSession = (r: DeliveryResult) => r.missingSession === true || (!r.ok && /no conversation found/i.test(r.error ?? ''));

/**
 * One turn in a profile's dedicated session (ADR-056): resumed when it exists, created (with
 * an id we choose) on first use, created afresh when it cannot be resumed — the record then
 * says `resetPending` so the next reply begins with the profile's resetNotice.
 */
export async function runInDedicated(
  state: DispatchState,
  name: string,
  profile: LaunchProfile,
  adapter: DeliveryAdapter,
  envelope: string,
  newSessionId: () => string = randomUUID,
): Promise<{ result: DeliveryResult; started?: string; sessionId: string }> {
  const rec = state.dedicated(name);
  let target: SessionInfo = { agent: profile.agent, sessionId: rec?.sessionId ?? '', title: name, cwd: rec?.cwd ?? profile.cwd!, lastActiveAt: 0 };
  let started: string | undefined;
  const run = async (launch: LaunchOptions): Promise<DeliveryResult> => {
    try {
      return await adapter.deliver(target, envelope, launch);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const create = async (): Promise<DeliveryResult> => {
    const prev = state.dedicated(name);
    // a reset = a session that existed is gone (not: our own first try never got written)
    const reset = Boolean(prev && !prev.fresh) || Boolean(prev?.resetPending);
    const sessionId = newSessionId();
    target = { ...target, sessionId, cwd: profile.cwd! };
    state.setDedicated(name, { agent: profile.agent, sessionId, cwd: profile.cwd!, createdAt: new Date().toISOString(), fresh: true, ...(reset ? { resetPending: true } : {}) });
    started = reset ? 'new session (the earlier one is gone)' : 'new session';
    return run({ ...profile.launch, createSession: true });
  };
  let result = target.sessionId ? await run(profile.launch) : await create();
  if (!result.ok && target.sessionId && isMissingSession(result) && !started) result = await create();
  if (result.ok) {
    const now = state.dedicated(name);
    if (now?.fresh) state.setDedicated(name, { ...now, fresh: false });
  }
  return { result, ...(started ? { started } : {}), sessionId: target.sessionId };
}

/** Deliver one message this plugin holds (claimed). */
export async function deliverClaimed(claimed: PluginMessage, deps: DispatchDeps, plan: Plan = planFor(claimed, deps)): Promise<void> {
  const emit = (kind: DispatchEvent['kind'], detail?: string) => deps.onEvent?.({ kind, messageId: claimed.id, message: claimed, ...(detail ? { detail } : {}) });
  // ADR-055: the owner in person (plain) gets one try and a quick answer — no retries
  let plain = false;
  /** (ADR-089) the lease was lost: another delivery holds the message now — this one's report does not count */
  const superseded = (e: unknown): boolean => {
    if (!isLeaseLost(e)) return false;
    emit('superseded', 'another delivery took this message over — nothing reported from this one');
    return true;
  };
  const fail = async (error: string, terminal = false) => {
    try {
      await deps.core.nack(claimed.id, error, { ...(terminal || plain ? { terminal: true } : {}), ...held(claimed) });
    } catch (e) {
      if (superseded(e)) return;
      throw e;
    }
    emit('failed', error);
  };
  if (!isOwnAgentMail(claimed)) {
    // the core never hands these out; refuse anyway — never another person's
    await deps.core.toMailbox(claimed.id, 'not own-agent mail: kept in the mailbox', held(claimed));
    emit('skipped', 'not own-agent mail');
    return;
  }

  let sessions: SessionInfo[];
  try {
    sessions = await deps.directory();
  } catch (e) {
    return fail(`directory scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // ADR-071: another person's reply to what this session asked — information only
  const ownThread = isOwnThreadReply(claimed);
  const sender = sessions.find((s) => s.agent === claimed.from.agent && s.sessionId === claimed.from.sessionId);
  const senderLabel = label(sender, claimed.from.agent, claimed.from.sessionId);
  const text = claimed.text;

  let target: SessionInfo;
  let profile: LaunchProfile | null;
  let adapter: DeliveryAdapter | undefined;
  const dedicated = plan.dedicated;
  if (dedicated) {
    // ADR-056: @dispatch:<profile> — the profile's own session, created on first use
    profile = dedicated.profile;
    if (!profile) return fail(`no dedicated launch profile named "${dedicated.name}" (plugins.dispatch.launch)`, true);
    if (!deps.state) return fail('dedicated sessions need the dispatch plugin state', true);
    adapter = deps.adapters.get(profile.agent);
    if (!adapter) return fail(`no adapter for agent: ${profile.agent}`, true);
    const rec = deps.state.dedicated(dedicated.name);
    target = { agent: profile.agent, sessionId: rec?.sessionId ?? '', title: dedicated.name, cwd: rec?.cwd ?? profile.cwd!, lastActiveAt: 0 };
    plain = !ownThread && profile.prompt === 'plain' && profile.from === claimed.from.agent;
  } else {
    const found = sessions.find((s) => !s.device && s.agent === claimed.to.agent && s.sessionId === claimed.to.sessionId);
    if (!found) {
      // ADR-048: the session is gone (replaced, deleted) — its agent's mailbox keeps the message
      const why = `target session not found: @${claimed.to.agent}:${claimed.to.sessionId}`;
      if (await deps.core.toMailbox(claimed.id, `${why} — moved to the ${claimed.to.agent} mailbox`, held(claimed))) {
        emit('redirected', `${why} — in the ${claimed.to.agent} mailbox now (morse read)`);
        return;
      }
      return fail(why);
    }
    target = found;
    adapter = deps.adapters.get(claimed.to.agent);
    if (!adapter) return fail(`no adapter for agent: ${claimed.to.agent}`);
    profile = deps.launchProfiles ? matchLaunch(profilesFor(claimed, deps), target, claimed.from.agent, dedicatedIdOf(deps)) : null;
    plain = !ownThread && profile?.prompt === 'plain';
  }

  // (ADR-089) an earlier delivery of it was interrupted before it was confirmed: the agent is told, in every form
  const envelope = withRepeatLine(
    ownThread
      ? renderOwnThreadReply(claimed)
      : plain
        ? renderPlain({ messageId: claimed.id, fromLabel: senderLabel, text })
        : renderEnvelope({
            messageId: claimed.id,
            fromLabel: senderLabel,
            text,
            replyVia: adapter.replyChannel?.(target) ?? 'marker',
          }),
    claimed.possibleRepeat,
  );

  let result: DeliveryResult;
  let started: string | undefined;
  // (ADR-089) the lease is kept alive while the turn runs, and follows the agent CLI's process once it is started
  const lease = keepLease(deps, claimed, deps.log);
  const theAdapter = adapter;
  try {
    let ours: boolean;
    try {
      ours = await lease.start();
    } catch (e) {
      return await fail(`could not mark the delivery as started: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ours) return void emit('superseded', 'another delivery took this message over before its turn was started — nothing done');
    ({ result, started } = await spawnWatch.run(lease.watcher, async (): Promise<{ result: DeliveryResult; started?: string }> => {
      if (dedicated && profile && deps.state) return runInDedicated(deps.state, dedicated.name, profile, theAdapter, envelope, deps.newSessionId);
      try {
        return { result: profile ? await theAdapter.deliver(target, envelope, profile.launch) : await theAdapter.deliver(target, envelope) };
      } catch (e) {
        return { result: { ok: false, error: e instanceof Error ? e.message : String(e) } };
      }
    }));
    if (!result.ok) {
      // (review N1) a turn that was CUT OFF is not a failure of the message: the agent CLI was ended by a signal
      // that was not ours (a restart, the service manager, the user), or it failed while this plugin is being
      // stopped or its daemon is gone. Reporting it as a failure made the next delivery an ordinary retry — no
      // repeat line although the turn had run for a while — and killed a `plain` message at once. Nothing is
      // reported: the lease stays "started" and ends, so the next delivery is a labelled takeover that counts
      // as ONE interruption.
      const why = lease.cut()
        ? `the agent CLI was ended by a signal (${lease.cut()})`
        : result.retry === false
          ? null
          : deps.stopping?.()
            ? 'the turn failed while this plugin is being stopped'
            : deps.daemonAlive?.() === false
              ? 'the turn failed and the daemon is gone'
              : null;
      if (why && claimed.lease) {
        await lease.abandon();
        return void emit('interrupted', `${why} — not reported as a failure: it will be delivered again, marked as a possible repeat${result.error ? ` (${result.error.slice(0, 200)})` : ''}`);
      }
      return await fail(result.error ?? 'delivery failed', result.retry === false);
    }

    try {
      await deps.core.ack(claimed.id, { ...(result.inSession ? { inSession: true } : {}), ...held(claimed) });
    } catch (e) {
      // not the holder any more: the delivery that took it over reports — and answers — for this message
      if (superseded(e)) return;
      throw e;
    }
  } finally {
    lease.stop();
  }
  emit('delivered', [result.inSession ? 'in-session' : '', started ?? '', ownThread ? 'reply in its own thread' : ''].filter(Boolean).join(', ') || undefined);
  // ADR-071: never answers another person by itself — the session runs `morse reply` if it wants to
  if (ownThread) return;

  // plain: the whole answer is the reply; otherwise only what follows the marker
  let replyText = plain ? (result.output ?? '').trim() || null : extractReply(result.output ?? '');
  // NOOP and BLOCKED-answering-BLOCKED are answers, not messages (ADR-032 / ADR-042)
  const verdict = replyText ? classifyReply(text, replyText) : 'noop';
  if (verdict !== 'file') replyText = null;
  // ADR-056: the first reply after a fresh start says that the context was reset — once
  const resetRec = dedicated && deps.state ? deps.state.dedicated(dedicated.name) : null;
  const notice = resetRec?.resetPending ? profile?.resetNotice : undefined;
  if (notice) replyText = replyText ? `${notice}\n\n${replyText}` : notice;
  if (!replyText) {
    if (verdict !== 'file' && result.output?.trim()) emit('reply-rejected', verdict === 'noop' ? 'noop reply — not filed' : 'blocked-pingpong suppressed');
    return;
  }
  const r = await deps.core.reply(claimed.id, replyText, { via: 'auto' });
  if (r.ok && notice && dedicated && deps.state) {
    const rec = deps.state.dedicated(dedicated.name);
    if (rec) {
      const { resetPending: _, ...rest } = rec;
      deps.state.setDedicated(dedicated.name, rest);
    }
  }
  // a reply that cannot be filed is recorded, never a crash
  if (r.ok) deps.onEvent?.({ kind: 'reply-filed', messageId: r.id, message: claimed });
  else emit('reply-rejected', r.error);
}

/** A session that surfaces its own mail right now (live, monitored). */
const liveish = (deps: DispatchDeps, sessionId: string): boolean => (deps.isMonitored?.(sessionId) ?? false) || (deps.isSessionLive?.(sessionId) ?? false);

/** Would this message run even though its session is live (ADR-055)? */
async function resumesWhenLive(m: PluginMessage, plan: Plan, deps: DispatchDeps): Promise<boolean> {
  // ADR-082: a setting keyed on the sender's agent name is the owner's word about THEIR OWN
  // sender (the ilink plugin …) — another person's reply never gets it by using that name
  const ownThread = isOwnThreadReply(m);
  if (plan.dedicated) return plan.dedicated.profile?.whenLive === 'resume' && !(ownThread && plan.dedicated.profile.from);
  if (!deps.launchProfiles) return false;
  let sessions: SessionInfo[] = [];
  try {
    sessions = await deps.directory();
  } catch {
    return false;
  }
  const target = sessions.find((s) => !s.device && s.agent === m.to.agent && s.sessionId === m.to.sessionId);
  return target ? matchLaunch(profilesFor(m, deps), target, m.from.agent, dedicatedIdOf(deps))?.whenLive === 'resume' : false;
}

/** In-process lane locks when there is no state directory (tests). */
const memLanes = new Set<string>();
const memLock = (lane: string): (() => void) | null => {
  if (memLanes.has(lane)) return null;
  memLanes.add(lane);
  return () => memLanes.delete(lane);
};

export interface Claimed {
  message: PluginMessage;
  plan: Plan;
  unlock: () => void;
}

/**
 * Claim the next due own-agent message whose lane is free, and hold its lane. Pull-only
 * sessions are passed over; live / monitored ones too unless the matching profile says
 * `whenLive: "resume"` (ADR-055). null = nothing to do now.
 */
export async function claimOne(deps: DispatchDeps, busyLanes: Iterable<string> = []): Promise<Claimed | null> {
  const skip = new Set(await sessionsToSkip(deps));
  for (const lane of busyLanes) for (const id of laneAliases(lane, deps)) skip.add(id);
  const skipIds = new Set<string>();
  // sessions the directory does not list (registered external ones) are found on claim: hand back, pass over
  for (let i = 0; i < 50; i++) {
    const claimed = await deps.core.claimNext({ skipSessions: [...skip], ...(skipIds.size ? { skipIds: [...skipIds] } : {}), ...leaseOf(deps) });
    if (!claimed) return null;
    // (review N2) whatever happens between the claim and the hand-over to a turn — an early `continue`, an
    // exception — the claim is handed back; a hand-back that fails is said and not thrown (such a claim frees
    // itself: it was never started, and nobody renews it)
    let kept = false;
    try {
      const plan = planFor(claimed, deps);
      if (!plan.dedicated && (deps.isPullOnly?.(claimed.to.sessionId) ?? false)) {
        skip.add(claimed.to.sessionId);
        continue;
      }
      if (plan.sessionId && liveish(deps, plan.sessionId) && !(await resumesWhenLive(claimed, plan, deps))) {
        skipIds.add(claimed.id); // others for the same session may still run (whenLive: "resume")
        continue;
      }
      // one turn per session, also across processes (ADR-055)
      const unlock = deps.state ? deps.state.lock(plan.lane) : memLock(plan.lane);
      if (!unlock) {
        for (const id of laneAliases(plan.lane, deps)) skip.add(id);
        continue;
      }
      kept = true;
      return { message: claimed, plan, unlock };
    } finally {
      if (!kept) {
        skipIds.add(claimed.id); // (not offered again in this pass, whether or not the hand-back worked)
        await deps.core.release(claimed.id, held(claimed)).catch((e: unknown) => deps.log?.(`could not hand ${claimed.id.slice(0, 8)} back: ${e instanceof Error ? e.message : String(e)} — it frees itself when its lease runs out`));
      }
    }
  }
  return null;
}

/** Claim the next due own-agent message and deliver it. false = nothing to do. */
export async function dispatchStep(deps: DispatchDeps): Promise<boolean> {
  const got = await claimOne(deps);
  if (!got) return false;
  try {
    await deliverClaimed(got.message, deps, got.plan);
  } finally {
    got.unlock();
  }
  return true;
}

/**
 * The plugin's loop (ADR-055): up to `concurrency` turns at once, never two for one
 * session — a long WeChat turn no longer holds up mail for your other sessions.
 */
export function createDispatcher(deps: DispatchDeps, opts: { concurrency?: number; log?: (line: string) => void } = {}) {
  const max = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const running = new Map<string, Promise<void>>();
  let claiming = false;
  let again = false;
  let stopped = false;
  const mayClaim = (): boolean => !stopped && deps.daemonAlive?.() !== false;
  const fill = async (): Promise<void> => {
    if (!mayClaim()) return;
    if (claiming) {
      again = true;
      return;
    }
    claiming = true;
    try {
      do {
        again = false;
        while (running.size < max && mayClaim()) {
          const got = await claimOne(deps, running.keys());
          if (!got) break;
          if (!mayClaim()) {
            // (ADR-089) stopping while this claim was under way: no agent was started for it — handed back at once
            await deps.core.release(got.message.id, held(got.message)).catch(() => undefined);
            got.unlock();
            break;
          }
          const turn = deliverClaimed(got.message, deps, got.plan)
            .catch((e: unknown) => opts.log?.(`dispatch: ${e instanceof Error ? e.message : String(e)}`))
            .finally(() => {
              got.unlock();
              running.delete(got.plan.lane);
              void fill();
            });
          running.set(got.plan.lane, turn);
        }
      } while (again);
    } catch (e) {
      opts.log?.(`dispatch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      claiming = false;
    }
  };
  return {
    kick: () => void fill(),
    /** Resolves when nothing is running and nothing more is due right now. */
    async idle(): Promise<void> {
      await fill();
      while (running.size || claiming) {
        await Promise.all([...running.values()]);
        await new Promise((r) => setTimeout(r, 10));
        await fill();
      }
    },
    running: () => [...running.keys()],
    /**
     * ADR-089, stopping: nothing new is claimed from now on. Resolves when the turns that are running have
     * finished and reported (the caller bounds how long it waits; a turn still running then keeps its lease —
     * it is tied to the agent CLI's process).
     */
    async stop(): Promise<void> {
      stopped = true;
      while (running.size || claiming) {
        await Promise.all([...running.values()]);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}
