import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecFn } from '../src/adapters/types.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';
import { pluginSpecs } from '../src/plugin/manager.js';
import { actionKey, createApprovalStore, decidePreTool, humanCheck, matchPattern, subCommands, touchesDenied } from '../src/plugins/attendant/approvals.js';
import { decide, hookPreTool, rateText, statusView } from '../src/plugins/attendant/commands.js';
import { ATTENDANT_TOKEN, DEFAULT_APPROVALS, parseAttendantConfig, profileFor, type ConfigContext } from '../src/plugins/attendant/config.js';
import { createLocalCore } from './helpers/attendant-core.js';
import { createEngine, stageAttachments } from '../src/plugins/attendant/engine.js';
import { claudeAttendantArgs, codexAttendantArgs, splitApprovals } from '../src/plugins/attendant/runner.js';
import { createAttendantState } from '../src/plugins/attendant/state.js';

/**
 * ADR-059 / ADR-060: the attendant plugin — your agent answers a contact who is not you,
 * per group, in a session of its own per contact, limited to a directory and tools;
 * destructive or outward-facing actions stop for your approval. All with a fake `claude`
 * that calls the real PreToolUse hook for the tool calls it "makes".
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

let clock = Date.now(); // the hook stamps approval requests with the real time
const now = () => clock;
let idn = 0;
const newId = () => `00000000-0000-4000-8000-${String(++idn).padStart(12, '0')}`;

function home(): { root: string; home: string; work: string; inbox: string; ctx: ConfigContext } {
  const root = mkdtempSync(join(tmpdir(), 'attendant-'));
  roots.push(root);
  const h = join(root, 'home');
  const work = join(h, 'work', 'shared');
  const inbox = join(h, '.morse', 'inbox-files');
  for (const d of [work, inbox, join(h, '.ssh')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(h, '.ssh', 'id_test'), 'secret');
  return { root, home: h, work, inbox, ctx: { home: h, morseDir: join(h, '.morse') } };
}

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}
interface Call {
  cmd: string;
  args: string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  prompt: string;
  executed: ToolCall[];
  denied: ToolCall[];
  reasons: string[];
}
type Script = (call: Call, n: number) => { tools?: ToolCall[]; result?: string | ((c: Call) => string); raw?: { code: number; stdout: string; stderr: string } };

/** A fake `claude -p`: "makes" the scripted tool calls through the real hook, then answers. */
function fakeClaude(script: Script, homeDir: string): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: Call = { cmd, args, cwd: opts.cwd, env: opts.env ?? {}, prompt: args[args.length - 1]!, executed: [], denied: [], reasons: [] };
    calls.push(call);
    const s = script(call, calls.length);
    if (s.raw) return s.raw;
    // the hook command Claude would run, from the generated settings file
    const settings = JSON.parse(readFileSync(args[args.indexOf('--settings') + 1]!, 'utf8')) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    const m = /'--run' '([^']+)' '--state' '([^']+)' \|\| exit 2$/.exec(command);
    if (!m) throw new Error(`unexpected hook command: ${command}`);
    for (const tc of s.tools ?? []) {
      const out = await hookPreTool(['--run', m[1]!, '--state', m[2]!], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tc.tool, tool_input: tc.input }), {}, homeDir);
      const decision = out ? (JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }).hookSpecificOutput : null;
      if (decision?.permissionDecision === 'deny') {
        call.denied.push(tc);
        call.reasons.push(decision.permissionDecisionReason);
      } else call.executed.push(tc);
    }
    const sid = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1];
    const result = typeof s.result === 'function' ? s.result(call) : (s.result ?? 'ok');
    return { code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: sid, permission_denials: call.denied.map((d) => ({ tool_name: d.tool, tool_input: d.input })) }) };
  };
  return { exec, calls };
}

function setup(o: { groups?: Record<string, Record<string, unknown>>; contacts?: Record<string, unknown>; script?: Script; coalesceSec?: number; extra?: Record<string, unknown>; ilink?: boolean } = {}) {
  const h = home();
  const settings = parseAttendantConfig({ coalesceSec: o.coalesceSec ?? 0, groups: o.groups ?? { colleague: { cwd: h.work } }, ...(o.contacts ? { contacts: o.contacts } : {}), ...o.extra }, h.ctx);
  const mailbox = createMailbox(createDb(':memory:'), { now });
  const core = createLocalCore(mailbox);
  const stateDir = join(h.home, '.morse', 'plugins', 'attendant');
  const state = createAttendantState(stateDir, now);
  const approvals = createApprovalStore(stateDir);
  const fake = fakeClaude(o.script ?? (() => ({ result: 'Hello from the attendant' })), h.home);
  const logs: string[] = [];
  const os: string[] = [];
  const mk = (exec: ExecFn = fake.exec) =>
    createEngine({ core, exec, state, approvals, settings: () => settings, ilinkEnabled: () => o.ilink ?? true, pluginArgv: ['/usr/bin/node', '/opt/morse/attendant/main.js'], stateDir, home: h.home, inboxFilesDir: h.inbox, now, newId, log: (l) => logs.push(l), osNotify: (t, b) => os.push(`${t} — ${b}`) });
  const engine = mk();
  engine.recover(); // records when the attendant was first on
  clock += 1000;
  return { ...h, settings, mailbox, core, state, approvals, fake, engine, mk, logs, os, stateDir };
}

/** A message from another person (`<handle>/mbp`) to my agent `mini`. */
const from = (mb: Mailbox, handle: string, text: string, extra: { contextId?: string; files?: Array<{ name: string; path: string; size: number; sha256: string }> } = {}) => {
  clock += 10;
  return mb.send({ from: { agent: 'claude', sessionId: '', device: `${handle}/mbp` }, to: { agent: 'mini', sessionId: 'inbox' }, text, fromTier: 'peer', ...extra });
};
const label = (mb: Mailbox, handle: string, group: string, remark?: string) => mb.contacts.set(mb.contacts.ensure(handle).id, { group, ...(remark ? { remark } : {}) });
const repliesTo = (mb: Mailbox, handle: string) => mb.history(`c:${handle}`, { limit: 100 }).filter((m) => m.direction === 'out');

describe('profiles: strict validation, a bad one switches off only itself (ADR-059)', () => {
  it('defaults: Claude, read-only tools, dontAsk, the default approval list', () => {
    const h = home();
    const s = parseAttendantConfig({ groups: { colleague: { cwd: h.work } } }, h.ctx);
    expect(s.errors).toEqual([]);
    expect(s.groups['colleague']).toMatchObject({ agent: 'claude', tools: ['Read', 'Grep', 'Glob'], launch: { permissionMode: 'dontAsk', timeoutMs: 600_000 }, maxTurns: 30, approvals: DEFAULT_APPROVALS, rate: { perHour: null, perDay: null }, answerAttendants: true, maxTurnsPerContext: null }); // ADR-068 / ADR-072: no rate limit, no turn cap by default
    expect(s.groups['colleague']!.denyPaths).toContain(join(h.home, '.ssh'));
    expect(s.groups['colleague']!.denyPaths).toContain(join(h.home, '.morse'));
  });

  it('refuses bypass modes, a bare Bash, unsafe directories, "self", Codex without the opt-in, unknown keys — each profile on its own', () => {
    const h = home();
    mkdirSync(join(h.work, 'private'), { recursive: true });
    const bad: Record<string, Record<string, unknown>> = {
      bypass: { cwd: h.work, permissionMode: 'bypassPermissions' },
      bash: { cwd: h.work, allowedTools: ['Bash'] },
      homedir: { cwd: h.home },
      above: { cwd: join(h.home, '..') },
      relative: { cwd: 'work/shared' },
      morse: { cwd: join(h.home, '.morse') },
      holds: { cwd: h.work, denyPaths: [join(h.work, 'private')] },
      missing: { cwd: join(h.work, 'nope') },
      self: { cwd: h.work },
      codex: { agent: 'codex', cwd: h.work },
      danger: { agent: 'codex', cwd: h.work, allowUnscopedReads: true, sandbox: 'danger-full-access' },
      codexTools: { agent: 'codex', cwd: h.work, allowUnscopedReads: true, tools: ['Read'] },
      typo: { cwd: h.work, permisionMode: 'dontAsk' },
      effort: { cwd: h.work, effort: 'insane' },
    };
    const s = parseAttendantConfig({ groups: { ...bad, colleague: { cwd: h.work }, partner: { agent: 'codex', cwd: h.work, allowUnscopedReads: true } } }, h.ctx);
    expect(Object.keys(s.groups).sort()).toEqual(['colleague', 'partner']);
    const err = (g: string) => s.errors.find((e) => e.startsWith(`plugins.attendant.groups.${g}:`)) ?? '';
    expect(err('bypass')).toMatch(/bypass-style permission modes are never allowed — this profile is off/);
    expect(err('bash')).toMatch(/not a tool name or Bash\(<fixed command prefix>/);
    expect(err('homedir')).toMatch(/home directory/);
    expect(err('above')).toMatch(/home directory/);
    expect(err('relative')).toMatch(/absolute path/);
    expect(err('morse')).toMatch(/inside a private place/);
    expect(err('holds')).toMatch(/holds a private place/);
    expect(err('missing')).toMatch(/no such directory/);
    expect(err('self')).toMatch(/dispatch plugin/);
    expect(err('codex')).toMatch(/allowUnscopedReads/);
    expect(err('danger')).toMatch(/danger-full-access is never allowed/);
    expect(err('codexTools')).toMatch(/Claude setting/);
    expect(err('typo')).toMatch(/unknown setting "permisionMode"/);
    expect(err('effort')).toMatch(/effort/);
    expect(s.groups['partner']).toMatchObject({ agent: 'codex', sandbox: 'read-only' });
  });

  it('contact overrides: off for one person, or a profile of their own (inheriting the group named)', () => {
    const h = home();
    const s = parseAttendantConfig({ groups: { colleague: { cwd: h.work, model: 'sonnet' } }, contacts: { bob: { enabled: false }, alice: { group: 'colleague', model: 'opus' } } }, h.ctx);
    const alice = profileFor(s, { id: 'c:alice', handle: 'alice', remark: 'Alice', group: 'colleague' });
    expect(alice).toMatchObject({ cwd: s.groups['colleague']!.cwd, launch: { model: 'opus' } });
    expect(profileFor(s, { id: 'c:bob', handle: 'bob', group: 'colleague' })).toBeNull();
    expect(profileFor(s, { id: 'c:carol', handle: 'carol', group: 'colleague' })).toMatchObject({ launch: { model: 'sonnet' } });
    expect(profileFor(s, { id: 'c:dave', handle: 'dave', group: 'other' })).toMatchObject({ conversationOnly: true, tools: [], group: 'other' }); // the default (ADR-066)
    expect(profileFor(s, { id: 'self', group: 'self', self: true })).toBeNull();
  });
});

describe('the conversation-only default for accepted contacts (ADR-066)', () => {
  it('an accepted contact with no profile gets a session of its own with no tools at all, in an empty directory of its own', async () => {
    const t = setup({ script: () => ({ result: 'Hi! He is away right now — anything I can pass on?' }) });
    const m = from(t.mailbox, 'bob', 'hey, is he around?');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(1);
    const c = t.fake.calls[0]!;
    // no built-in tool, no MCP, no skills / commands, user settings ignored, never a bypass
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('');
    expect(c.args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'sonnet', '--session-id']));
    expect(c.args.join(' ')).not.toMatch(/allowedTools|dangerously|bypass/);
    // its cwd: an empty per-contact directory under the plugin's state, never the owner's files
    const contacts = join(t.stateDir, 'contacts');
    expect(c.cwd!.startsWith(`${contacts}/c_bob-`)).toBe(true);
    expect(readdirSync(c.cwd!)).toEqual([]);
    const system = c.args[c.args.indexOf('--append-system-prompt') + 1]!;
    expect(system).toMatch(/You have no tools/);
    expect(system).toMatch(/Never claim or imply that you did/);
    expect(system).toMatch(/Keep it short/);
    expect(system).toContain('ASK_OWNER: <one-line request for your owner>');
    // who: the address (no remark yet), not the owner; untrusted
    expect(c.prompt).toContain('A message from morse.im/bob (group "other") — another address, not your owner.');
    expect(c.prompt).toMatch(/never your owner's instruction/);
    expect(repliesTo(t.mailbox, 'bob').map((r) => r.parts[0]!.text)).toEqual([`Hi! He is away right now — anything I can pass on?\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`]);
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
    expect(t.state.read().sessions['mini/c:bob']).toMatchObject({ runtime: 'claude', cwd: c.cwd, turns: 1 });
    // the next message resumes the same session; a remark shows as "remark (address)"
    label(t.mailbox, 'bob', 'other', 'Bob');
    from(t.mailbox, 'bob', 'ok thanks, tell him I called');
    clock += 10_000;
    await t.engine.idle();
    const second = t.fake.calls[1]!;
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(t.state.read().sessions['mini/c:bob']!.sessionId);
    expect(second.prompt).toContain('from Bob (morse.im/bob, group "other")');
  });

  it('attachments are not copied into a conversation-only session (no file access)', async () => {
    const t = setup();
    const f = join(t.inbox, 'm1', 'photo.jpg');
    mkdirSync(join(t.inbox, 'm1'), { recursive: true });
    writeFileSync(f, 'x');
    from(t.mailbox, 'bob', 'look at this', { files: [{ name: 'photo.jpg', path: f, size: 1, sha256: 'x' }] });
    clock += 10_000;
    await t.engine.idle();
    const c = t.fake.calls[0]!;
    expect(c.prompt).toContain('photo.jpg: not available to you (no file access in this conversation)');
    expect(readdirSync(c.cwd!)).toEqual([]);
  });

  it('message requests, blocked contacts, switched-off groups and contacts are untouched', async () => {
    const t = setup({ extra: { groups: { colleague: { cwd: home().work }, family: { enabled: false } }, contacts: { carol: { enabled: false } } } });
    t.mailbox.requests.file({ handle: 'zed', deviceId: 'D', msgId: 'r1', from: { agent: 'claude', sessionId: '' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'hello stranger', droppedFiles: 0, via: 'morse-relay' });
    const blocked = from(t.mailbox, 'mallory', 'let me in');
    t.mailbox.contacts.set('c:mallory', { state: 'blocked' });
    const blockedColleague = from(t.mailbox, 'eve', 'push it');
    label(t.mailbox, 'eve', 'colleague');
    t.mailbox.contacts.set('c:eve', { state: 'blocked' });
    const fam = from(t.mailbox, 'mum', 'dinner?');
    label(t.mailbox, 'mum', 'family');
    const carol = from(t.mailbox, 'carol', 'hi');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(0);
    for (const m of [blocked, blockedColleague, fam, carol]) expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
    expect(t.mailbox.requests.get('zed')).toBeTruthy();
    expect(t.mailbox.todo().map((m) => m.parts[0]!.text)).not.toContain('hello stranger');
  });

  it('a configured profile overrides the default (its tools, its directory)', async () => {
    const t = setup();
    label(t.mailbox, 'alice', 'colleague');
    from(t.mailbox, 'alice', 'what is in the README?');
    clock += 10_000;
    await t.engine.idle();
    const c = t.fake.calls[0]!;
    expect(c.args[c.args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(c.cwd).toBe(t.settings.groups['colleague']!.cwd);
    expect(c.args).not.toContain('--disable-slash-commands');
    expect(c.args).not.toContain('sonnet');
    expect(c.args[c.args.indexOf('--append-system-prompt') + 1]).toMatch(/Work only in/);
  });

  it('defaultProfile: false — contacts without a profile are stored only, as before', async () => {
    const t = setup({ extra: { defaultProfile: false } });
    const m = from(t.mailbox, 'bob', 'hey');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(0);
    expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
    expect(t.state.read().defaultSince).toBeUndefined();
  });

  it('ASK_OWNER: the owner is told (desktop, status, WeChat) and the marker never reaches the contact', async () => {
    const t = setup({ script: () => ({ result: 'Let me check with him and get back to you.\n\n`ASK_OWNER: Bob wants to borrow the car on Friday — OK?`' }) });
    const m = from(t.mailbox, 'bob', 'can I borrow the car on friday?');
    clock += 10_000;
    await t.engine.idle();
    const sent = repliesTo(t.mailbox, 'bob').map((r) => r.parts[0]!.text);
    expect(sent).toEqual([`Let me check with him and get back to you.\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`]);
    expect(sent.join('')).not.toContain('ASK_OWNER');
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
    expect(t.os.some((l) => l.includes('your agent asks you') && l.includes('Bob wants to borrow the car on Friday — OK?') && l.includes(`morse reply ${m.id.slice(0, 8)}`))).toBe(true);
    expect(t.core.notices.some((l) => l.includes('morse.im/bob (other) — your agent asks you: Bob wants to borrow the car on Friday — OK?'))).toBe(true);
    expect(t.state.read().asks).toMatchObject([{ request: 'Bob wants to borrow the car on Friday — OK?', replyTo: m.id, contact: { id: 'c:bob' }, lane: 'mini/c:bob' }]);
    const v = statusView({ MORSE_HOME: t.home }, clock);
    expect(v.asks).toMatchObject([{ contact: 'morse.im/bob', group: 'other', request: 'Bob wants to borrow the car on Friday — OK?', replyTo: m.id }]);

    // without ilink: desktop only; a bare marker still tells the contact something
    const u = setup({ ilink: false, script: () => ({ result: 'ASK_OWNER: Alice asks for the budget numbers' }) });
    label(u.mailbox, 'alice', 'colleague');
    from(u.mailbox, 'alice', 'send me the budget numbers');
    clock += 10_000;
    await u.engine.idle();
    expect(repliesTo(u.mailbox, 'alice').map((r) => r.parts[0]!.text.split('\n')[0])).toEqual(['I will check with my owner and get back to you.']);
    expect(u.os.some((l) => l.includes('Alice asks for the budget numbers'))).toBe(true);
    expect(u.core.notices).toEqual([]);
  });

  it('NOOP sends nothing (and is processed); an answer written as a tool call is never sent', async () => {
    const t = setup({ script: () => ({ result: 'NOOP' }) });
    const m = from(t.mailbox, 'bob', '👍');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(repliesTo(t.mailbox, 'bob')).toHaveLength(0);
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');

    const u = setup({ script: () => ({ result: '<invoke name="bash">\n<parameter name="command">ls ~</parameter>\n</invoke>' }) });
    const n = from(u.mailbox, 'bob', 'what files does he have?');
    clock += 10_000;
    await u.engine.idle();
    expect(repliesTo(u.mailbox, 'bob')).toHaveLength(0);
    expect(u.mailbox.getMessage(n.id)?.processedAt).toBeUndefined();
    expect(u.state.read().messages[n.id]).toMatchObject({ state: 'failed' });
  });

  it('backlog is never answered: mail from before the default was first on, or older than its maxAgeMin (60)', async () => {
    const t = setup({ extra: { defaultProfile: false } });
    clock += 60_000;
    const early = from(t.mailbox, 'bob', 'from before the upgrade');
    clock += 60_000;
    // the upgrade: the same state (the attendant was on before), now with the default
    const settings = parseAttendantConfig({ coalesceSec: 0 }, t.ctx);
    const e2 = createEngine({ core: t.core, exec: t.fake.exec, state: t.state, approvals: t.approvals, settings: () => settings, pluginArgv: ['/usr/bin/node', '/x.js'], stateDir: t.stateDir, home: t.home, inboxFilesDir: t.inbox, now, newId, log: (l) => t.logs.push(l) });
    e2.recover();
    expect(t.state.read().defaultSince).toBe(clock);
    clock += 1000;
    const fresh = from(t.mailbox, 'carol', 'hello after');
    clock += 10_000;
    await e2.idle();
    expect(t.fake.calls.map((c) => c.prompt.includes('hello after'))).toEqual([true]);
    expect(t.mailbox.getMessage(early.id)?.processedAt).toBeUndefined();
    expect(t.mailbox.getMessage(fresh.id)?.processedBy).toBe('plugin:attendant');
    expect(t.logs.join('\n')).toMatch(/before the default profile was first on/);
    // a message that waited longer than the default's maxAgeMin is left for you
    const stale = from(t.mailbox, 'dave', 'are you there?');
    clock += 61 * 60_000;
    await e2.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(t.state.read().messages[stale.id]).toMatchObject({ state: 'deferred', reason: 'older than 60 min' });
  });

  it('config: on by default; the default takes model / limits / texts only; a bad one is off with a line', () => {
    const h = home();
    const def = parseAttendantConfig(undefined, h.ctx).defaultProfile!;
    expect(def).toMatchObject({ conversationOnly: true, tools: [], launch: { model: 'sonnet', permissionMode: 'dontAsk', timeoutMs: 180_000 }, rate: { perHour: null, perDay: null }, maxTurns: 3 }); // ADR-068: no rate limit by default
    const custom = parseAttendantConfig({ defaultProfile: { model: 'haiku', rateLimit: { perHour: 2 }, maxAgeMin: 30, notices: { askOwner: 'Moment, ich frage nach.' } } }, h.ctx);
    expect(custom.defaultProfile).toMatchObject({ launch: { model: 'haiku' }, rate: { perHour: 2, perDay: null }, notices: { askOwner: 'Moment, ich frage nach.' } });
    expect(custom.defaultMaxAgeMin).toBe(30);
    for (const bad of [{ tools: ['Read'] }, { cwd: h.work }, { permissionMode: 'bypassPermissions' }, 'yes']) {
      const s = parseAttendantConfig({ defaultProfile: bad }, h.ctx);
      expect(s.defaultProfile).toBeNull();
      expect(s.errors.join('\n')).toMatch(/plugins\.attendant\.defaultProfile: .* the default is off/);
    }
    expect(parseAttendantConfig({ defaultProfile: { enabled: false } }, h.ctx).defaultProfile).toBeNull();
    // a group with a bad profile is stored only — never quietly the default
    const s = parseAttendantConfig({ groups: { colleague: { cwd: h.home } } }, h.ctx);
    expect(profileFor(s, { id: 'c:a', handle: 'a', group: 'colleague' })).toBeNull();
    // enabled unless switched off
    mkdirSync(join(h.home, '.morse'), { recursive: true });
    expect(statusView({ MORSE_HOME: h.home }).enabled).toBe(true);
    writeFileSync(join(h.home, '.morse', 'config.json'), JSON.stringify({ plugins: { attendant: { enabled: false } } }));
    expect(statusView({ MORSE_HOME: h.home }).enabled).toBe(false);
  });
});

describe('launch: what claude / codex are started with', () => {
  it('Claude: restricted, no MCP, the hook, no prompts, never a bypass; the prompt after --', () => {
    const h = home();
    const p = parseAttendantConfig({ groups: { colleague: { cwd: h.work, tools: ['Read', 'Write'], allowedTools: ['Read'], model: 'sonnet', maxTurns: 12 } } }, h.ctx).groups['colleague']!;
    const args = claudeAttendantArgs({ profile: p, sessionId: null, newId: 'new-id', prompt: '--rm -rf', systemPrompt: 'rules' }, '/tmp/s.json');
    expect(args.slice(0, 13)).toEqual(['-p', '--output-format', 'json', '--restricted', '--strict-mcp-config', '--settings', '/tmp/s.json', '--tools', 'Read,Write', '--permission-mode', 'dontAsk', '--permission-prompts', 'none']);
    expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read', '--model', 'sonnet', '--max-turns', '12', '--session-id', 'new-id']));
    expect(args.slice(-2)).toEqual(['--', '--rm -rf']);
    expect(args.join(' ')).not.toMatch(/dangerously|bypass/);
    expect(claudeAttendantArgs({ profile: p, sessionId: 'old', newId: 'x', prompt: 'hi', systemPrompt: '' }, '/tmp/s.json')).toEqual(expect.arrayContaining(['--resume', 'old']));
  });

  it('Codex (opt-in): its sandbox, no user config or rules, never asks; NEEDS_APPROVAL lines are split off', () => {
    const h = home();
    const p = parseAttendantConfig({ groups: { partner: { agent: 'codex', cwd: h.work, allowUnscopedReads: true } } }, h.ctx).groups['partner']!;
    const args = codexAttendantArgs({ profile: p, sessionId: 'thread-1', prompt: 'hi' }, '/tmp/out.txt');
    expect(args).toEqual(['exec', '--json', '-o', '/tmp/out.txt', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-C', p.cwd, '-c', 'approval_policy="never"', 'resume', 'thread-1', 'hi']);
    expect(splitApprovals('Done.\nNEEDS_APPROVAL: git push origin main\n')).toEqual({ text: 'Done.', actions: ['git push origin main'] });
  });
});

describe('who gets answered: the group routing matrix', () => {
  it('a colleague is answered; with the default off, no profile, your own mail and strangers are stored only', async () => {
    const t = setup({ extra: { defaultProfile: false } });
    const own = t.mailbox.send({ from: { agent: 'claude', sessionId: 'a' }, to: { agent: 'codex', sessionId: 'b' }, text: 'internal' });
    const ownDevice = t.mailbox.send({ from: { agent: 'claude', sessionId: 's', device: 'me/air' }, to: { agent: 'mini', sessionId: 'inbox' }, text: 'from my laptop', fromTier: 'owner' });
    const alice = from(t.mailbox, 'alice', 'can you summarise the README?');
    label(t.mailbox, 'alice', 'colleague', 'Alice');
    const bob = from(t.mailbox, 'bob', 'hi'); // group "other": no profile
    const zed = from(t.mailbox, 'zed', 'hello');
    label(t.mailbox, 'zed', 'self'); // a contact labelled "self" is still not you
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(t.fake.calls[0]!.prompt).toContain('can you summarise the README?');
    expect(t.fake.calls[0]!.prompt).toContain('from Alice (morse.im/alice, group "colleague") — another address, not your owner');
    expect(t.mailbox.getMessage(alice.id)).toMatchObject({ processedBy: 'plugin:attendant' });
    const r = repliesTo(t.mailbox, 'alice');
    expect(r).toHaveLength(1);
    expect(r[0]!.parts[0]!.text).toBe(`Hello from the attendant\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`);
    expect(r[0]!.contextId).toBe(alice.contextId);
    for (const m of [own, ownDevice, bob, zed]) expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
    expect(repliesTo(t.mailbox, 'bob')).toHaveLength(0);
    // the session runs in the profile's directory with the plugin's own markers
    expect(t.fake.calls[0]!.env['MORSE_ATTENDANT_RUN']).toBeTruthy();
  });

  it('NOOP is a deliberate answer: marked processed, nothing sent', async () => {
    const t = setup({ script: () => ({ result: 'NOOP' }) });
    const m = from(t.mailbox, 'alice', 'thanks!');
    label(t.mailbox, 'alice', 'colleague');
    clock += 10_000;
    await t.engine.idle();
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
    expect(repliesTo(t.mailbox, 'alice')).toHaveLength(0);
  });

  it('mail from before the attendant was first on, or too old, is left for you', async () => {
    const t = setup({ extra: { maxAgeMin: 5 } });
    clock -= 60_000;
    const before = from(t.mailbox, 'alice', 'old one');
    clock += 60_000;
    label(t.mailbox, 'alice', 'colleague');
    const stale = from(t.mailbox, 'alice', 'stale');
    clock += 10 * 60_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(0);
    for (const m of [before, stale]) expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
  });
});

describe('one session per (agent, contact)', () => {
  it('alice and bob get separate sessions; alice\'s next message resumes hers', async () => {
    const t = setup();
    label(t.mailbox, 'alice', 'colleague');
    from(t.mailbox, 'alice', 'one');
    from(t.mailbox, 'bob', 'two');
    label(t.mailbox, 'bob', 'colleague');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(2);
    const sessions = t.state.read().sessions;
    expect(Object.keys(sessions).sort()).toEqual(['mini/c:alice', 'mini/c:bob']);
    expect(sessions['mini/c:alice']!.sessionId).not.toBe(sessions['mini/c:bob']!.sessionId);
    for (const c of t.fake.calls) expect(c.args).toContain('--session-id');
    from(t.mailbox, 'alice', 'three');
    clock += 10_000;
    await t.engine.idle();
    const third = t.fake.calls[2]!;
    expect(third.args[third.args.indexOf('--resume') + 1]).toBe(sessions['mini/c:alice']!.sessionId);
    expect(third.prompt).toContain('three');
    expect(third.prompt).not.toContain('two');
    expect(t.state.read().sessions['mini/c:alice']!.turns).toBe(2);
  });

  it('a session that is gone is started afresh for the same message (with the earlier exchange as context)', async () => {
    let n = 0;
    const t = setup({
      script: (c) => {
        n++;
        if (c.args.includes('--resume')) return { raw: { code: 1, stdout: '', stderr: 'Error: No conversation found with session ID: 00000000' } };
        return { result: `answer ${n}` };
      },
    });
    label(t.mailbox, 'alice', 'colleague');
    from(t.mailbox, 'alice', 'first');
    clock += 10_000;
    await t.engine.idle();
    const first = t.state.read().sessions['mini/c:alice']!.sessionId;
    from(t.mailbox, 'alice', 'second');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls.map((c) => (c.args.includes('--resume') ? 'resume' : 'new'))).toEqual(['new', 'resume', 'new']);
    const last = t.fake.calls[2]!;
    expect(last.prompt).toContain('Earlier messages with morse.im/alice');
    expect(last.prompt).toContain('first');
    expect(t.state.read().sessions['mini/c:alice']!.sessionId).not.toBe(first);
    expect(repliesTo(t.mailbox, 'alice').map((m) => m.parts[0]!.text.split('\n')[0])).toEqual(['answer 1', 'answer 3']);
  });
});

describe('guards', () => {
  it('a burst from one contact is one turn; the reply goes to the newest, all are processed', async () => {
    const t = setup({ coalesceSec: 3 });
    label(t.mailbox, 'alice', 'colleague');
    const a = from(t.mailbox, 'alice', 'part one');
    const b = from(t.mailbox, 'alice', 'part two');
    const c = from(t.mailbox, 'alice', 'part three');
    clock += 1000;
    await t.engine.tick();
    expect(t.fake.calls).toHaveLength(0); // still coalescing
    clock += 3000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(t.fake.calls[0]!.prompt).toMatch(/3 messages from morse\.im\/alice \(group "colleague"\)[\s\S]*part one[\s\S]*part two[\s\S]*part three/);
    const r = repliesTo(t.mailbox, 'alice');
    expect(r).toHaveLength(1);
    expect(r[0]!.contextId).toBe(c.contextId);
    for (const m of [a, b, c]) expect(t.mailbox.getMessage(m.id)?.processedAt).toBeDefined();
  });

  it('rate limit per contact: over it, messages are left for you (unprocessed) and you are told once', async () => {
    const t = setup({ groups: { colleague: { cwd: home().work, rateLimit: { perHour: 2, perDay: 10 } } } });
    label(t.mailbox, 'alice', 'colleague');
    for (const text of ['one', 'two', 'three', 'four']) {
      from(t.mailbox, 'alice', text);
      clock += 10_000;
      await t.engine.idle();
    }
    expect(t.fake.calls).toHaveLength(2);
    const left = t.mailbox.todo();
    expect(left.map((m) => m.parts[0]!.text)).toEqual(['three', 'four']);
    expect(t.os.filter((l) => l.includes('rate limit'))).toHaveLength(1);
    expect(t.logs.join('\n')).toMatch(/rate limit \(2 an hour\)/);
    // an hour later alice is answered again
    clock += 3_600_000;
    from(t.mailbox, 'alice', 'five');
    clock += 10_000;
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(3);
    expect(t.fake.calls[2]!.prompt).toContain('five');
  });

  it('ADR-068: no rate limit by default — every message from a contact is a turn (a group profile and the default profile)', async () => {
    for (const groups of [{ colleague: { cwd: home().work } }, {}]) {
      const t = setup({ groups });
      if (Object.keys(groups).length) label(t.mailbox, 'alice', 'colleague');
      for (let i = 0; i < 8; i++) {
        from(t.mailbox, 'alice', `message ${i}`); // a new thread each time: only the rate limit could stop these
        clock += 10_000;
        await t.engine.idle();
      }
      expect(t.fake.calls).toHaveLength(8);
      expect(t.mailbox.todo()).toHaveLength(0);
      expect(t.logs.join('\n')).not.toMatch(/rate limit/);
      expect(t.os.filter((l) => l.includes('rate limit'))).toHaveLength(0);
    }
  });

  it('ADR-068: a cap you set applies, each on its own; 0 means no limit (and lifts a group cap for one contact); anything else is an error', async () => {
    const h = home();
    const s = parseAttendantConfig(
      {
        groups: { colleague: { cwd: h.work, rateLimit: { perHour: 3 } }, team: { cwd: h.work, rateLimit: { perHour: 0, perDay: 0 } } },
        contacts: { alice: { group: 'colleague', rateLimit: { perHour: 0, perDay: 0 } } },
        defaultProfile: { rateLimit: { perDay: 50 } },
      },
      h.ctx,
    );
    expect(s.errors).toEqual([]);
    expect(s.groups['colleague']!.rate).toEqual({ perHour: 3, perDay: null });
    expect(s.groups['team']!.rate).toEqual({ perHour: null, perDay: null });
    expect(profileFor(s, { id: 'c:alice', handle: 'alice', group: 'colleague' })!.rate).toEqual({ perHour: null, perDay: null });
    expect(profileFor(s, { id: 'c:bob', handle: 'bob', group: 'colleague' })!.rate).toEqual({ perHour: 3, perDay: null });
    expect(s.defaultProfile!.rate).toEqual({ perHour: null, perDay: 50 });
    for (const bad of [{ perHour: 'off' }, { perHour: -1 }, { perDay: 1.5 }, { perHour: null }, 'off']) {
      const e = parseAttendantConfig({ groups: { colleague: { cwd: h.work, rateLimit: bad } } }, h.ctx);
      expect(e.groups['colleague']).toBeUndefined();
      expect(e.errors.join('\n')).toMatch(/rateLimit.* this profile is off/);
    }
    // a perDay cap alone stops the third turn of the day
    const t = setup({ groups: { colleague: { cwd: home().work, rateLimit: { perDay: 2 } } } });
    label(t.mailbox, 'alice', 'colleague');
    for (const text of ['one', 'two', 'three']) {
      from(t.mailbox, 'alice', text);
      clock += 10_000;
      await t.engine.idle();
    }
    expect(t.fake.calls).toHaveLength(2);
    expect(t.logs.join('\n')).toMatch(/rate limit \(2 a day\)/);
  });

  it('ADR-072: no turn cap by default — another attendant\'s automatic reply goes to the agent, marker and all', async () => {
    // the default profile: each automatic reply is a turn; the agent sees the marker and the rule about it
    const t = setup({ groups: {} });
    const first = from(t.mailbox, 'alice', `Reply 0.\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`);
    for (let i = 0; i < 15; i++) {
      if (i) from(t.mailbox, 'alice', `Reply ${i}.\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`, { contextId: first.contextId });
      clock += 10_000;
      await t.engine.idle();
    }
    expect(t.fake.calls).toHaveLength(15); // past the old 10 a day, past the old depth of 12
    expect(t.fake.calls[0]!.prompt).toContain(ATTENDANT_TOKEN);
    expect(t.fake.calls[0]!.args[t.fake.calls[0]!.args.indexOf('--append-system-prompt') + 1]).toMatch(/another agent's automatic reply\. Decide yourself/);
    expect(t.logs.join('\n')).not.toMatch(/thread limit|answerAttendants|rate limit/);
    expect(parseAttendantConfig({}, home().ctx).defaultProfile).toMatchObject({ answerAttendants: true, maxTurnsPerContext: null });
  });

  it('ADR-072: the owner can still set them — answerAttendants: false keeps automatic replies for you; maxTurnsPerContext caps a thread', async () => {
    const t = setup();
    label(t.mailbox, 'alice', 'colleague');
    const t0 = setup({ groups: { colleague: { cwd: home().work, answerAttendants: false } } });
    label(t0.mailbox, 'alice', 'colleague');
    const auto = from(t0.mailbox, 'alice', `Sure.\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`);
    clock += 10_000;
    await t0.engine.idle();
    expect(t0.fake.calls).toHaveLength(0);
    expect(t0.mailbox.getMessage(auto.id)?.processedAt).toBeUndefined();
    expect(t0.logs.join('\n')).toMatch(/answerAttendants: false/);
    expect(t.settings.groups['colleague']).toMatchObject({ answerAttendants: true, maxTurnsPerContext: null });

    const u = setup({ groups: { colleague: { cwd: home().work, maxTurnsPerContext: 2 } } });
    label(u.mailbox, 'alice', 'colleague');
    const first = from(u.mailbox, 'alice', `ping ${ATTENDANT_TOKEN}`);
    for (let i = 0; i < 3; i++) {
      if (i) from(u.mailbox, 'alice', `ping ${i} ${ATTENDANT_TOKEN}`, { contextId: first.contextId });
      clock += 10_000;
      await u.engine.idle();
    }
    expect(u.fake.calls).toHaveLength(2);
    expect(u.logs.join('\n')).toMatch(/thread limit reached/);
    // 0 = no limit; a bad value switches only that profile off
    expect(parseAttendantConfig({ groups: { g: { cwd: home().work, maxTurnsPerContext: 0 } } }, home().ctx).groups['g']!.maxTurnsPerContext).toBeNull();
    expect(parseAttendantConfig({ groups: { g: { cwd: home().work, maxTurnsPerContext: -1 } } }, home().ctx).errors.join()).toMatch(/maxTurnsPerContext/);
    expect(parseAttendantConfig({ defaultProfile: { answerAttendants: false, maxTurnsPerContext: 5 } }, home().ctx).defaultProfile).toMatchObject({ answerAttendants: false, maxTurnsPerContext: 5 });
  });

  it('failures: retried with a backoff, given up after 3 tries (left for you); a timeout is final at once', async () => {
    const t = setup({ script: () => ({ raw: { code: 1, stdout: '', stderr: 'boom' } }) });
    label(t.mailbox, 'alice', 'colleague');
    const m = from(t.mailbox, 'alice', 'hello');
    for (let i = 0; i < 5; i++) {
      clock += 200_000;
      await t.engine.idle();
    }
    expect(t.fake.calls).toHaveLength(3);
    expect(t.state.read().messages[m.id]).toMatchObject({ state: 'failed', attempts: 3 });
    expect(t.mailbox.getMessage(m.id)?.processedAt).toBeUndefined();
    expect(t.fake.calls[1]!.prompt).toContain('may be a retry');

    const u = setup({ script: () => ({ raw: { code: 124, stdout: '', stderr: '\ntimeout after 600000ms' } }) });
    label(u.mailbox, 'alice', 'colleague');
    from(u.mailbox, 'alice', 'slow');
    for (let i = 0; i < 3; i++) {
      clock += 200_000;
      await u.engine.idle();
    }
    expect(u.fake.calls).toHaveLength(1);
  });

  it('restart recovery: a turn that was running when the plugin stopped is run again, marked as a possible retry', async () => {
    const t = setup();
    label(t.mailbox, 'alice', 'colleague');
    const m = from(t.mailbox, 'alice', 'do the thing');
    t.state.update((s) => {
      s.messages[m.id] = { state: 'running', at: clock, attempts: 1 };
    });
    // a new plugin process
    const again = t.mk();
    expect(again.recover()).toBe(1);
    clock += 10_000;
    await again.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(t.fake.calls[0]!.prompt).toContain('may be a retry');
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
  });

  it('attachments: only regular files the core received are copied into the working directory', () => {
    const h = home();
    const good = join(h.inbox, 'msg1', 'notes.txt');
    mkdirSync(join(h.inbox, 'msg1'), { recursive: true });
    writeFileSync(good, 'hello');
    const outside = join(h.root, 'elsewhere.txt');
    writeFileSync(outside, 'not received');
    const link = join(h.inbox, 'msg1', 'link.txt');
    symlinkSync(join(h.home, '.ssh', 'id_test'), link);
    const big = join(h.inbox, 'msg1', 'big.bin');
    writeFileSync(big, Buffer.alloc(2048));
    const files = [good, outside, link, big].map((p) => ({ name: p.split('/').pop()!, path: p, size: 1 }));
    const out = stageAttachments({ id: 'abcdef0123456789', files }, h.work, h.inbox, 1024);
    expect(out[0]).toBe('.morse-attachments/abcdef012345/notes.txt');
    expect(readFileSync(join(h.work, out[0]!), 'utf8')).toBe('hello');
    expect(out[1]).toMatch(/elsewhere\.txt: not available \(not a received file\)/);
    expect(out[2]).toMatch(/link\.txt: not available \(not a regular file\)/);
    expect(out[3]).toMatch(/big\.bin: not available \(larger than 1024 bytes\)/);
    expect(readFileSync(join(h.work, '.morse-attachments', '.gitignore'), 'utf8')).toBe('*\n');
  });
});

describe('approvals (ADR-060)', () => {
  it('end to end: deny -> request -> waiting reply -> approve (a person, not an agent) -> re-run with that one action allowed', async () => {
    const push = { tool: 'Bash', input: { command: 'git push origin main' } };
    const t = setup({
      groups: { colleague: { cwd: home().work, tools: ['Read', 'Bash'], allowedTools: ['Bash(git status:*)'] } },
      script: (c) =>
        c.prompt.includes('approved request')
          ? { tools: [push, push], result: (call) => `pushed (${call.executed.length} run, ${call.denied.length} refused)` }
          : { tools: [{ tool: 'Read', input: { file_path: 'README.md' } }, push], result: 'I am waiting for my owner\'s approval.' },
    });
    label(t.mailbox, 'alice', 'colleague', 'Alice');
    const m = from(t.mailbox, 'alice', 'please push the fix');
    clock += 10_000;
    await t.engine.idle();
    const first = t.fake.calls[0]!;
    expect(first.executed.map((c) => c.tool)).toEqual(['Read']);
    expect(first.denied).toEqual([push]);
    expect(first.reasons[0]).toMatch(/needs your owner's approval \(request [0-9a-f]{8}\)/);
    const pending = t.approvals.list();
    expect(pending).toHaveLength(1);
    const a = pending[0]!;
    expect(a).toMatchObject({ status: 'pending', tool: 'Bash', key: 'git push origin main', pattern: 'Bash(git push*)', replyTo: m.id, contact: { id: 'c:alice', group: 'colleague' } });
    // the contact hears "waiting", the message is processed, the owner is told (OS + WeChat)
    expect(repliesTo(t.mailbox, 'alice').map((r) => r.parts[0]!.text)).toEqual([`This needs my approval first — my agent will get back to you once I have decided.\n\n— ${ATTENDANT_TOKEN} Automatic reply from my agent.`]);
    expect(t.mailbox.getMessage(m.id)?.processedBy).toBe('plugin:attendant');
    expect(t.os.some((l) => l.includes(`morse plugin attendant approve ${a.id}`))).toBe(true);
    expect(t.core.notices.some((l) => l.includes('Alice (colleague) is waiting for your approval'))).toBe(true);

    // an agent can never approve; nor can anything without a terminal
    const tty = { stdin: true, stdout: true };
    const yes = async () => true;
    expect(await decide(t.approvals, a.id, 'approved', { env: { CLAUDECODE: '1' }, tty, confirm: yes, now })).toMatchObject({ ok: false, message: expect.stringMatching(/inside an AI agent \(CLAUDECODE/) });
    expect(await decide(t.approvals, a.id, 'approved', { env: { MORSE_ATTENDANT_RUN: 'x' }, tty, confirm: yes, now })).toMatchObject({ ok: false });
    expect(await decide(t.approvals, a.id, 'approved', { env: {}, tty: { stdin: false, stdout: true }, confirm: yes, now })).toMatchObject({ ok: false, message: expect.stringMatching(/not an interactive terminal/) });
    expect(await decide(t.approvals, a.id, 'approved', { env: {}, tty, confirm: async () => false, now })).toMatchObject({ ok: false, message: 'nothing changed' });
    expect(t.approvals.get(a.id)?.status).toBe('pending');
    expect(await decide(t.approvals, a.id, 'approved', { env: {}, tty, confirm: yes, now })).toMatchObject({ ok: true });

    clock += 1000;
    await t.engine.idle();
    const rerun = t.fake.calls[1]!;
    expect(rerun.args[rerun.args.indexOf('--resume') + 1]).toBe(t.state.read().sessions['mini/c:alice']!.sessionId);
    expect(rerun.prompt).toContain(`Your owner approved request ${a.id}: Bash git push origin main`);
    // exactly once: the second identical call is refused again (and asks again)
    expect(rerun.executed).toEqual([push]);
    expect(rerun.denied).toEqual([push]);
    expect(t.approvals.get(a.id)).toMatchObject({ status: 'done' });
    const texts = repliesTo(t.mailbox, 'alice').map((r) => r.parts[0]!.text.split('\n')[0]);
    expect(texts[1]).toMatch(/This needs my approval first/); // the second push asked again
    expect(t.approvals.list().filter((x) => x.status === 'pending')).toHaveLength(1);
    // nothing runs twice
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(2);
  });

  it('reject: the contact is told; nothing is run', async () => {
    const t = setup({ script: () => ({ tools: [{ tool: 'WebFetch', input: { url: 'https://example.com/post' } }], result: 'waiting' }) });
    label(t.mailbox, 'alice', 'colleague');
    from(t.mailbox, 'alice', 'post this');
    clock += 10_000;
    await t.engine.idle();
    const a = t.approvals.list()[0]!;
    expect(a).toMatchObject({ tool: 'WebFetch', pattern: 'WebFetch' });
    expect(await decide(t.approvals, a.id, 'rejected', { env: {}, tty: { stdin: true, stdout: true }, confirm: async () => true, now })).toMatchObject({ ok: true });
    await t.engine.idle();
    expect(t.fake.calls).toHaveLength(1);
    expect(repliesTo(t.mailbox, 'alice').map((r) => r.parts[0]!.text.split('\n')[0])).toEqual(['This needs my approval first — my agent will get back to you once I have decided.', 'Sorry, I did not approve that request.']);
    expect(t.approvals.get(a.id)).toMatchObject({ status: 'rejected', closedAt: expect.any(Number) });
  });

  it('the hook: private places are refused outright, ordinary calls get no opinion, unknown runs are refused', () => {
    const h = home();
    const store = createApprovalStore(join(h.home, '.morse', 'plugins', 'attendant'));
    const p = parseAttendantConfig({ groups: { colleague: { cwd: h.work } } }, h.ctx).groups['colleague']!;
    const run = { runId: 'run-0001', lane: 'mini/c:alice', agent: 'mini', contact: { id: 'c:alice', handle: 'alice', remark: null, group: 'colleague' }, messageIds: ['m1'], replyTo: 'm1', cwd: h.work, approvals: p.approvals, denyPaths: p.denyPaths };
    store.writeRun(run);
    const ask = (tool: string, input: Record<string, unknown>) => decidePreTool({ tool_name: tool, tool_input: input }, store.readRun('run-0001'), store, h.home);
    expect(ask('Read', { file_path: join(h.home, '.ssh', 'id_test') })).toMatchObject({ decision: 'deny', reason: expect.stringMatching(/private material/) });
    expect(ask('Bash', { command: 'cat ~/.ssh/id_test' })).toMatchObject({ decision: 'deny' });
    expect(ask('Grep', { pattern: 'x', path: join(h.home, '.morse') })).toMatchObject({ decision: 'deny' });
    expect(ask('Read', { file_path: join(h.work, 'README.md') })).toEqual({ decision: null });
    expect(ask('Bash', { command: 'cd /tmp && rm -rf build' })).toMatchObject({ decision: 'deny', approval: { pattern: 'Bash(rm *)' } });
    expect(ask('mcp__mail__send', { to: 'x' })).toMatchObject({ decision: 'deny', approval: { pattern: 'mcp__*' } });
    expect(decidePreTool({ tool_name: 'Read', tool_input: {} }, null, store, h.home)).toMatchObject({ decision: 'deny' });
    expect(store.list().map((a) => a.tool).sort()).toEqual(['Bash', 'mcp__mail__send']);
  });

  it('matching helpers and the human check', () => {
    expect(subCommands('git status && git push origin; echo $(rm -rf x)')).toEqual(['git status', 'git push origin', 'echo', 'rm -rf x']);
    expect(matchPattern(['Bash(git push*)'], 'Bash', 'git add . && git push')).toBe('Bash(git push*)');
    expect(matchPattern(['Bash(git push*)'], 'Bash', 'git status')).toBeNull();
    expect(matchPattern(['Write'], 'Write', '/x')).toBe('Write');
    expect(actionKey('Write', { file_path: '/a/../b.txt', content: 'x' })).toBe('/b.txt');
    expect(touchesDenied('Bash', { command: 'ls $HOME/.ssh' }, ['/h/.ssh'], '/h')).toBe('/h/.ssh');
    expect(humanCheck({}, { stdin: true, stdout: true })).toBeNull();
    expect(humanCheck({ CODEX_SANDBOX: 'seatbelt' }, { stdin: true, stdout: true })).toMatch(/CODEX_SANDBOX/);
  });

  it('a hook that cannot read its input refuses (fails closed)', async () => {
    const h = home();
    const out = await hookPreTool(['--run', 'run-x', '--state', join(h.root, 'state')], 'not json', {}, h.home);
    expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
  });
});

describe('the plugin is built in and on by default', () => {
  it('only imports the plugin contract and shared libraries — never the mailbox, the cluster or the daemon core', () => {
    const dir = join(__dirname, '..', 'src/plugins/attendant');
    const allowed = /^(\.\/|\.\.\/\.\.\/(adapters|envelope|file-lock|home|plugin\/(contract|cli-client|lane-lock)|daemon\/notify)\b)/;
    for (const f of readdirSync(dir)) {
      for (const [, spec] of readFileSync(join(dir, f), 'utf8').matchAll(/from '([^']+)'|import\('([^']+)'\)/g)) {
        if (!spec || spec.startsWith('node:')) continue;
        expect(spec, `${f} imports ${spec}`).toMatch(allowed);
      }
    }
  });

  it('pluginSpecs: attendant is on unless disabled (ADR-066); an own command replaces it', () => {
    const b = { dispatch: ['d'], ilink: ['i'], attendant: ['a', 'run'] };
    expect(pluginSpecs({}, b).find((p) => p.name === 'attendant')).toMatchObject({ enabled: true, builtin: true, argv: ['a', 'run'] });
    expect(pluginSpecs(undefined, b).find((p) => p.name === 'attendant')).toMatchObject({ enabled: true });
    expect(pluginSpecs({ attendant: { enabled: false } }, b).find((p) => p.name === 'attendant')).toMatchObject({ enabled: false, builtin: true });
    expect(pluginSpecs({ attendant: { enabled: true } }, b).find((p) => p.name === 'attendant')).toMatchObject({ enabled: true, builtin: true });
    expect(pluginSpecs({ attendant: { command: 'my-own', enabled: true } }, b).filter((p) => p.name === 'attendant')).toEqual([{ name: 'attendant', argv: ['/bin/sh', '-c', 'my-own'], enabled: true, builtin: false }]);
  });
});

describe('morse attendant status', () => {
  it('shows profiles (and errors), sessions, approvals waiting, launches', async () => {
    const t = setup({ script: () => ({ tools: [{ tool: 'Bash', input: { command: 'git push' } }], result: 'waiting' }), groups: { colleague: { cwd: home().work, tools: ['Read', 'Bash'] } } });
    label(t.mailbox, 'alice', 'colleague');
    from(t.mailbox, 'alice', 'push it');
    clock += 10_000;
    await t.engine.idle();
    writeFileSync(join(t.home, '.morse', 'config.json'), JSON.stringify({ plugins: { attendant: { enabled: true, groups: { colleague: { cwd: t.work }, broken: { cwd: t.home } } }, ilink: { enabled: true } } }));
    const v = statusView({ MORSE_HOME: t.home }, clock);
    expect(v).toMatchObject({ enabled: true, notifyWechat: true, sessions: [{ lane: 'mini/c:alice', runtime: 'claude', turns: 1 }], approvals: [{ tool: 'Bash', key: 'git push', status: 'pending' }], rateLimits: [{ contact: 'c:alice', hour: 1, day: 1 }] });
    expect(v.profiles.map((p) => p.where)).toEqual(['plugins.attendant.groups.colleague', 'plugins.attendant.groups.broken']);
    expect(v.defaultProfile).toMatchObject({ model: 'sonnet', tools: [], rateLimit: { perHour: null, perDay: null } });
    expect(v.errors.join('\n')).toMatch(/groups\.broken: "cwd" .*this profile is off/);
  });

  it('ADR-068: a rate limit reads "no limit" when there is none', () => {
    expect(rateText({ perHour: null, perDay: null })).toBe('no limit');
    expect(rateText({ perHour: 10, perDay: null })).toBe('10/h');
    expect(rateText({ perHour: null, perDay: 50 })).toBe('50/day');
    expect(rateText({ perHour: 6, perDay: 30 })).toBe('6/h 30/day');
  });
});
