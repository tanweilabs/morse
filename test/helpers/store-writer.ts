import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockHandle, blockedHandles, unblockHandle } from '../../src/cluster/blocklist.js';
import { loadOrCreateIdentity } from '../../src/cluster/identity.js';
import { pinKeyBundle } from '../../src/cluster/morse.js';
import { createTrustStore } from '../../src/cluster/trust.js';
import { updateMachineConfig } from '../../src/machine-config.js';
import { createDispatchState } from '../../src/plugins/dispatch/state.js';
import { register } from '../../src/registry/external.js';
import { writeUpdateState } from '../../src/update/updater.js';

/**
 * One of several processes that change the small JSON stores of ONE Morse home at the
 * same moment (test/file-lock.test.ts): `node --import tsx store-writer.ts <home> <id> <count>`.
 * It says it is ready (a file), waits for the starting signal (a file), then makes
 * `count` changes to every store. Run with id `reader` it only reads the blocklist and
 * fails if the list ever shrinks (a half-written file read as empty).
 */

const [home, id, countArg] = process.argv.slice(2) as [string, string, string];
const count = Number(countArg);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const pause = (ms: number) => Atomics.wait(sleeper, 0, 0, ms);

writeFileSync(join(home, `ready-${id}`), '');
while (!existsSync(join(home, 'go'))) pause(2);

if (id === 'reader') {
  let most = 0;
  while (!existsSync(join(home, 'stop'))) {
    const n = blockedHandles(home).filter((h) => h.endsWith('-keep')).length;
    if (n < most) {
      console.error(`the blocklist shrank from ${most} to ${n} kept handles`);
      process.exit(1);
    }
    most = n;
  }
  process.exit(0);
}

// every process creates the device identity of a fresh home at the same time
const identity = loadOrCreateIdentity(home);
writeFileSync(join(home, `identity-${id}`), identity.id);

const trust = createTrustStore(home);
const config = join(home, '.morse', 'config.json');
const dispatch = createDispatchState(join(home, '.morse', 'plugins', 'dispatch'));
for (let k = 0; k < count; k++) {
  const name = `w${id}-${k}`;
  blockHandle(`${name}-keep`, home);
  blockHandle(`${name}-gone`, home);
  unblockHandle(`${name}-gone`, home);
  trust.add({ id: `DEVICE-${name}`, name, tier: 'peer' });
  updateMachineConfig((cfg) => {
    const seen = (cfg['seen'] ?? {}) as Record<string, number>;
    seen[name] = k;
    cfg['seen'] = seen;
  }, config);
  pinKeyBundle({ id: `DEVICE-${name}` } as never, home);
  writeUpdateState({ detail: name, [`k-${name}`]: k } as never, join(home, '.morse', 'update.json'));
  dispatch.setMark(name, { at: k } as never);
  register({ agent: 'ext', sessionId: 'shared', title: name }, { home });
}
