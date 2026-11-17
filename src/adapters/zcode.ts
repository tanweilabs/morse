import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultConfigFile, readMachineConfig } from '../machine-config.js';
import { DEFAULT_TURN_MS, locateCli, ownerTurnBudgetMs, runOptions, shortTitle, tailOf } from './common.js';
import { realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';
import { isSessionBusy, mailboxEnabledFor, mailboxRoot, postToMailbox, readZcodeDb, reclaimMail, type MailboxEnvelope } from './zcode-mailbox.js';

interface ZcodeSetup {
  dbFile?: string;
  engineBin?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
  /** Morse machine config (~/.morse/config.json): where the owner sets mode and time limit. */
  configFile?: string;
  /** Root of ZCode's session mailboxes (ADR-029); default ZCODE_MAILBOX_ROOT or ~/.zcode/mailbox. */
  mailboxRoot?: string;
  /** Is a turn running in the session right now? Default: ask ZCode's message table. */
  isBusy?: (sessionId: string) => boolean;
  /** Interval between checks whether ZCode has taken a posted letter. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Route = 'mailbox' | 'resume';

/** replyChannel() runs just before deliver(): both must see the same route for one message. */
const ROUTE_REUSE_MS = 5_000;
/** The one id written into the letters' `fromSessionId` — ZCode reads it, so it stays as older releases wrote it (ADR-075). */
const LETTER_SENDER = 'anytoany';

/**
 * Permission modes for headless turns. Without the owner's say-so it is 'build': safe, but
 * tools that need a confirmation are refused when nobody is there to confirm, so the turn is
 * in effect read-only. Only the machine owner can raise it, in ~/.morse/config.json
 * (`{"zcode": {"deliverMode": "yolo"}}`) — never the sender. Note that ZCode's own headless
 * default is yolo, which is why the mode is always passed explicitly.
 */
const MODES = new Set(['plan', 'edit', 'build', 'yolo']);
const SAFE_MODE = 'build';

/** ZCode's own database. Deliberately not ZCODE_DATA_BASE_DIR: in engine 0.15.2 that moves only the credentials (checked). */
const zcodeDb = (): string => join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

/** The engine: MORSE_ZCODE_BIN (or its old name ANYTOANY_ZCODE_BIN, ADR-075), PATH, then the one inside the desktop App. */
const findEngine = (): string | null =>
  locateCli({
    envNames: ['MORSE_ZCODE_BIN', 'ANYTOANY_ZCODE_BIN'],
    command: 'zcode',
    installed: () => '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
  });

/** The owner's settings are read fresh for each delivery, so an edit applies without a restart. */
function ownerMode(configFile: string): string {
  const mode = readMachineConfig(configFile).zcode?.deliverMode;
  return mode !== undefined && MODES.has(mode) ? mode : SAFE_MODE;
}

function ownerBudgetMs(configFile: string): number | null {
  return ownerTurnBudgetMs(readMachineConfig(configFile).zcode?.deliverTimeoutSec);
}

/**
 * Command and argv for a headless resume. A `.cjs`/`.js` engine (the App's) is a node
 * script. 0.15.2 lists --max-turns/--settings in its help but its parser rejects both
 * (checked), so the exec time limit is what bounds a turn.
 */
function resumeCommand(engine: string, session: SessionInfo, mode: string, prompt: string): [string, string[]] {
  const flags = [
    ...(session.cwd ? ['--cwd', session.cwd] : []),
    '--resume', session.sessionId,
    '--mode', mode,
    '--prompt', prompt,
  ];
  const isScript = /\.c?js$/.test(engine);
  return isScript ? ['node', [engine, ...flags]] : [engine, flags];
}

/** A row of ZCode's `session` table, typed loosely so a new ZCode schema does not break the scan. */
interface SessionRow {
  id?: unknown;
  parent_id?: unknown;
  title?: unknown;
  directory?: unknown;
  task_type?: unknown;
  time_updated?: unknown;
}

/** Sub-agent sessions are driven by their parent and cannot take messages; ZCode marks them three ways. */
function isSubagent(row: SessionRow & { id: string }): boolean {
  return row.id.startsWith('sess_subagent') || (typeof row.parent_id === 'string' && row.parent_id !== '') || row.task_type === 'subagent_child';
}

function toSession(row: SessionRow & { id: string }): SessionInfo {
  const cwd = typeof row.directory === 'string' ? row.directory : '';
  const named = typeof row.title === 'string' ? row.title.trim() : '';
  return {
    agent: 'zcode',
    sessionId: row.id,
    title: shortTitle(named || basename(cwd) || 'untitled'),
    cwd,
    lastActiveAt: typeof row.time_updated === 'number' ? row.time_updated : 0,
  };
}

/** Every addressable session in the db, most recent first; [] without a usable db (no ZCode here). */
function readSessions(dbFile: string): SessionInfo[] {
  return readZcodeDb(dbFile, [], (db) =>
    (db.prepare('SELECT * FROM session').all() as SessionRow[])
      .filter((row): row is SessionRow & { id: string } => typeof row.id === 'string' && row.id !== '')
      .filter((row) => !isSubagent(row))
      .map(toSession)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
  );
}

export function createZcodeAdapter(setup: ZcodeSetup = {}): DeliveryAdapter {
  const dbFile = setup.dbFile ?? zcodeDb();
  const exec = setup.exec ?? realExec;
  const configFile = setup.configFile ?? defaultConfigFile();
  const root = setup.mailboxRoot ?? mailboxRoot();
  const busy = setup.isBusy ?? ((sessionId: string) => isSessionBusy(dbFile, sessionId));
  const pollMs = setup.pollMs ?? 1_000;
  const sleep = setup.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const decided = new Map<string, { route: Route; until: number }>();

  /**
   * ADR-029: while a session with the mailbox on is in the middle of a turn, the message
   * goes into its mailbox — ZCode takes it at the next tool call or at the end of the turn —
   * rather than starting a second headless turn on the same session alongside it.
   */
  function routeFor(session: SessionInfo): Route {
    const now = Date.now();
    const earlier = decided.get(session.sessionId);
    if (earlier && now < earlier.until) return earlier.route;
    const route: Route = mailboxEnabledFor(root, session.sessionId) && busy(session.sessionId) ? 'mailbox' : 'resume';
    decided.set(session.sessionId, { route, until: now + ROUTE_REUSE_MS });
    return route;
  }

  const inSession: DeliveryResult = { ok: true, output: '', inSession: true };

  /**
   * Post the letter and wait for ZCode to take it. Gives null when it should go the headless
   * way after all: the letter could not be written, or it was taken back unread because the
   * turn ended (say the flag was switched off meanwhile) or the budget ran out.
   */
  async function viaMailbox(session: SessionInfo, envelope: string, budgetMs: number): Promise<DeliveryResult | null> {
    const stamp = new Date().toISOString();
    const outgoing: MailboxEnvelope = { messageId: randomUUID(), fromSessionId: LETTER_SENDER, toSessionId: session.sessionId, content: envelope, createdAt: stamp };
    let letter: string;
    try {
      letter = postToMailbox(root, outgoing);
    } catch {
      return null;
    }
    const giveUpAt = Date.now() + budgetMs;
    for (let waiting = true; waiting; ) {
      await sleep(pollMs);
      if (!existsSync(letter)) return { ...inSession };
      waiting = busy(session.sessionId) && Date.now() <= giveUpAt;
    }
    // whoever renames the letter first has it: if ZCode beat us to it, it is delivered
    return reclaimMail(letter) ? null : { ...inSession };
  }

  return {
    agent: 'zcode',
    // a mailbox delivery has no stdout to find a reply marker in: the agent answers with `anyd reply`
    replyChannel: (session: SessionInfo) => (routeFor(session) === 'mailbox' ? 'command' : 'marker'),

    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      const budgetMs = setup.deliverTimeoutMs ?? ownerBudgetMs(configFile) ?? DEFAULT_TURN_MS;
      if (routeFor(session) === 'mailbox') {
        const delivered = await viaMailbox(session, envelope, budgetMs);
        if (delivered) return delivered;
      }
      const engine = setup.engineBin ?? findEngine();
      if (!engine) return { ok: false, error: 'zcode engine not found — install the ZCode desktop app or set MORSE_ZCODE_BIN' };
      const [cmd, argv] = resumeCommand(engine, session, ownerMode(configFile), envelope);
      const run = await exec(cmd, argv, runOptions(session.cwd, budgetMs));
      if (run.code !== 0) return { ok: false, error: `zcode resume exited ${run.code}: …${tailOf(run.stderr)}` };
      return { ok: true, output: run.stdout };
    },

    listSessions: async () => readSessions(dbFile),
  };
}
