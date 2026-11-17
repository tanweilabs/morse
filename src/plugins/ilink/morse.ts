import type { PluginMessage } from '../../plugin/contract.js';
import { morseCommand, runMorse } from '../../plugin/cli-client.js';

/**
 * The Morse side of the iLink plugin — only the documented plugin interface, through the
 * `morse` command (docs/PLUGINS.md): register, send, inbox, read, claim / ack / nack, done.
 */

/** The plugin's Morse-side identity (ADR-053): a registered, pull-only session of yours. */
export const ILINK_AGENT = 'ilink';
export const ILINK_SESSION = 'ilink-wechat';
export const ILINK_TITLE = 'wechat';
export const SIMULATE_SESSION = 'ilink-simulate';
export const BY = 'plugin:ilink';

export interface MorseSide {
  register(session?: string, title?: string): Promise<void>;
  unregister(session: string): Promise<void>;
  /** A new message from the plugin's identity to `target`. */
  send(target: string, text: string, from?: string): Promise<{ id: string; contextId: string }>;
  /** Everything received and not yet processed (`morse message --json`). */
  todo(): Promise<{ messages: PluginMessage[]; unread: Array<{ contact: string; remark: string | null; handle: string | null; group: string | null; count: number }> }>;
  read(id: string): Promise<PluginMessage | null>;
  claim(id: string): Promise<PluginMessage | null>;
  ack(id: string): Promise<void>;
  nack(id: string, error: string, terminal?: boolean): Promise<void>;
  release(id: string): Promise<void>;
  done(id: string): Promise<boolean>;
  cmd: string[];
  env?: NodeJS.ProcessEnv | undefined;
}

export class MorseError extends Error {}

export function createMorseSide(opts: { cmd?: string[]; env?: NodeJS.ProcessEnv } = {}): MorseSide {
  const cmd = opts.cmd ?? morseCommand();
  const env = opts.env;
  const run = async (args: string[], what: string): Promise<Record<string, unknown>> => {
    const r = await runMorse(args, cmd, env);
    try {
      const body = JSON.parse(r.out) as Record<string, unknown>;
      if (r.code !== 0 || typeof body['error'] === 'string') throw new MorseError(`morse ${what}: ${String(body['error'] ?? `exit ${r.code}`)}`);
      return body;
    } catch (e) {
      if (e instanceof MorseError) throw e;
      throw new MorseError(`morse ${what}: ${(r.err.trim() || r.out.trim() || `exit ${r.code}`).split('\n').slice(-2).join(' ').slice(0, 300)}`);
    }
  };
  const plain = async (args: string[], what: string) => {
    const r = await runMorse(args, cmd, env);
    if (r.code !== 0) throw new MorseError(`morse ${what}: ${(r.err.trim() || r.out.trim()).slice(0, 300)}`);
  };
  return {
    cmd,
    env,
    register: (session = ILINK_SESSION, title = ILINK_TITLE) => plain(['connect', '--agent', ILINK_AGENT, '--session', session, '--title', title], 'connect'),
    unregister: (session) => plain(['connect', '--agent', ILINK_AGENT, '--session', session, '--uninstall'], 'connect'),
    async send(target, text, from = `@${ILINK_AGENT}:${ILINK_SESSION}`) {
      // (ADR-087 follow-up 2) no --port: the command finds the daemon of its own home by itself — a port named here
      // (7433 by default, once) is where this home's token would have gone, whoever listened there
      const body = await run(['send', target, text, '--from', from, '--json'], 'send');
      const m = body['message'] as { id?: string; contextId?: string } | undefined;
      if (!m?.id || !m.contextId) throw new MorseError('morse send: no message in the answer');
      return { id: m.id, contextId: m.contextId };
    },
    async todo() {
      const body = await run(['message', '--json'], 'message');
      return { messages: (body['messages'] ?? []) as PluginMessage[], unread: (body['unread'] ?? []) as Awaited<ReturnType<MorseSide['todo']>>['unread'] };
    },
    async read(id) {
      try {
        return ((await run(['message', '--id', id, '--json'], 'message'))['message'] as PluginMessage) ?? null;
      } catch {
        return null;
      }
    },
    async claim(id) {
      return ((await run(['plugin', 'claim', id, '--json'], 'claim'))['message'] as PluginMessage | null) ?? null;
    },
    async ack(id) {
      await run(['plugin', 'ack', id, '--by', BY, '--json'], 'ack');
    },
    async nack(id, error, terminal = false) {
      await run(['plugin', 'nack', id, '--error', error, ...(terminal ? ['--terminal'] : []), '--json'], 'nack');
    },
    async release(id) {
      await run(['plugin', 'nack', id, '--release', '--json'], 'nack');
    },
    async done(id) {
      const body = await run(['done', id, '--by', BY, '--json'], 'done');
      return Array.isArray(body['done']) && (body['done'] as string[]).includes(id);
    },
  };
}
