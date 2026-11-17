import { classifyReply } from '../../src/envelope.js';
import type { Mailbox } from '../../src/mailbox/mailbox.js';
import { viewOf } from '../../src/plugin/local-client.js';
import { type AttendantCore, BY } from '../../src/plugins/attendant/core.js';

/** The same over a mailbox, in-process (tests). Owner notices are collected in `notices`. */
export function createLocalCore(mailbox: Mailbox): AttendantCore & { notices: string[] } {
  const notices: string[] = [];
  return {
    notices,
    async todo() {
      return mailbox.todo().map((m) => viewOf(mailbox, m));
    },
    async history(contactId, limit) {
      return mailbox.history(contactId, { limit }).map((m) => viewOf(mailbox, m));
    },
    async reply(id, text) {
      const original = mailbox.getMessage(id);
      if (!original) return { ok: false, error: `no message ${id}` };
      const verdict = classifyReply(original.parts.map((p) => p.text).join('\n'), text);
      if (verdict !== 'file') {
        mailbox.markProcessed([id], BY);
        return { ok: false, error: `not sent (${verdict})`, reason: verdict };
      }
      try {
        const r = mailbox.reply(id, text, 'attendant');
        mailbox.markProcessed([id], BY);
        return { ok: true, id: r.id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async done(ids) {
      return mailbox.markProcessed(ids, BY);
    },
    async notifyOwner(text) {
      notices.push(text);
      return true;
    },
    async register() {
      /* nothing to register in-process */
    },
  };
}
