import { morseCommand, runMorse } from '../../plugin/cli-client.js';
import type { PluginMessage } from '../../plugin/contract.js';

/**
 * The attendant's side of the core — only the documented plugin interface (docs/PLUGINS.md):
 * `morse message [<who>] | reply | done | send | connect` (test/helpers/attendant-core.ts
 * does the same in-process over a mailbox).
 */

export const BY = 'plugin:attendant';
/** The plugin's own (pull-only) session: the sender of the owner's WeChat notices. */
export const ATTENDANT_AGENT = 'attendant';
export const ATTENDANT_SESSION = 'approvals';
/** The iLink plugin's session: own mail to it goes to the owner on WeChat (ADR-053). */
export const ILINK_TARGET = '@ilink:ilink-wechat';

export type SendOutcome = { ok: true; id: string } | { ok: false; error: string; reason?: string };

export interface AttendantCore {
  /** Received and not processed (`morse message --json`). */
  todo(): Promise<PluginMessage[]>;
  /** The newest `limit` messages with a contact, oldest first (`morse message <contact id> --json`). */
  history(contactId: string, limit: number): Promise<PluginMessage[]>;
  /** `morse reply <id> <text>`: to the same contact, same thread; marks it processed. */
  reply(id: string, text: string): Promise<SendOutcome>;
  /** `morse done <ids…>`: the ids it marked. */
  done(ids: string[]): Promise<string[]>;
  /** Tell the owner on WeChat (own mail to the iLink plugin). */
  notifyOwner(text: string): Promise<boolean>;
  /** `morse connect` the plugin's own session (once at start). */
  register(): Promise<void>;
}

export function createCliCore(opts: { cmd?: string[]; env?: NodeJS.ProcessEnv } = {}): AttendantCore {
  const cmd = opts.cmd ?? morseCommand();
  const run = async (args: string[]) => {
    const r = await runMorse(args, cmd, opts.env);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(r.out) as Record<string, unknown>;
    } catch {
      body = { error: (r.err.trim() || r.out.trim() || `exit ${r.code}`).split('\n').slice(-2).join(' ').slice(0, 300) };
    }
    return { code: r.code, body };
  };
  const failure = (what: string, body: Record<string, unknown>) => new Error(`morse ${what}: ${String(body['error'] ?? 'failed')}`);
  return {
    async todo() {
      const { body } = await run(['message', '--json']);
      if (!Array.isArray(body['messages'])) throw failure('inbox', body);
      return body['messages'] as PluginMessage[];
    },
    async history(contactId, limit) {
      const { body } = await run(['message', contactId, '--limit', String(limit), '--json']);
      if (!Array.isArray(body['messages'])) throw failure('history', body);
      return body['messages'] as PluginMessage[];
    },
    async reply(id, text) {
      const { body } = await run(['reply', id, text, '--by', BY, '--via', 'attendant', '--json']);
      const m = body['message'] as { id?: string } | undefined;
      if (body['sent'] === true && m?.id) return { ok: true, id: m.id };
      return { ok: false, error: String(body['error'] ?? `not sent (${String(body['reason'] ?? 'unknown')})`), ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}) };
    },
    async done(ids) {
      if (!ids.length) return [];
      const { body } = await run(['done', ...ids, '--by', BY, '--json']);
      return Array.isArray(body['done']) ? (body['done'] as string[]) : [];
    },
    async notifyOwner(text) {
      const { code, body } = await run(['send', ILINK_TARGET, text, '--from', `@${ATTENDANT_AGENT}:${ATTENDANT_SESSION}`, '--json']);
      return code === 0 && !body['error'];
    },
    async register() {
      const r = await runMorse(['connect', '--agent', ATTENDANT_AGENT, '--session', ATTENDANT_SESSION, '--title', 'attendant'], cmd, opts.env);
      if (r.code !== 0) throw new Error(`morse connect: ${(r.err || r.out).trim().slice(0, 200)}`);
    },
  };
}
