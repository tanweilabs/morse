import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from './home.js';
import { realExec } from './adapters/exec.js';
import { createDb, defaultDbPath } from './mailbox/db.js';
import { isWindows } from './platform/platform.js';
import { isOurHookEntry } from './setup.js';

/** One line of `morse status --check`: ✓ or ✗, what was checked, what was found. */
type Check = { name: string; ok: boolean; note: string };

const DOORBELL = 'claude doorbell (crossSessionInbound)';
type DoorbellState = 'refuse' | 'accept' | 'bypass' | 'unset';
const DOORBELL_NOTES: Record<DoorbellState, string> = {
  refuse:
    '"refuse" — running Claude sessions drop the doorbell; mail waits for the next prompt. Set it to "accept" in ~/.claude/settings.json to deliver immediately',
  accept: '"accept" — running sessions wake on new mail',
  bypass:
    'OFF — your sessions default to Bypass permissions, which hold peer messages, so the daemon does not ring; mail arrives on the next prompt as before. To have running sessions wake on new mail, set "crossSessionInbound": "accept" in ~/.claude/settings.json',
  unset:
    'unset — wakes sessions that prompt for permissions; a session in Bypass permissions holds the doorbell (mail then arrives on its next prompt). Set "crossSessionInbound": "accept" in ~/.claude/settings.json if you want those woken too',
};

/**
 * Can the doorbell wake a running Claude session (ADR-027)? Claude Code holds a message from another session
 * for approval when the receiver bypasses permission prompts, and the desktop App cannot show that dialog, so
 * the ring is lost — the prompt hook still delivers on the next prompt; `accept` makes it immediate. Only
 * "refuse" is a failed check. The setting is the owner's to change: this only reports it.
 */
export function crossSessionInboundCheck(settings: { crossSessionInbound?: unknown; permissions?: { defaultMode?: unknown } } | null): Check {
  const chosen = settings?.crossSessionInbound;
  const state: DoorbellState =
    chosen === 'refuse' || chosen === 'accept' ? chosen : settings?.permissions?.defaultMode === 'bypassPermissions' ? 'bypass' : 'unset';
  return { name: DOORBELL, ok: state !== 'refuse', note: DOORBELL_NOTES[state] };
}

/** How many session folders under `root` hold an `unread` entry; 0 when there is no such folder. */
function sessionsWithUnread(root: string): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  return entries.filter((entry) => existsSync(join(root, entry, 'unread'))).length;
}

/**
 * ZCode's own mailbox (ADR-029), reported only where ZCode is installed. A runtime started with the flag
 * creates `<root>/<session>/unread` on every turn — those folders are ZCode's own record that it is on.
 */
export function zcodeMailboxCheck(root: string, zcodeInstalled: boolean): Check | null {
  if (!zcodeInstalled) return null;
  const seen = sessionsWithUnread(root);
  const note = seen
    ? `on — ${seen} session(s) have run with ZCode's mailbox; mail to a session mid-turn lands at its next tool call`
    : 'off — a ZCode session that is mid-turn gets a second, headless turn instead (the old behaviour). To turn it on: launchctl setenv ZCODE_MESSAGE_ENABLED 1, then quit and reopen ZCode (lasts until reboot)';
  return { name: 'zcode doorbell (session mailbox)', ok: true, note };
}

/** Where `cmd` is on the PATH, or null. */
async function onPath(cmd: string): Promise<string | null> {
  const found = await realExec('which', [cmd], { timeoutMs: 5000 });
  return found.code === 0 ? found.stdout.trim() : null;
}

/** The agent CLIs Morse delivers through, and the folders it finds their sessions in. */
async function agentChecks(home: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const cli of ['claude', 'codex']) {
    const path = await onPath(cli);
    checks.push({ name: `${cli} CLI`, ok: path !== null, note: path ?? `not found — ${cli} sessions cannot be delivered to` });
    if (cli === 'codex' && path !== null) {
      // ADR-027: a live Codex Desktop thread is reached through `codex queue` (CLI 0.149+)
      const queue = await realExec('codex', ['queue', '--help'], { timeoutMs: 10_000 });
      checks.push({ name: 'codex queue (live Desktop threads)', ok: queue.code === 0, note: queue.code === 0 ? 'supported' : 'missing — upgrade: npm i -g @openai/codex@latest' });
    }
  }
  const present: Array<[name: string, path: string]> = [
    ['claude sessions', '.claude/projects'],
    ['codex sessions', '.codex/sessions'],
    ['codex auth (file-based, auto-delivery ready)', '.codex/auth.json'],
  ];
  for (const [name, path] of present) checks.push({ name, ok: existsSync(join(home, ...path.split('/'))), note: `~/${path}` });
  return checks;
}

function mailboxCheck(): Check {
  try {
    createDb(defaultDbPath()).prepare('SELECT 1').get();
    return { name: 'mailbox db', ok: true, note: defaultDbPath() };
  } catch (e) {
    return { name: 'mailbox db', ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/** 闪电说, a desktop-App agent (ADR-024) — only where the app is installed: its absence is nothing to report. */
async function sdsCheck(home: string): Promise<Check | null> {
  const { resolveSdsPaths, detectSds } = await import('./integrations/sds.js');
  const sds = detectSds(resolveSdsPaths({ home }));
  if (!sds.appInstalled) return null;
  let note = 'run: morse connect sds --apply';
  if (sds.skillEnabled) note = 'connected — registers as @sds and pulls over HTTP';
  else if (sds.skillInstalled) note = 'skill present but DISABLED in 闪电说 — re-run: morse connect sds --apply';
  return { name: '闪电说 assistant (external agent)', ok: sds.skillEnabled, note };
}

/** The key of the first address (ADR-028; since ADR-091 there are no paired devices): readable by its owner only. */
async function keyCheck(home: string): Promise<Check> {
  const name = 'key of the first address';
  try {
    const { loadOrCreateIdentity, shortDeviceId } = await import('./cluster/identity.js');
    const identity = loadOrCreateIdentity();
    const mode = statSync(join(dataDir(home), 'identity', 'key.pem')).mode & 0o777;
    if (mode === 0o600) return { name, ok: true, note: `${shortDeviceId(identity.id)}… — readable by you only` };
    return { name, ok: false, note: `private key is readable by others (mode ${mode.toString(8)}) — run: chmod 600 ~/.morse/identity/key.pem` };
  } catch (e) {
    return { name, ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

type ClaudeSettings = { hooks?: Record<string, Array<{ hooks: Array<{ command?: unknown; args?: unknown; commandWindows?: unknown }> }>>; crossSessionInbound?: unknown; permissions?: { defaultMode?: unknown } };

/** Is our UserPromptSubmit hook in Claude's settings — in any form an install of ours ever wrote? */
function hasInboxHook(settings: ClaudeSettings | null): boolean {
  const ours = (h: { command?: unknown }): boolean =>
    (typeof h.command === 'string' && / hook claude-prompt-submit$/.test(h.command.trim())) || isOurHookEntry(h, 'claude-prompt-submit');
  try {
    return settings?.hooks?.['UserPromptSubmit']?.some((matcher) => matcher.hooks.some(ours)) ?? false;
  } catch {
    return false; // a settings file of another shape
  }
}

/** What the push into running sessions depends on (not on Windows in this release). */
async function deliveryChecks(home: string): Promise<Check[]> {
  const checks = [await keyCheck(home)];
  const { mailboxRoot } = await import('./adapters/zcode-mailbox.js');
  const zcode = zcodeMailboxCheck(mailboxRoot(), existsSync('/Applications/ZCode.app') || existsSync(join(home, '.zcode')));
  if (zcode) checks.push(zcode);
  let settings: ClaudeSettings | null = null;
  try {
    settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')) as ClaudeSettings | null;
  } catch {
    /* no settings file: no hook */
  }
  const hooked = hasInboxHook(settings);
  checks.push({ name: 'claude inbox hook', ok: hooked, note: hooked ? 'UserPromptSubmit registered' : 'run: morse setup' });
  checks.push(crossSessionInboundCheck(settings));
  return checks;
}

const LOGIN_NOTE = `\nnote: claude CLI login state cannot be checked offline; if deliveries fail with "Not logged in", run \`claude\` once to log in (see ADR-008).`;

/**
 * `morse status --check` (was `morse doctor`): is this computer ready for Morse? Prints one line per check;
 * true when every one passed. ADR-080: on Windows the checks that assume `which`, POSIX file modes, launchd or
 * a push into sessions would be false alarms — platform/doctor-win.ts has the Windows ones instead.
 */
export async function runDoctor(): Promise<boolean> {
  const home = homedir();
  const win = isWindows();
  const checks: Check[] = win ? [] : await agentChecks(home);
  checks.push(mailboxCheck());
  const skill = existsSync(join(home, '.claude', 'skills', 'morse', 'SKILL.md'));
  checks.push({ name: 'skill installed', ok: skill, note: skill ? '~/.claude/skills/morse' : 'run: morse setup' });
  const sds = await sdsCheck(home);
  if (sds) checks.push(sds);
  if (win) {
    const { windowsDoctorChecks } = await import('./platform/doctor-win.js');
    checks.push(...windowsDoctorChecks({ home, dataDir: dataDir() }));
  } else {
    checks.push(...(await deliveryChecks(home)));
  }

  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.note}`);
  // (the note is about pushing into sessions — not in this release on Windows)
  if (!win) console.log(LOGIN_NOTE);
  return checks.every((c) => c.ok);
}
