import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withFileLock } from '../../file-lock.js';
import { takeLaneLock } from '../../plugin/lane-lock.js';

/**
 * The dispatch plugin's own state (ADR-055 / ADR-056), in <MORSE_HOME or ~>/.morse/plugins/dispatch/
 * (0700, files 0600) — never the mailbox:
 *
 *   state.json          { "dedicated": { "<profile>": { agent, sessionId, cwd, createdAt, fresh?, resetPending? } },
 *                         "selfInboxSince": <epoch ms, first time the own-inbox loop ran>,
 *                         "marks": { "<message id>": { attempts, notBefore, error } } }   (ADR-061: own inbox mail retries)
 *   locks/<lane>.lock   the pid running a turn for that session right now (one turn per session,
 *                       also across processes — a second dispatcher, a manual run)
 */

export interface DedicatedSession {
  agent: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  /** Created by us and not yet seen to exist (its first turn may have failed before Claude wrote it). */
  fresh?: boolean;
  /** The session was started afresh: the next reply begins with the profile's resetNotice. */
  resetPending?: boolean;
  /** Seeded from elsewhere (morse plugin ilink import). */
  seededFrom?: string;
}

export interface DispatchState {
  dir: string;
  dedicated(name: string): DedicatedSession | null;
  setDedicated(name: string, value: DedicatedSession | null): void;
  allDedicated(): Record<string, DedicatedSession>;
  /** Hold the lane (one turn per session) across processes; null = someone else runs it now. */
  lock(lane: string): (() => void) | null;
  /** ADR-061: a failed try of your own inbox mail (null = none / cleared). */
  mark(id: string): MessageMark | null;
  setMark(id: string, value: MessageMark | null): void;
  /** ADR-061: when the own-inbox loop first ran (epoch ms); `init` is stored if none yet. Earlier mail is never answered. */
  selfInboxSince(init: number): number;
}

export interface MessageMark {
  attempts: number;
  /** Not before this time (epoch ms); MAX_SAFE_INTEGER = given up. */
  notBefore: number;
  error?: string;
  /** (ADR-089) A turn was started for it at this time and has not reported: the next one may be a repeat. */
  startedAt?: number;
}

interface StateFile {
  dedicated: Record<string, DedicatedSession>;
  marks: Record<string, MessageMark>;
  selfInboxSince?: number;
}

/** MORSE_HOME; compatibility: ANYTOANY_HOME (the old name) is still read, as in src/home.ts. */
export const dispatchStateDir = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env['MORSE_HOME'] || env['ANYTOANY_HOME'] || homedir(), '.morse', 'plugins', 'dispatch');

export function createDispatchState(dir: string = dispatchStateDir()): DispatchState {
  const file = join(dir, 'state.json');
  const ensure = () => {
    mkdirSync(join(dir, 'locks'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  };
  const read = (): StateFile => {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>;
      return { dedicated: raw.dedicated && typeof raw.dedicated === 'object' ? raw.dedicated : {}, marks: raw.marks && typeof raw.marks === 'object' ? raw.marks : {}, ...(typeof raw.selfInboxSince === 'number' ? { selfInboxSince: raw.selfInboxSince } : {}) };
    } catch {
      return { dedicated: {}, marks: {} };
    }
  };
  const write = (state: StateFile) => {
    if (!Object.keys(state.marks).length) delete (state as Partial<StateFile>).marks;
    ensure();
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    dir,
    dedicated: (name) => read().dedicated[name] ?? null,
    allDedicated: () => read().dedicated,
    // changes are read-modify-write under the file's lock: the plugin and CLI calls both write it
    setDedicated(name, value) {
      withFileLock(file, () => {
        const state = read();
        if (value) state.dedicated[name] = value;
        else delete state.dedicated[name];
        write(state);
      });
    },
    lock(lane) {
      ensure();
      return takeLaneLock(join(dir, 'locks'), lane);
    },
    selfInboxSince(init) {
      return withFileLock(file, () => {
        const state = read();
        if (typeof state.selfInboxSince === 'number') return state.selfInboxSince;
        state.selfInboxSince = init;
        write(state);
        return init;
      });
    },
    mark: (id) => read().marks[id] ?? null,
    setMark(id, value) {
      withFileLock(file, () => {
        const state = read();
        if (value) state.marks[id] = value;
        else if (!state.marks[id]) return;
        else delete state.marks[id];
        write(state);
      });
    },
  };
}
