import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { messageTextFrom } from '../src/commands/text-file.js';
import { dataDir } from '../src/home.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox } from '../src/mailbox/mailbox.js';
import { daemonJson } from './helpers/local-api.js';

/**
 * ADR-080: `morse send` / `morse reply` take the text from a file (`--text-file`). On Windows
 * an agent types the command in PowerShell 5.1, which runs morse.cmd (cmd.exe), which runs
 * node: double quotes are mangled by the first, `%NAME%` expanded and `& | < >` interpreted by
 * the second, and the whole command line is capped at 32,767 characters. A file passes through
 * none of that. The option works on every platform.
 */

const repo = resolve(__dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'morse-text-file-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = (content: string | Buffer) => {
  const p = join(tmp, `text-${n++}.txt`);
  writeFileSync(p, content);
  return p;
};

/** Everything a Windows command line would damage. */
const NASTY = 'He said "hi" & left | %PATH% ^ <tag> \'single\' 100%\nsecond line — 你好，世界 \u{1f600}\n  indented';

describe('messageTextFrom — the message text: the argument, or --text-file', () => {
  it('the argument alone is returned as it is', () => {
    expect(messageTextFrom('hello', undefined)).toBe('hello');
  });

  it('a UTF-8 file is returned character for character; exactly one trailing newline is dropped', () => {
    expect(messageTextFrom(undefined, file(NASTY))).toBe(NASTY);
    expect(messageTextFrom(undefined, file(`${NASTY}\n`))).toBe(NASTY);
    expect(messageTextFrom(undefined, file(`${NASTY}\r\n`))).toBe(NASTY);
    expect(messageTextFrom(undefined, file('two\n\n'))).toBe('two\n');
  });

  it('what Windows tools write: a UTF-8 byte-order mark, or UTF-16 with one (PowerShell 5.1 `>` and Out-File)', () => {
    expect(messageTextFrom(undefined, file(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NASTY, 'utf8')])))).toBe(NASTY);
    expect(messageTextFrom(undefined, file(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${NASTY}\r\n`, 'utf16le')])))).toBe(NASTY);
    const be = Buffer.from(NASTY, 'utf16le').swap16();
    expect(messageTextFrom(undefined, file(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toBe(NASTY);
  });

  it('a file in another encoding (PowerShell 5.1 Set-Content writes the ANSI code page) is refused, not sent as garbage', () => {
    // "你好" in GBK
    expect(() => messageTextFrom(undefined, file(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])))).toThrow(/not UTF-8.*-Encoding utf8/s);
  });

  it('on Windows, when a program runs morse (stdin is not a terminal), text as an ARGUMENT is refused — cmd.exe has already rewritten %NAME% in it and nothing can tell', () => {
    const agent = { platform: 'win32' as const, stdinIsTTY: false };
    expect(() => messageTextFrom('hello', undefined, agent)).toThrow(/^on Windows .*--text-file <file>/);
    expect(() => messageTextFrom('hello', undefined, { platform: 'win32', stdinIsTTY: undefined })).toThrow(/--text-file/);
    // the file is the way through
    expect(messageTextFrom(undefined, file(NASTY), agent)).toBe(NASTY);
    // a person typing in a terminal keeps the argument
    expect(messageTextFrom('hello', undefined, { platform: 'win32', stdinIsTTY: true })).toBe('hello');
    // macOS / Linux: unchanged, terminal or not
    for (const platform of ['darwin', 'linux'] as const) for (const stdinIsTTY of [true, false, undefined]) expect(messageTextFrom('hello', undefined, { platform, stdinIsTTY })).toBe('hello');
    // the other errors come first, as everywhere
    expect(() => messageTextFrom('x', file('y'), agent)).toThrow('not both');
    expect(() => messageTextFrom(undefined, undefined, agent)).toThrow("missing required argument 'message'");
  });

  it('both, neither, a missing file and an empty file are errors', () => {
    expect(() => messageTextFrom('x', file('y'))).toThrow('give the message as an argument or with --text-file, not both');
    expect(() => messageTextFrom(undefined, undefined)).toThrow("missing required argument 'message'");
    expect(() => messageTextFrom(undefined, join(tmp, 'nope.txt'))).toThrow(/cannot read --text-file .*nope\.txt/);
    expect(() => messageTextFrom(undefined, file(''))).toThrow(/is empty/);
    expect(() => messageTextFrom(undefined, file('\n'))).toThrow(/is empty/);
  });
});

describe('through the real CLI (temp MORSE_HOME + HOME)', () => {
  const home = mkdtempSync(join(tmpdir(), 'morse-text-file-home-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((done) => {
      const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: repo, env: { ...process.env, MORSE_HOME: home, ANYTOANY_HOME: home, HOME: home } });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', (code) => done({ code, out, err }));
    });

  it('morse send <target> --text-file: the daemon is handed exactly the file\'s text', async () => {
    let got: { text?: string } = {};
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        if (req.url === '/api/send') got = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: string };
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { id: 'm1', parts: [] }, resolvedTarget: { agent: 'inbox', title: 'inbox', sessionId: '', device: 'k7f3a9xq' } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = String((server.address() as { port: number }).port);
      daemonJson(home, port); // (ADR-087: this home's daemon listens there — a command talks to no other)
      const r = await cli(['send', 'morse.im/k7f3a9xq', '--text-file', file(`${NASTY}\n`), '--port', port]);
      expect(r.err).not.toContain('error');
      expect(r.out).toContain('queued m1');
      expect(got.text).toBe(NASTY);
      // the text as an argument: exactly as before on macOS / Linux; on Windows this test is "a program running
      // morse" (stdin is a pipe), which is refused there (ADR-080)
      got = {};
      const plain = await cli(['send', 'morse.im/k7f3a9xq', 'plain words', '--port', port]);
      if (process.platform === 'win32') {
        expect(plain.code).toBe(1);
        expect(plain.err).toContain('--text-file');
        expect(got).toEqual({});
      } else expect(got.text).toBe('plain words');
      // both / neither: refused before anything is sent
      got = {};
      const both = await cli(['send', 'morse.im/k7f3a9xq', 'words', '--text-file', file('x'), '--port', port]);
      expect(both.code).toBe(1);
      expect(both.err.trim()).toBe('error: give the message as an argument or with --text-file, not both');
      const neither = await cli(['send', 'morse.im/k7f3a9xq', '--port', port]);
      expect(neither.code).toBe(1);
      expect(neither.err.trim()).toBe("error: missing required argument 'message'");
      expect(got).toEqual({});
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);

  it('morse reply <id> --text-file: the reply is queued with exactly the file\'s text', async () => {
    const mailbox = createMailbox(createDb(join(dataDir(home), 'mailbox.db')));
    const m = mailbox.send({ from: { agent: 'claude', sessionId: 'c1' }, to: { agent: 'codex', sessionId: 'x1' }, text: 'please answer' });
    const r = await cli(['reply', m.id, '--text-file', file(NASTY)]);
    expect(r.err).not.toContain('error');
    expect(r.out).toMatch(/queued reply/);
    const reply = mailbox.inbox({ all: true }).find((x) => x.id !== m.id)!;
    expect(reply.parts[0]!.text).toBe(NASTY);
    const neither = await cli(['reply', m.id]);
    expect(neither.code).toBe(1);
    expect(neither.err.trim()).toBe("error: missing required argument 'message'");
  }, 60_000);
});
