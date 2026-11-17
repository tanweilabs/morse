import { messageViewOf } from '../commands/messaging.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';
import type { CoreClient, LeaseOptions, PluginMessage, ReplyOutcome } from './contract.js';

/**
 * The plugin contract (contract.ts) done in-process over the mailbox — what the
 * `morse plugin claim | ack | nack | reply` commands run, and what tests
 * hand a plugin directly. Only own-agent mail (never another person's) can be claimed.
 */

// (ADR-083 review R3) the contact is the one of the message's own pair (my address, peer) — never looked up by the bare id
export const viewOf = (mailbox: Mailbox, m: Message): PluginMessage => messageViewOf(mailbox, m);

/** A claimed message as the claim answers it: the view, plus its lease when it was claimed with one (ADR-089). */
export const claimView = (mailbox: Mailbox, m: Message): PluginMessage => ({ ...viewOf(mailbox, m), ...(m.lease ? { lease: { holder: m.lease.holder, expiresAt: m.lease.expiresAt } } : {}) });

export function claimNext(mailbox: Mailbox, skipSessions: string[] = [], skipIds: string[] = [], lease?: LeaseOptions): Message | null {
  return mailbox.claimNextPending({ scope: 'local', pullOnlySessions: ['inbox'], ...(skipSessions.length ? { skipSessions } : {}), ...(skipIds.length ? { skipIds } : {}), ...(lease ? { lease } : {}) });
}

export function createLocalClient(mailbox: Mailbox, opts: { by?: string } = {}): CoreClient {
  const by = opts.by ?? 'plugin:dispatch';
  return {
    async claimNext(o = {}) {
      const m = claimNext(mailbox, o.skipSessions, o.skipIds, o.lease);
      return m ? claimView(mailbox, m) : null;
    },
    async claim(id, o = {}) {
      const m = mailbox.claimById(id, o.lease);
      return m ? claimView(mailbox, m) : null;
    },
    async ack(id, o = {}) {
      // (ADR-089) one step: a refused report (not the holder) leaves the message neither delivered nor processed
      mailbox.markDelivered(id, { ...(o.inSession ? { inSession: true } : {}), ...(o.holder ? { holder: o.holder } : {}), by: o.by ?? by });
    },
    async nack(id, error, o = {}) {
      mailbox.markFailed(id, error, { ...(o.terminal ? { terminal: true } : {}), ...(o.holder ? { holder: o.holder } : {}) });
    },
    async release(id, o = {}) {
      mailbox.release(id, o.holder);
    },
    async toMailbox(id, note, o = {}) {
      return mailbox.toMailbox(id, note, o.holder);
    },
    async extend(id, holder, o = {}) {
      return mailbox.extendLease(id, holder, o);
    },
    async reply(id, text, o = {}): Promise<ReplyOutcome> {
      try {
        const r = mailbox.reply(id, text, o.via);
        return { ok: true, id: r.id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async recover() {
      return mailbox.recoverStale(true);
    },
    async todo() {
      return mailbox.todo().map((m) => viewOf(mailbox, m));
    },
    async done(ids, o = {}) {
      return mailbox.markProcessed(ids, o.by ?? by);
    },
  };
}
