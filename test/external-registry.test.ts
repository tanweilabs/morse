import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RESERVED_AGENT_NAMES, isRegisteredSession, listRegistered, register, unregister } from '../src/registry/external.js';

// ADR-024: an app assistant with no CLI to resume (闪电说 is the first) registers
// itself to become addressable, and fetches its own mail.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

let home: string;
let folder: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'morse-extreg-'));
  folder = join(home, '.morse', 'registered');
});

/** A store bound to this test's home and a clock the test moves. */
function store(start = 10_000) {
  let clock = start;
  const opts = () => ({ home, now: () => clock });
  return {
    at(ms: number) {
      clock = ms;
    },
    register: (input: Parameters<typeof register>[0]) => register(input, opts()),
    list: (extra: { includeStale?: boolean; ttlMs?: number } = {}) => listRegistered({ ...opts(), ...extra }),
    isRegistered: (sessionId: string) => isRegisteredSession(sessionId, opts()),
  };
}

const notes = { agent: 'notes-app', sessionId: 'notes-1', title: 'Notes assistant', cwd: '/w/notes' };

describe('register / listRegistered', () => {
  it('stores one pretty-printed JSON file per agent+session and lists it back', () => {
    const s = store(42);
    const made = s.register(notes);
    expect(made).toEqual({ ...notes, registeredAt: 42, lastSeenAt: 42 });

    expect(readdirSync(folder)).toEqual(['notes-app-notes-1.json']);
    expect(readFileSync(join(folder, 'notes-app-notes-1.json'), 'utf8')).toBe(JSON.stringify(made, null, 2));
    expect(s.list()).toEqual([made]);
  });

  it('a second registration of the same session updates that file: first-seen time kept, last-seen moved', () => {
    const s = store(100);
    s.register(notes);
    s.at(900);
    const again = s.register({ ...notes, title: 'Renamed', cwd: '/w/elsewhere' });
    expect(again).toMatchObject({ title: 'Renamed', cwd: '/w/elsewhere', registeredAt: 100, lastSeenAt: 900 });
    expect(readdirSync(folder)).toHaveLength(1);
    expect(s.list()).toHaveLength(1);
  });

  it('a bare check-in ({agent, sessionId}) keeps the title and cwd registered before', () => {
    const s = store(1);
    s.register(notes);
    s.at(2);
    expect(s.register({ agent: notes.agent, sessionId: notes.sessionId })).toEqual({ ...notes, registeredAt: 1, lastSeenAt: 2 });
  });

  it('a blank title falls back to the stored one, and with none stored to the agent name; cwd defaults to empty', () => {
    const s = store();
    expect(s.register({ agent: 'helper', sessionId: 'h1', title: '   ' })).toMatchObject({ title: 'helper', cwd: '' });
    s.register({ agent: 'helper', sessionId: 'h1', title: 'Helper' });
    expect(s.register({ agent: 'helper', sessionId: 'h1', title: '' }).title).toBe('Helper');
    // an explicit empty cwd is a value, not "not given"
    s.register({ agent: 'helper', sessionId: 'h1', cwd: '/w/h' });
    expect(s.register({ agent: 'helper', sessionId: 'h1', cwd: '' }).cwd).toBe('');
  });

  it('leaves the caller\'s input object alone', () => {
    const input = { agent: 'helper', sessionId: 'h2', title: '  padded  ' };
    const copy = structuredClone(input);
    store().register(input);
    expect(input).toEqual(copy);
  });

  it('newest check-in first', () => {
    const s = store(5);
    s.register({ agent: 'helper', sessionId: 'a' });
    s.at(50);
    s.register({ agent: 'helper', sessionId: 'b' });
    s.at(20);
    s.register({ agent: 'other-app', sessionId: 'c' });
    s.at(60);
    expect(s.list().map((x) => x.sessionId)).toEqual(['b', 'c', 'a']);
  });

  it('a session id with characters a file name cannot hold is stored as given, under a cleaned-up file name', () => {
    const s = store();
    s.register({ agent: 'helper', sessionId: '../x y:z' });
    const [file] = readdirSync(folder);
    expect(file).toBe('helper-.._x_y_z.json');
    expect(s.list()[0]?.sessionId).toBe('../x y:z');
    expect(s.isRegistered('../x y:z')).toBe(true);
  });
});

describe('what is refused', () => {
  it('the reserved names — the human inbox and the agents Morse delivers to itself', () => {
    expect([...RESERVED_AGENT_NAMES]).toEqual(['user', 'claude', 'codex', 'kimi', 'zcode']);
    for (const agent of RESERVED_AGENT_NAMES) {
      expect(() => store().register({ agent, sessionId: 's' })).toThrow(
        `agent name "${agent}" is reserved (user, claude, codex, kimi, zcode) — pick another name`,
      );
    }
  });

  it('names that are not 2-32 lowercase letters, digits and dashes starting with a letter', () => {
    for (const agent of ['x', 'Notes', '1app', '-app', 'my app', 'app_1', 'app.io', '', 'n'.repeat(33)]) {
      expect(() => store().register({ agent, sessionId: 's' })).toThrow(`invalid agent name "${agent}"`);
    }
    for (const agent of ['ab', 'a-1', 'n'.repeat(32)]) expect(() => store().register({ agent, sessionId: 's' })).not.toThrow();
  });

  it('an empty or blank session id', () => {
    for (const sessionId of ['', ' \t ']) {
      expect(() => store().register({ agent: 'helper', sessionId })).toThrow('a session id is required to register an external agent session');
    }
    expect(existsAny()).toBe(false);
  });
});

const existsAny = (): boolean => {
  try {
    return readdirSync(folder).length > 0;
  } catch {
    return false;
  }
};

describe('a week without a check-in', () => {
  it('hides the session from the listing but keeps its file; registering again revives the same identity', () => {
    const s = store(0);
    s.register(notes);
    s.at(WEEK);
    expect(s.list()).toHaveLength(1); // exactly a week: still shown
    s.at(WEEK + 1);
    expect(s.list()).toEqual([]);
    expect(s.list({ includeStale: true })).toHaveLength(1);
    expect(readdirSync(folder)).toHaveLength(1);

    s.at(WEEK + 5);
    expect(s.register(notes).registeredAt).toBe(0);
    expect(s.list()).toHaveLength(1);
  });

  it('the window can be set per call', () => {
    const s = store(0);
    s.register(notes);
    s.at(DAY);
    expect(s.list({ ttlMs: DAY - 1 })).toEqual([]);
    expect(s.list({ ttlMs: DAY })).toHaveLength(1);
  });

  it('isRegisteredSession still says yes for a stale session — its mail must stay pending, not be resumed into', () => {
    const s = store(0);
    s.register(notes);
    s.at(30 * DAY);
    expect(s.list()).toEqual([]);
    expect(s.isRegistered('notes-1')).toBe(true);
    expect(s.isRegistered('notes-2')).toBe(false);
  });
});

describe('robustness', () => {
  it('no folder yet: an empty listing and no registered session', () => {
    expect(store().list()).toEqual([]);
    expect(store().isRegistered('anything')).toBe(false);
  });

  it('broken, foreign or odd files in the folder are skipped; the good entry still lists', () => {
    const s = store(7);
    s.register(notes);
    writeFileSync(join(folder, 'garbage.json'), 'not json at all');
    writeFileSync(join(folder, 'null.json'), 'null');
    writeFileSync(join(folder, 'no-ids.json'), JSON.stringify({ agent: 'x' }));
    writeFileSync(join(folder, 'README.txt'), JSON.stringify({ agent: 'txt', sessionId: 't' }));
    mkdirSync(join(folder, 'folder.json'));
    expect(s.list().map((x) => x.sessionId)).toEqual(['notes-1']);
  });

  it('a hand-written entry with missing fields gets defaults: title = agent, cwd empty, times 0', () => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'old.json'), JSON.stringify({ agent: 'legacy-app', sessionId: 'l1', title: 5 }));
    expect(store().list({ includeStale: true })).toEqual([
      { agent: 'legacy-app', sessionId: 'l1', title: 'legacy-app', cwd: '', registeredAt: 0, lastSeenAt: 0 },
    ]);
  });

  it('unregister removes the session; doing it again, or for one never registered, is fine', () => {
    const s = store();
    s.register(notes);
    s.register({ agent: 'helper', sessionId: 'keep' });
    unregister('notes-app', 'notes-1', { home });
    expect(s.list().map((x) => x.sessionId)).toEqual(['keep']);
    expect(() => unregister('notes-app', 'notes-1', { home })).not.toThrow();
    expect(() => unregister('never', 'seen', { home: join(home, 'missing') })).not.toThrow();
  });
});
