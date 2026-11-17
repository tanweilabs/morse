import { createDb } from '../../src/mailbox/db.js';
import { createMailbox } from '../../src/mailbox/mailbox.js';

/**
 * A separate process that claims ONE message by id at a given moment (test/delivery-lease.test.ts, ADR-089
 * review F6): several of these started together race for the same row.
 *
 *   <dbPath> <message id> <epoch ms to claim at> [lease]
 *
 * Prints {claimed: <holder | true | null>} — or {error} when the claim threw.
 */
const [dbPath, id, atArg, lease] = process.argv.slice(2) as [string, string, string, string?];
const mailbox = createMailbox(createDb(dbPath, { ctx: {} }));
const wait = Number(atArg) - Date.now();
setTimeout(
  () => {
    try {
      const m = mailbox.claimById(id, lease ? { pid: process.pid } : undefined);
      process.stdout.write(JSON.stringify({ claimed: m ? (m.lease?.holder ?? true) : null }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  },
  Math.max(0, wait),
);
