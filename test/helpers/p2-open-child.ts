import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createDb } from '../../src/mailbox/db.js';
import { homeContactContext } from '../../src/mailbox/home-context.js';
import { migrateToV3 } from '../../src/mailbox/migrate-v3.js';

/**
 * A separate `morse` process for the ADR-077 migration tests (test/migrate-p2.test.ts):
 *
 *   open  <home> <morseDir> <dbPath>           open the mailbox like any morse command; prints {migrated, backup}
 *   pause <home> <morseDir> <dbPath> <marker>  start the migration and stop INSIDE its transaction (after the
 *                                               backup, the table rebuild and the contact rows), having written
 *                                               <marker> — the parent then kills this process with SIGKILL
 */
const [mode, home, morseDir, dbPath, marker] = process.argv.slice(2) as [string, string, string, string, string?];
const ctx = homeContactContext(home);
if (mode === 'open') {
  let report: { backup: string | null } | null = null;
  const db = createDb(dbPath, { upTo: 4, ctx, morseDir, onMigrateV3: (r) => (report = r) });
  db.close();
  process.stdout.write(JSON.stringify({ migrated: report !== null, backup: (report as { backup: string | null } | null)?.backup ?? null }));
} else {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateToV3(db, ctx, {
    backup: { morseDir, dbPath },
    hook: (stage) => {
      if (stage !== 'contacts') return;
      writeFileSync(marker!, 'in the transaction');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // until killed
    },
  });
}
