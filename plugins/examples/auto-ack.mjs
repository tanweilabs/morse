#!/usr/bin/env node
// Example Morse plugin (docs/PLUGINS.md): answers "[auto] received" to messages from your
// own agents (contact group "self") and to nobody else. Uses only the public interface:
// `morse plugin watch --json` for events, `morse reply` for the action. Usage: auto-ack.mjs [--since <id>]
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [bin, ...pre] = (process.env.MORSE_CMD ?? 'morse').split(' ');
const morse = (...args) => execFileSync(bin, [...pre, ...args], { encoding: 'utf8' });
const watch = spawn(bin, [...pre, 'watch', '--json', ...process.argv.slice(2)], { stdio: ['ignore', 'pipe', 'inherit'] });

for await (const line of createInterface({ input: watch.stdout })) {
  const e = JSON.parse(line);
  if (e.type !== 'message' || e.direction !== 'in' || e.processed) continue; // new mail from an address
  if (e.contact?.group !== 'self') continue; // your own agents only — never other addresses
  if (e.text.startsWith('[auto]')) continue; // never answer an auto-reply (no loops)
  morse('reply', e.id, '[auto] received', '--by', 'plugin:auto-ack');
  console.error(`auto-ack: answered ${e.id}`);
}
