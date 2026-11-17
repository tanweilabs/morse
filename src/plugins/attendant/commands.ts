import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { APPROVAL_MAX_AGE_MS, type ApprovalRequest, type ApprovalStore, createApprovalStore, decidePreTool, hookOutput, humanCheck } from './approvals.js';
import { readAttendantConfig, type AttendantProfile, type RateLimit } from './config.js';
import { whoOfContact } from './envelope.js';
import { attendantStateDir, createAttendantState, launchCounts } from './state.js';

/**
 * `morse plugin attendant …` (ADR-059 / ADR-060):
 *
 *   status [--json]                 profiles, per-contact sessions, approvals, what agents asked you, rate limits
 *   approvals [--all] [--json]      approval requests (pending; --all: decided ones too)
 *   approve <id> · reject <id>      only you, in your own terminal (refused inside an agent)
 *   dismiss <id> | all              you have seen what an agent asked you (ASK_OWNER, ADR-066)
 *   hook pretool --run <id>         the PreToolUse hook Claude runs (not for people)
 */

const usage = 'usage: morse plugin attendant status [--json] | approvals [--all] [--json] | approve <id> | reject <id> | dismiss <id|all>';

/** A rate limit for people (ADR-068): `no limit`, `10/h`, `50/day` or `6/h 30/day`. */
export const rateText = (r: RateLimit): string => [r.perHour !== null ? `${r.perHour}/h` : '', r.perDay !== null ? `${r.perDay}/day` : ''].filter(Boolean).join(' ') || 'no limit';

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

/** The hook: never throws, always answers (a crash would be "no opinion" to Claude). */
export async function hookPreTool(args: string[], input: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<string> {
  try {
    const runId = flag(args, '--run') ?? env['MORSE_ATTENDANT_RUN'] ?? '';
    const store = createApprovalStore(flag(args, '--state') ?? attendantStateDir(env));
    const payload = JSON.parse(input) as { tool_name?: unknown; tool_input?: unknown };
    return hookOutput(decidePreTool(payload, store.readRun(runId), store, home));
  } catch (e) {
    return hookOutput({ decision: 'deny', reason: `[Morse attendant] the approval check failed (${e instanceof Error ? e.message : String(e)}) — refused` });
  }
}

const describe = (a: ApprovalRequest): string => {
  const who = whoOfContact(a.contact).name;
  const age = Math.round((Date.now() - a.createdAt) / 60_000);
  return `${a.id}  ${a.status}  ${who} (${a.contact.group}) via @${a.agent}  ${a.tool} ${a.key.replace(/\s+/g, ' ').slice(0, 120)}  — ${age < 120 ? `${age} min` : `${Math.round(age / 60)} h`} ago${a.outcome ? `  [${a.outcome}]` : ''}`;
};

export interface DecideContext {
  env: NodeJS.ProcessEnv;
  tty: { stdin: boolean; stdout: boolean };
  /** Ask the person (y/N). */
  confirm: (question: string) => Promise<boolean>;
  now?: () => number;
}

/** approve / reject: only a person at a terminal — never an agent (ADR-060). */
export async function decide(store: ApprovalStore, id: string, decision: 'approved' | 'rejected', ctx: DecideContext): Promise<{ ok: boolean; message: string }> {
  const refused = humanCheck(ctx.env, ctx.tty);
  if (refused) return { ok: false, message: refused };
  const a = store.get(id.trim().toLowerCase());
  if (!a) return { ok: false, message: `no approval request ${id} — morse plugin attendant approvals lists them` };
  if (a.status !== 'pending') return { ok: false, message: `${a.id} is ${a.status} already` };
  const now = ctx.now ?? Date.now;
  if (now() - a.createdAt > APPROVAL_MAX_AGE_MS) {
    store.put({ ...a, status: 'expired', decidedAt: now() });
    return { ok: false, message: `${a.id} expired (older than 7 days)` };
  }
  const verb = decision === 'approved' ? 'Approve' : 'Reject';
  const yes = await ctx.confirm(`${describe(a)}\n  input: ${a.input.slice(0, 600)}\n${verb} this? [y/N] `);
  if (!yes) return { ok: false, message: 'nothing changed' };
  store.put({ ...a, status: decision, decidedAt: now() });
  return {
    ok: true,
    message:
      decision === 'approved'
        ? `${a.id} approved — the attendant re-runs the turn with that one action allowed, within a few seconds`
        : `${a.id} rejected — the attendant tells them, within a few seconds`,
  };
}

const ask = (q: string): Promise<boolean> =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });

const profileView = (p: AttendantProfile) => ({
  where: p.where,
  ...(p.conversationOnly ? { conversationOnly: true } : {}),
  group: p.group,
  agent: p.agent,
  cwd: p.cwd,
  ...(p.agent === 'claude' ? { tools: p.tools, permissionMode: p.launch.permissionMode, allowedTools: p.launch.allowedTools ?? [], disallowedTools: p.disallowedTools, maxTurns: p.maxTurns } : { sandbox: p.sandbox, allowUnscopedReads: true }),
  model: p.launch.model ?? null,
  effort: p.launch.effort ?? null,
  timeoutSec: Math.round((p.launch.timeoutMs ?? 0) / 1000),
  approvals: p.approvals,
  rateLimit: p.rate,
  answerAttendants: p.answerAttendants,
});

export function statusView(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()) {
  const { settings, enabled, ilinkEnabled } = readAttendantConfig(env);
  const dir = attendantStateDir(env);
  const st = createAttendantState(dir).read();
  const approvals = createApprovalStore(dir).list();
  const contacts = Object.keys(st.launches);
  const marks = Object.entries(st.messages);
  return {
    enabled,
    notifyWechat: settings.notifyWechat && ilinkEnabled,
    profiles: [
      ...Object.values(settings.groups).map(profileView),
      ...settings.offGroups.map((g) => ({ where: `plugins.attendant.groups.${g}`, off: true as const })),
      ...Object.entries(settings.contacts).map(([k, p]) => (p ? profileView(p) : { where: `plugins.attendant.contacts.${k}`, off: true as const })),
    ],
    /** ADR-066: accepted contacts nothing else matches — conversation only, or stored only (null). */
    defaultProfile: settings.defaultProfile ? { model: settings.defaultProfile.launch.model ?? null, rateLimit: settings.defaultProfile.rate, maxAgeMin: settings.defaultMaxAgeMin, tools: [] as string[] } : null,
    asks: st.asks.map((a) => ({ id: a.id, at: new Date(a.at).toISOString(), contact: whoOfContact(a.contact).name, group: a.contact.group, request: a.request, replyTo: a.replyTo })),
    errors: settings.errors,
    sessions: Object.entries(st.sessions).map(([lane, s]) => ({ lane, runtime: s.runtime, session: s.sessionId, cwd: s.cwd, turns: s.turns, lastTurnAt: s.lastTurnAt ? new Date(s.lastTurnAt).toISOString() : null })),
    approvals: approvals.filter((a) => a.status === 'pending' || (a.status === 'approved' && !a.closedAt)),
    rateLimits: contacts.map((c) => ({ contact: c, ...launchCounts(st, c, now) })),
    leftForYou: marks.filter(([, m]) => m.state === 'deferred' || m.state === 'failed').map(([id, m]) => ({ id, state: m.state, reason: m.reason ?? null })),
    retrying: marks.filter(([, m]) => m.state === 'retry' || m.state === 'running').map(([id, m]) => ({ id, state: m.state, attempts: m.attempts, reason: m.reason ?? null })),
  };
}

export async function runAttendantCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  if (command === 'hook') {
    if (rest[0] !== 'pretool') return 64;
    process.stdout.write(await hookPreTool(rest.slice(1), await readStdin()));
    return 0;
  }
  if (command === 'status') {
    const v = statusView();
    if (json) {
      console.log(JSON.stringify(v, null, 2));
      return 0;
    }
    console.log(`attendant: ${v.enabled ? 'on' : 'off (morse plugin enable attendant)'}${v.notifyWechat ? ' · approvals and questions are also sent to you on WeChat' : ''}`);
    for (const e of v.errors) console.log(`  ! ${e}`);
    const d = v.defaultProfile;
    console.log(d ? `  default (accepted contacts without a profile): conversation only — no tools · ${d.model ?? 'default model'} · ${rateText(d.rateLimit)}` : '  default: off — contacts without a profile are stored only');
    for (const p of v.profiles) {
      if ('off' in p) console.log(`  ${p.where}: off`);
      else console.log(`  ${p.where}: ${p.agent} in ${p.cwd}${'tools' in p ? ` · tools ${p.tools.join(',') || '-'} · ${p.permissionMode}` : ` · sandbox ${p.sandbox}`} · ${rateText(p.rateLimit)}`);
    }
    if (v.sessions.length) console.log('sessions (one per your agent + contact):');
    for (const s of v.sessions) console.log(`  ${s.lane}  ${s.runtime} ${s.session.slice(0, 8)}  ${s.turns} turn(s)${s.lastTurnAt ? `, last ${s.lastTurnAt}` : ''}`);
    if (v.rateLimits.length) console.log('launches (last hour / day):');
    for (const r of v.rateLimits) console.log(`  ${r.contact}: ${r.hour} / ${r.day}`);
    console.log(v.approvals.length ? `waiting for you: ${v.approvals.length} — morse plugin attendant approvals` : 'no approvals waiting');
    if (v.leftForYou.length) console.log(`left for you: ${v.leftForYou.length} message(s) (morse read)`);
    if (v.asks.length) console.log(`your agent asked you (${v.asks.length}) — answer with morse reply <id> "…", then morse plugin attendant dismiss <ask>:`);
    for (const a of v.asks) console.log(`  ${a.id}  ${a.contact} (${a.group})  ${a.request}  — morse reply ${a.replyTo.slice(0, 8)}  [${a.at}]`);
    return 0;
  }
  if (command === 'dismiss') {
    const id = rest.find((a) => !a.startsWith('--'));
    if (!id) {
      console.error(usage);
      return 64;
    }
    let n = 0;
    createAttendantState(attendantStateDir()).update((s) => {
      const keep = s.asks.filter((a) => !(id === 'all' || a.id === id.trim().toLowerCase()));
      n = s.asks.length - keep.length;
      s.asks = keep;
    });
    if (!n) {
      console.error(`no question ${id} — morse plugin attendant status lists them`);
      return 1;
    }
    console.log(`dismissed ${n}`);
    return 0;
  }
  if (command === 'approvals') {
    const all = rest.includes('--all');
    const store = createApprovalStore(attendantStateDir());
    store.expire(Date.now(), APPROVAL_MAX_AGE_MS);
    const list = store.list().filter((a) => all || a.status === 'pending');
    if (json) {
      console.log(JSON.stringify({ approvals: list }, null, 2));
      return 0;
    }
    if (!list.length) console.log(all ? 'no approval requests' : 'no approvals waiting');
    for (const a of list) console.log(describe(a));
    if (list.some((a) => a.status === 'pending')) console.log('\napprove: morse plugin attendant approve <id> · reject: morse plugin attendant reject <id>');
    return 0;
  }
  if (command === 'approve' || command === 'reject') {
    const id = rest.find((a) => !a.startsWith('--'));
    if (!id) {
      console.error(usage);
      return 64;
    }
    const store = createApprovalStore(attendantStateDir());
    const r = await decide(store, id, command === 'approve' ? 'approved' : 'rejected', { env: process.env, tty: { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) }, confirm: ask });
    (r.ok ? console.log : console.error)(r.message);
    if (r.ok && !readAttendantConfig().enabled) console.log('note: the attendant plugin is off — it acts on this when it is on (morse plugin enable attendant)');
    return r.ok ? 0 : 1;
  }
  console.error(usage);
  return 64;
}
