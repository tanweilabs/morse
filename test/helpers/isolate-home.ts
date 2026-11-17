import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Safety net for the whole test run (vitest `setupFiles`): unless a test sets its own, every
 * test process — and every `morse` child it starts with an inherited environment — has
 * MORSE_HOME pointing at a throw-away directory. Morse's own state (mailbox, contacts, keys,
 * the migration and its backup) then can never be read from or written to the real ~/.morse
 * by a test that forgot to pass a home (the real one on a developer's Mac was migrated that
 * way once, 2026-11-14).
 */
// ANYTOANY_HOME is the lowest-priority override (MORSE_HOME wins), so a test that sets either name for
// itself or for a child process is unaffected.
if (!process.env['MORSE_HOME'] && !process.env['ANYTOANY_HOME']) process.env['ANYTOANY_HOME'] = mkdtempSync(join(tmpdir(), 'morse-test-home-'));

// (ADR-088 §4) MORSE_ADDRESS names the address a process uses when a command names none. One set in the
// environment the test run was started from (a session that lives at a second address) would change what every
// child `morse` lists and sends from: it is taken out here, and a test that wants one sets it itself.
delete process.env['MORSE_ADDRESS'];
