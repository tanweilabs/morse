import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { createDb } from '../../src/mailbox/db.js';
import { homeContactContext } from '../../src/mailbox/home-context.js';
import { migrateToV5, type MigrationReportV5 } from '../../src/mailbox/migrate-v5.js';

/**
 * A separate `morse` process for the (ADR-091) migration tests (test/migrate-v5.test.ts):
 *
 *   open  <home> <morseDir> <dbPath> <now>           open the mailbox like any morse command; prints {migrated, backup, report}
 *   pause <home> <morseDir> <dbPath> <now> <marker>  start the migration and stop INSIDE its transaction (after the
 *                                                     backup, the converted contacts, the requests, the blocks and the
 *                                                     changed messages — nothing committed), having written <marker>;
 *                                                     the parent then kills this process with SIGKILL
 *
 * <now>: epoch ms the run counts as happening at (the backup's name, the new rows' timestamps) — so that
 * what a child migrates can be compared, row by row, with what the test process migrates.
 */
const [mode, home, morseDir, dbPath, nowArg, marker] = process.argv.slice(2) as [string, string, string, string, string, string?];
const now = Number(nowArg);
const ctx = homeContactContext(home);
if (mode === 'open') {
  let report: MigrationReportV5 | null = null;
  const db = createDb(dbPath, { ctx, morseDir, now: () => now, onMigrateV5: (r) => (report = r) });
  db.close();
  process.stdout.write(JSON.stringify({ migrated: report !== null, backup: (report as MigrationReportV5 | null)?.backup ?? null, report }));
} else {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateToV5(db, ctx, {
    now,
    backup: { morseDir, dbPath },
    hook: (stage) => {
      if (stage !== 'messages') return;
      writeFileSync(marker!, 'in the transaction');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // until killed
    },
  });
}
