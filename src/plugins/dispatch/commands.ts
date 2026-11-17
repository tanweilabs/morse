import { createLaunchReader, DISPATCH_AGENT, PROFILE_NAME_RE } from './launch.js';
import { createDispatchState } from './state.js';

/**
 * `morse plugin dispatch …` (ADR-056) — the dispatch plugin's own command line:
 *
 *   session [--json]                              the dedicated sessions of your launch profiles
 *   session <profile> [--json]                    one of them
 *   session <profile> --set <session id> [--cwd <dir>] [--from <note>]
 *                                                 continue an existing conversation (e.g. the one
 *                                                 weixin-bridge used — morse plugin ilink import does this)
 *   session <profile> --clear                     forget it: the next message starts a new one
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usage = 'usage: morse plugin dispatch session [<profile>] [--set <session id> [--cwd <dir>] | --clear] [--json]';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runDispatchCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'session') {
    console.error(usage);
    return 64;
  }
  const json = rest.includes('--json');
  const name = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
  const state = createDispatchState();
  const profiles = createLaunchReader({ log: (l) => console.error(l) })().filter((p) => p.dedicated);
  if (!name) {
    const all = state.allDedicated();
    const rows = [...new Set([...profiles.map((p) => p.name!), ...Object.keys(all)])].map((n) => {
      const p = profiles.find((x) => x.name === n);
      return { profile: n, address: `@${DISPATCH_AGENT}:${n}`, configured: Boolean(p), cwd: all[n]?.cwd ?? p?.cwd ?? null, session: all[n]?.sessionId ?? null, whenLive: p?.whenLive ?? null };
    });
    if (json) console.log(JSON.stringify({ dedicated: rows }, null, 2));
    else if (!rows.length) console.log('no dedicated sessions (a launch profile with "dedicated": true, "name" and "cwd" — docs/PLUGINS.md)');
    else for (const r of rows) console.log(`${r.address}  ${r.session ?? '(created on first message)'}  ${r.cwd ?? ''}${r.configured ? '' : '  (no launch profile any more)'}`);
    return 0;
  }
  if (!PROFILE_NAME_RE.test(name)) throw new Error(`"${name}" is not a profile name`);
  const profile = profiles.find((p) => p.name === name);
  const set = flag(rest, '--set');
  if (set !== undefined || rest.includes('--clear')) {
    const unlock = state.lock(`${DISPATCH_AGENT}:${name}`);
    if (!unlock) throw new Error(`a turn is running for @${DISPATCH_AGENT}:${name} right now — try again when it is done`);
    try {
      if (rest.includes('--clear')) {
        state.setDedicated(name, null);
        if (json) console.log(JSON.stringify({ profile: name, session: null }));
        else console.log(`@${DISPATCH_AGENT}:${name}: forgotten — the next message starts a new session`);
        return 0;
      }
      if (!set || !UUID.test(set)) throw new Error('--set needs a session id (a UUID)');
      const cwd = flag(rest, '--cwd') ?? profile?.cwd;
      if (!cwd || !cwd.startsWith('/')) throw new Error(`no launch profile "${name}" with "dedicated": true and a "cwd" yet — add it to plugins.dispatch.launch, or pass --cwd <absolute dir>`);
      const note = flag(rest, '--from');
      state.setDedicated(name, { agent: profile?.agent ?? 'claude', sessionId: set, cwd, createdAt: new Date().toISOString(), ...(note ? { seededFrom: note } : {}) });
      if (json) console.log(JSON.stringify({ profile: name, session: set, cwd }));
      else console.log(`@${DISPATCH_AGENT}:${name} continues session ${set} (in ${cwd})`);
      return 0;
    } finally {
      unlock();
    }
  }
  const rec = state.dedicated(name);
  if (json) console.log(JSON.stringify({ profile: name, configured: Boolean(profile), session: rec?.sessionId ?? null, cwd: rec?.cwd ?? profile?.cwd ?? null, resetPending: Boolean(rec?.resetPending) }));
  else console.log(`@${DISPATCH_AGENT}:${name}: ${rec ? `session ${rec.sessionId} in ${rec.cwd}` : 'no session yet (created on the first message)'}${profile ? '' : ' — no launch profile with this name'}`);
  return 0;
}
