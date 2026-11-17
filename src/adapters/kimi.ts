import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_TURN_MS, TITLE_LIMIT, locateCli, objectLines, runOptions, stringField, tailOf } from './common.js';
import { realExec } from './exec.js';
import type { DeliveryAdapter, DeliveryResult, ExecFn, SessionInfo } from './types.js';

interface KimiSetup {
  indexFile?: string;
  kimiBin?: string;
  exec?: ExecFn;
  deliverTimeoutMs?: number;
}

/** The Kimi Code binary: MORSE_KIMI_BIN (or its old name ANYTOANY_KIMI_BIN, ADR-075), PATH, then where its installer puts it. */
const findKimi = (): string | null =>
  locateCli({
    envNames: ['MORSE_KIMI_BIN', 'ANYTOANY_KIMI_BIN'],
    command: 'kimi',
    installed: () => join(homedir(), '.kimi-code', 'bin', 'kimi'),
  });

/**
 * The agent's own words in a `--output-format stream-json` run. Each line is one message;
 * only assistant messages with text content count — tool results and the closing `meta`
 * resume hint would otherwise end up in the reply the marker is read from.
 */
function assistantProse(stdout: string): string {
  return objectLines<{ role?: unknown; content?: unknown }>(stdout)
    .filter((m) => m.role === 'assistant')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/** One row of ~/.kimi-code/session_index.jsonl turned into a session (null: no usable id). */
async function sessionFromRow(row: object): Promise<SessionInfo | null> {
  const sessionId = stringField(row, 'sessionId');
  if (!sessionId) return null;
  const cwd = stringField(row, 'workDir') ?? '';
  const dir = stringField(row, 'sessionDir');
  // the session folder is touched on every turn; a folder that is gone counts as never used
  const lastActiveAt = dir === undefined ? 0 : await stat(dir).then((s) => s.mtimeMs, () => 0);
  // kimi titles are the folder name, cut without an ellipsis
  const title = (basename(cwd) || 'untitled').slice(0, TITLE_LIMIT);
  return { agent: 'kimi', sessionId, title, cwd, lastActiveAt };
}

export function createKimiAdapter(setup: KimiSetup = {}): DeliveryAdapter {
  const indexFile = setup.indexFile ?? join(homedir(), '.kimi-code', 'session_index.jsonl');
  const exec = setup.exec ?? realExec;
  const turnMs = setup.deliverTimeoutMs ?? DEFAULT_TURN_MS;

  return {
    agent: 'kimi',

    // `kimi -S <id> -p <text>` resumes the session headless with its history (checked on
    // 0.32.0). With -p the CLI already runs tools and refuses -y/--yolo/--auto/--plan, so
    // there is no permission flag to add — and none is ever added.
    async deliver(session: SessionInfo, envelope: string): Promise<DeliveryResult> {
      const bin = setup.kimiBin ?? findKimi();
      if (!bin) return { ok: false, error: 'kimi not found — install Kimi Code or set MORSE_KIMI_BIN' };
      const argv = ['-S', session.sessionId, '-p', envelope, '--output-format', 'stream-json'];
      const run = await exec(bin, argv, runOptions(session.cwd, turnMs));
      if (run.code !== 0) return { ok: false, error: `kimi resume exited ${run.code}: …${tailOf(run.stderr)}` };
      return { ok: true, output: assistantProse(run.stdout) };
    },

    async listSessions(): Promise<SessionInfo[]> {
      let text: string;
      try {
        text = readFileSync(indexFile, 'utf8');
      } catch {
        return []; // no Kimi Code here, or no session yet
      }
      // the index is appended to: for an id listed twice the later row describes it
      const latest = new Map<string, SessionInfo>();
      for (const row of objectLines<object>(text)) {
        const session = await sessionFromRow(row);
        if (session) latest.set(session.sessionId, session);
      }
      return [...latest.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    },
  };
}
