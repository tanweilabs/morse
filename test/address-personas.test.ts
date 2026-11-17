import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { changes, indistinguishable, message, play, playBoth, LIMITS, MAX_REQUESTS, TWO_CHUNKS, type Scene } from './helpers/indistinguishable.js';

/**
 * (ADR-083) THE claim: someone who knows two of my addresses cannot tell they are on the same computer.
 *
 * Every test below plays one script twice — the observer P first builds some STATE with an address S of
 * the computer H, then runs a FLOW against the address T — once with T = the other address of H, once
 * with T = an address of an unrelated computer, and requires that everything P can observe is identical
 * (test/helpers/indistinguishable.ts says what "everything" is, and what the two accepted limits are).
 *
 *   states   what exists at S because of P (or of others) — everything that used to be kept once per
 *            computer and would have answered for T too before ADR-083
 *   flows    what P does at T, as a normal client and with hand-made envelopes
 *   normal   S = H's first address (the device key's), T = H's second (its own key) vs the unrelated
 *            computer's first address
 *   mirror   S = H's second address, T = H's first vs the unrelated computer's first: the first address
 *            learns nothing from the second either
 *
 * A test that fails here is a leak (or a harness error — those say "harness:"). It is never skipped and
 * nothing it shows is normalised away.
 *
 * ONE difference is known and pinned line by line instead (the "KNOWN DIFFERENCE" block): an old-style
 * envelope (device certificate, no `addr`) is answered the old way by a computer's FIRST address and by
 * address by any other one. It tells "T is not a computer's first address" — not which computer.
 */

// each test waits most of its time (settle windows, P's receipt timeout): several run at once, each in scenes of its own
vi.setConfig({ maxConcurrency: Number(process.env['ADR083_CONCURRENCY']) || 8 });

interface State {
  id: string;
  title: string;
  /** Only a computer's first address can have this state (the old-name path): it has no mirror. */
  firstOnly?: boolean;
  build: (s: Scene) => Promise<void>;
}
interface Flow {
  id: string;
  title: string;
  /** `requestProbeMs` of P's client: 0 = P's client holds nothing back (every send goes out and is answered or not). */
  pProbeMs?: number;
  run: (s: Scene) => Promise<void>;
  /** What the flow must show on the unrelated computer (so that "identical" is not "nothing happened"). */
  shows: RegExp[];
  /** What the flow must NOT show on the unrelated computer (the behaviour nobody doubts). */
  never?: RegExp[];
  /**
   * The flow sends old-style envelopes, which a computer's FIRST address answers the old way (the interop path
   * for clients of the release before, until v2 is removed) and any other address by address: it is compared
   * strictly only between two addresses of the same kind (mirror: first vs first; second vs second) — and
   * second vs first in the KNOWN DIFFERENCE block, where the difference is pinned.
   */
  oldStyle?: boolean;
}

const CONTACT_FILES = 'big-1';
const legacy = (s: Scene, id: string, text: string) => ({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, text, fromHandle: s.P.handle, fromAgent: s.P.agent });

// --- what exists at S ---------------------------------------------------------------------------------

const STATES: State[] = [
  { id: 'S0', title: 'nothing: P never met S', build: async () => undefined },
  {
    id: 'S1',
    title: 'P is an accepted contact of S, with a remark and a group, and a thread both ways',
    build: async (s) => {
      await s.say(s.S, 'hello S');
      await s.owner(s.S).accept();
      await s.owner(s.S).set({ remark: 'pal', group: 'colleague' });
      await s.owner(s.S).reply('hello S', 'welcome to S');
      await s.reply(s.S, 'welcome to S', 'glad to be here');
    },
  },
  {
    id: 'S2',
    title: 'P is blocked at S',
    build: async (s) => {
      await s.say(s.S, 'hello S');
      await s.owner(s.S).block();
    },
  },
  {
    id: 'S3',
    title: 'P has a pending message request at S',
    build: async (s) => {
      await s.say(s.S, 'hello S');
      await s.say(s.S, 'still waiting at S');
    },
  },
  {
    id: 'S4',
    title: 'P was a contact of S and was removed (a tombstone)',
    build: async (s) => {
      await s.say(s.S, 'hello S');
      await s.owner(s.S).accept();
      await s.owner(s.S).remove();
    },
  },
  {
    id: 'S5',
    title: `the message requests of S are full (${MAX_REQUESTS} strangers)`,
    build: async (s) => {
      await s.strangersWrite(s.S, MAX_REQUESTS);
    },
  },
  {
    id: 'S6',
    title: 'S has dedupe marks for the very message ids the flow uses (and filed a chunked message with the same id)',
    build: async (s) => {
      await s.owner(s.S).add();
      for (const id of ['fix-1', 'fix-2', 'fix-3']) await s.raw(s.S, message(id, `${id}, filed at S`));
      await s.raw(s.S, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.S, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
      await s.rawChunk(s.S, TWO_CHUNKS.chunk(CONTACT_FILES, 1));
      // every other id (the ones P's client makes up, the flow's own hand-made ones) is marked at S, through
      // the store, right before T first sees it
      s.seedDedupeAtS = true;
    },
  },
  {
    id: 'S7',
    title: 'P has a chunked transfer in progress with S (staged, one chunk of two) — the same message id the flow sends',
    build: async (s) => {
      await s.owner(s.S).add();
      await s.raw(s.S, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.S, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
    },
  },
  {
    id: 'S8',
    title: `P ran into the receive limit of S (${LIMITS.perSenderPerMinute} a minute per sender), and S's total (${LIMITS.totalPerMinute} a minute) is used up by others`,
    build: async (s) => {
      for (let i = 1; i <= LIMITS.perSenderPerMinute + 1; i++) await s.raw(s.S, message(`s-lim-${i}`, `to S, ${i}`));
      await s.strangersWrite(s.S, 1, LIMITS.totalPerMinute - LIMITS.perSenderPerMinute + 1);
    },
  },
  {
    id: 'S9',
    title: 'P is a contact of the computer the OLD way (handle + device certificate: the first address only)',
    firstOnly: true,
    build: async (s) => {
      await s.pairTheOldWay();
    },
  },
];

// --- what P does at T ------------------------------------------------------------------------------------

const bigFile = (s: Scene) => s.file('big.bin', 150 * 1024);

const FLOWS: Flow[] = [
  {
    id: 'F1',
    title: 'the first message as a stranger',
    shows: [/"request":"filed"/, /"request":true/],
    run: async (s) => {
      await s.lookup(s.T);
      await s.say(s.T, 'hello');
    },
  },
  {
    id: 'F2',
    title: 'a second message while the request is pending, and the same message id again',
    shows: [/"request":"dropped"/, /waiting for morse\.im\/<T> to accept/],
    run: async (s) => {
      await s.raw(s.T, message('fix-1', 'first, hand-made'));
      await s.raw(s.T, message('fix-2', 'second, hand-made'));
      await s.raw(s.T, message('fix-1', 'first, hand-made'));
      await s.say(s.T, 'from the client');
      await s.say(s.T, 'held by the client');
    },
  },
  {
    id: 'F3',
    title: 'the owner accepts: the notice, the held message, replies both ways, a duplicate',
    shows: [/"kind":"accepted"/, /accepted your message request/, /"text":"welcome"/, /"text":"a new thread from me"/],
    run: async (s) => {
      const first = await s.say(s.T, 'hello');
      await s.say(s.T, 'more, while you decide');
      await s.owner(s.T).accept();
      await s.outbox();
      await s.owner(s.T).reply('hello', 'welcome');
      await s.reply(s.T, 'welcome', 'thank you');
      await s.owner(s.T).write('a new thread from me');
      await s.reply(s.T, 'a new thread from me', 'got it');
      await s.raw(s.T, message('fix-1', 'hand-made, as a contact'));
      await s.raw(s.T, message('fix-1', 'hand-made, as a contact'));
      await s.again(s.T, first!);
    },
  },
  {
    id: 'F4',
    title: 'the owner blocks the stranger P; P writes again; unblocked, P is a stranger again',
    pProbeMs: 0,
    shows: [/forwarded but no receipt/, /"envelope for P":"nothing"/, /"kind":"receipt","id":"fix-2"/],
    run: async (s) => {
      await s.say(s.T, 'hello');
      await s.owner(s.T).block();
      await s.say(s.T, 'are you there?');
      await s.raw(s.T, message('fix-1', 'hand-made, while blocked'));
      await s.owner(s.T).unblock();
      await s.raw(s.T, message('fix-2', 'hand-made, unblocked'));
    },
  },
  {
    id: 'F4b',
    title: 'the owner blocks the CONTACT P; P writes again (a message, a chunked one)',
    pProbeMs: 0,
    shows: [/"kind":"accepted"/, /forwarded but no receipt/],
    run: async (s) => {
      await s.say(s.T, 'hello');
      await s.owner(s.T).accept();
      await s.owner(s.T).block();
      await s.say(s.T, 'are you there?');
      await s.raw(s.T, message('fix-1', 'hand-made, while blocked'));
      await s.raw(s.T, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
    },
  },
  {
    id: 'F5',
    title: 'the owner removes the contact P; P writes again and is a stranger; accepted once more',
    shows: [/"P sends":"after you removed me".*"request":true/, /"id":"fix-1","request":"dropped"/, /"kind":"receipt","id":"fix-1"\}/],
    run: async (s) => {
      await s.say(s.T, 'hello');
      await s.owner(s.T).accept();
      await s.owner(s.T).remove();
      await s.say(s.T, 'after you removed me');
      await s.raw(s.T, message('fix-1', 'hand-made, after the removal'));
      await s.owner(s.T).accept();
      await s.raw(s.T, message('fix-1', 'hand-made, after the removal'));
    },
  },
  {
    id: 'F6',
    title: "T's own message requests are full (strangers); P writes; one is rejected; P gets in",
    pProbeMs: 0,
    shows: [/"request":"dropped","full":true/, /their message requests are full/, /"request":true/],
    run: async (s) => {
      await s.strangersWrite(s.T, MAX_REQUESTS);
      const m = await s.say(s.T, 'hello');
      await s.raw(s.T, message('fix-1', 'hand-made, no room'));
      await s.owner(s.T).rejectAStranger();
      await s.again(s.T, m!);
    },
  },
  {
    id: 'F7',
    title: 'rekey: an envelope sealed to a prekey T does not have (hand-made; and after T lost its prekeys while away)',
    shows: [/"kind":"rekey","ref":"rk-1"/, /left in the relay's offline mailbox/, /could not open it \(an old key\)|sent again with their new prekey/],
    run: async (s) => {
      await s.raw(s.T, message('rk-1', 'sealed to a prekey you never had'), { wrongPrekey: true, ref: 'rk-1' });
      await s.owner(s.T).goAway();
      await s.say(s.T, 'while you were away');
      s.owner(s.T).losePrekeys();
      await s.owner(s.T).comeBack();
      await s.outbox();
    },
  },
  {
    id: 'F8a',
    title: 'a chunked file to T as a contact: hand-made chunk by chunk, then by the normal client',
    shows: [/"kind":"transfer","id":"big-1","have":\[\[\]\]/, /"kind":"receipt","id":"big-1","chunked":true/, /"unknown":true/, /delivered via relay — 5\/5 chunks/],
    run: async (s) => {
      await s.say(s.T, 'hello');
      await s.owner(s.T).accept();
      await s.rawChunk(s.T, TWO_CHUNKS.chunk('big-0', 1)); // a chunk of a message never offered HERE (S7: the same file is staged at S)
      await s.raw(s.T, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 1));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 1)); // a late chunk of a message that is filed
      await s.raw(s.T, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest })); // the offer again
      await s.rawChunk(s.T, TWO_CHUNKS.chunk('never-offered', 0));
      let big: Awaited<ReturnType<Scene['say']>> = null;
      await s.condensed('the chunked message of the normal client', async () => {
        big = await s.say(s.T, 'a big file', { files: [bigFile(s)] });
        await s.transferOver(big!);
      });
      await s.outbox();
    },
  },
  {
    id: 'F8b',
    title: 'a chunked file to T as a stranger: the normal client, then hand-made',
    pProbeMs: 0,
    shows: [/request pending, via relay\) — no files sent/, /"id":"big-2","request":"dropped"/],
    run: async (s) => {
      let big: Awaited<ReturnType<Scene['say']>> = null;
      await s.condensed('the chunked message of the normal client', async () => {
        big = await s.say(s.T, 'a big file', { files: [bigFile(s)] });
        await s.transferOver(big!);
      });
      await s.outbox();
      await s.raw(s.T, message('big-2', 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk('big-2', 0));
    },
  },
  {
    id: 'F9',
    title: 'receipts after the recipient restarted: the same id again as a stranger, as a contact, a late duplicate',
    shows: [/"id":"fix-1","request":"filed"/, /"kind":"receipt","id":"fix-1"\}/, /"kind":"receipt","id":"fix-3"\}/],
    run: async (s) => {
      await s.raw(s.T, message('fix-1', 'hand-made, before the restart'));
      await s.owner(s.T).restart();
      await s.raw(s.T, message('fix-1', 'hand-made, before the restart'));
      await s.raw(s.T, message('fix-2', 'hand-made, another one'));
      await s.owner(s.T).accept();
      await s.owner(s.T).restart();
      await s.raw(s.T, message('fix-1', 'hand-made, before the restart'));
      await s.raw(s.T, message('fix-3', 'hand-made, as a contact'));
      const m = await s.say(s.T, 'from the client');
      await s.owner(s.T).restart();
      await s.again(s.T, m!);
      await s.raw(s.T, message('fix-3', 'hand-made, as a contact'));
    },
  },
  {
    id: 'F10a',
    title: `T's own receive limit, per sender (${LIMITS.perSenderPerMinute} a minute)`,
    pProbeMs: 0,
    shows: [new RegExp(`"id":"lim-${LIMITS.perSenderPerMinute}","request":"dropped"`), /forwarded but no receipt/],
    run: async (s) => {
      for (let i = 1; i <= LIMITS.perSenderPerMinute + 1; i++) await s.raw(s.T, message(`lim-${i}`, `to T, ${i}`));
      await s.say(s.T, 'one more, from the client');
    },
  },
  {
    id: 'F10b',
    title: `T's own receive limit, in total (${LIMITS.totalPerMinute} a minute, most of it used by a stranger)`,
    pProbeMs: 0,
    shows: [/"id":"lim-1","request":"filed"/, /forwarded but no receipt/],
    run: async (s) => {
      const left = 4;
      await s.strangersWrite(s.T, 1, LIMITS.totalPerMinute - left);
      for (let i = 1; i <= left + 1; i++) await s.raw(s.T, message(`lim-${i}`, `to T, ${i}`));
      await s.say(s.T, 'one more, from the client');
    },
  },
  // The old path (handle + device certificate) is the first address's alone (ADR-083 §1: "the second address
  // never ends up on that path"). What P sends here is what a client of the release before ADR-081 puts on the
  // wire, sealed to T: whatever comes back must not be signed by another address, carry a device certificate
  // that is not T's to show, or depend on what the computer's old-way contacts / limits / requests are.
  {
    id: 'F11',
    oldStyle: true,
    title: "a hand-made envelope the OLD way: P's device certificate attached, no `addr` (what the release before sent)",
    shows: [/P forges/],
    run: async (s) => {
      await s.raw(s.T, legacy(s, 'leg-1', 'the old way, with my certificate'), { cert: true });
      await s.raw(s.T, legacy(s, 'leg-2', 'the old way, again'), { cert: true });
      // …one that says "by address" although it carries the certificate, and a chunk with the certificate
      await s.raw(s.T, message('leg-3', 'by address, certificate attached'), { cert: true });
      await s.rawChunk(s.T, TWO_CHUNKS.chunk('leg-4', 0), { cert: true });
    },
  },
  {
    id: 'F12',
    title: 'morse.strangers "accept" on T\'s computer: whoever writes is a contact at once',
    shows: [/"P sends":"hello".*"morse.send returned":\{"ok":true,"via":"relay"\}/, /"text":"welcome"/],
    run: async (s) => {
      await s.owner(s.T).strangers('accept');
      await s.say(s.T, 'hello');
      await s.raw(s.T, message('fix-1', 'hand-made'));
      await s.owner(s.T).reply('hello', 'welcome');
      await s.reply(s.T, 'welcome', 'thank you');
    },
  },
  {
    id: 'F13',
    title: 'morse.strangers "block" on T\'s computer: a stranger gets no answer of any kind',
    pProbeMs: 0,
    shows: [/forwarded but no receipt/, /"envelope for P":"nothing"/],
    run: async (s) => {
      await s.owner(s.T).strangers('block');
      await s.say(s.T, 'hello');
      await s.raw(s.T, message('fix-1', 'hand-made'));
      await s.raw(s.T, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
    },
  },
  {
    id: 'F14',
    title: 'P answers at T for mail that S sent it: a receipt, a rekey notice, a transfer answer, "accepted" (hand-made)',
    shows: [/"P forges":\{"kind":"accepted"\}/, /"P sends":"hello"/],
    run: async (s) => {
      // (the ids of whatever S sent P while the state was built — none in most states — and one that nobody sent)
      const ids = [...s.receivedFrom(s.S), 'never-sent'];
      await s.raw(s.T, { kind: 'accepted' });
      for (const id of ids) {
        await s.raw(s.T, { kind: 'receipt', id });
        await s.raw(s.T, { kind: 'receipt', id, request: 'dropped' });
        await s.raw(s.T, { kind: 'rekey', ref: id });
        await s.raw(s.T, { kind: 'transfer', id, unknown: true });
      }
      // had any of it counted for S, S would now send something again (or stop holding something back)
      await s.owner(s.S).outbox();
      await s.owner(s.T).outbox();
      await s.say(s.T, 'hello');
    },
  },
  {
    id: 'F15',
    title: 'the owner of T added P as a contact first (`morse contact add`): P\'s first message is filed at once',
    shows: [/"P sends":"hello".*"morse.send returned":\{"ok":true,"via":"relay"\}/, /"kind":"receipt","id":"big-1","chunked":true/],
    run: async (s) => {
      await s.owner(s.T).add({ group: 'colleague' });
      await s.say(s.T, 'hello');
      await s.raw(s.T, message(CONTACT_FILES, 'two chunks', { chunked: TWO_CHUNKS.manifest }));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 1));
      await s.rawChunk(s.T, TWO_CHUNKS.chunk(CONTACT_FILES, 0));
      await s.owner(s.T).write('nice to have you');
    },
  },
  // (ADR-083 review R1) Which prekey an answer is sealed to is something P observes. P replaces its prekey AFTER
  // whatever it did at S (in most states S has looked P up and remembers prekey #1 for ten minutes) and BEFORE it
  // ever writes to T: T has never looked P up, so everything T sends must be sealed to #2 — as on a computer that
  // has nothing to do with S. One lookup cache for the whole computer answered with #1 here.
  {
    id: 'F16',
    title: 'P replaces its prekey, then writes to T for the first time: a stranger, accepted, answered — everything T sends is sealed to the new prekey',
    shows: [/"sealed to":"P's prekey #2".*"kind":"receipt","id":"fix-1","request":"filed"/, /"sealed to":"P's prekey #2".*"kind":"accepted"/, /"sealed to":"P's prekey #2".*"text":"welcome"/],
    never: [/"sealed to":"(?!P's prekey #2")/],
    run: async (s) => {
      await s.rotatesPrekey();
      await s.lookup(s.T);
      await s.raw(s.T, message('fix-1', 'hand-made, after my new prekey'));
      await s.say(s.T, 'from the client, after my new prekey');
      await s.owner(s.T).accept();
      await s.outbox();
      await s.raw(s.T, message('fix-2', 'hand-made, as a contact'));
      await s.owner(s.T).reply('hand-made, after my new prekey', 'welcome');
      await s.reply(s.T, 'welcome', 'thank you');
    },
  },
];

const scripted = (state: State, flow: Flow) => ({
  script: async (s: Scene) => {
    s.note(`STATE ${state.id}: ${state.title}`);
    await state.build(s);
    await s.snapshot('before the flow');
    s.beginFlow(`FLOW ${flow.id}: ${flow.title}`);
    await flow.run(s);
  },
  checks: {
    baseline: (lines: string[]) => {
      const from = lines.findIndex((l) => l.startsWith('{"story":"FLOW '));
      const part = lines.slice(from).join('\n');
      for (const re of flow.shows) if (!re.test(part)) throw new Error(`nothing in the transcript matches ${re}`);
      for (const re of flow.never ?? []) if (re.test(part)) throw new Error(`the transcript matches ${re}, which this flow must never show`);
    },
    inspect: (s: Scene, sameHome: boolean) => {
      // a flow that is not about the limit must not run into T's own limit on the unrelated computer (the scenes
      // would then compare two refusals). On the same computer it is not checked here: there it would be a leak,
      // and the transcripts show it.
      if (!sameHome && !flow.id.startsWith('F10') && s.hostLogsOfFlow().some((l) => /rate limit — dropping/.test(l))) throw new Error(`harness: flow ${flow.id} ran into the receive limit of T`);
    },
  },
});

describe.concurrent('ADR-083 — what P observes at T does not depend on what exists at S (S = the first address, T = the second | an unrelated computer)', () => {
  // (a flow of old-style envelopes is not in this table: T here is a second address, the unrelated computer's a first one — see `oldStyle`)
  for (const flow of FLOWS.filter((f) => !f.oldStyle)) {
    for (const state of STATES) {
      it(`${flow.id} × ${state.id} — ${flow.title} — when ${state.title}`, async () => {
        const { script, checks } = scripted(state, flow);
        await indistinguishable(`${flow.id} × ${state.id}`, flow.pProbeMs !== undefined ? { pProbeMs: flow.pProbeMs } : {}, script, checks);
      }, 60_000);
    }
  }
});

describe.concurrent('ADR-083 — the mirror: the first address gains nothing from the second (S = the second address, T = the first | an unrelated computer)', () => {
  for (const flow of FLOWS) {
    for (const state of STATES.filter((x) => !x.firstOnly)) {
      it(`mirror ${flow.id} × ${state.id} — ${flow.title} — when ${state.title}`, async () => {
        const { script, checks } = scripted(state, flow);
        await indistinguishable(`mirror ${flow.id} × ${state.id}`, { mirror: true, ...(flow.pProbeMs !== undefined ? { pProbeMs: flow.pProbeMs } : {}) }, script, checks);
      }, 60_000);
    }
  }
});

// --- old-style envelopes (F11) at H's second address ---------------------------------------------------------
//
// Strict: T = H's second address vs the SECOND address of the unrelated computer. Both answer by address, so the
// transcripts must be identical in every state — nothing of S (its address, the computer's device certificate,
// its limits, its old-way contacts) may show at T.
describe.concurrent('ADR-083 — the old-style envelope: H\'s second address vs the SECOND address of an unrelated computer — identical', () => {
  const flow = FLOWS.find((f) => f.id === 'F11')!;
  for (const state of STATES) {
    it(`F11 (second vs second) × ${state.id} — ${flow.title} — when ${state.title}`, async () => {
      const { script, checks } = scripted(state, flow);
      await indistinguishable(`F11 (second vs second) × ${state.id}`, { elsewhereSecond: true }, script, checks);
    }, 60_000);
  }
});

// Known difference: T = H's second address vs the FIRST address of the unrelated computer. A first address
// still answers an old-style stranger the old way, with its device certificate — the interop path for clients
// of the release before, until v2 is removed (stage 3, ADR-091); any other address answers by address. (Since
// ADR-091 stage 1 the request itself is by address at both: only the form of those answers differs.) That cannot be identical,
// and it is not hidden: the difference is pinned here line by line, for every state, together with the proof
// that it says nothing about S — what P observes at H's second address is one fixed list of lines, the same in
// every state S0…S9 (and, by the strict block above, the same as at an unrelated computer's second address).
describe.concurrent('KNOWN DIFFERENCE (ADR-083, until v2 is removed): an old-style certificate envelope tells a first address from another address — and nothing else', () => {
  const flow = FLOWS.find((f) => f.id === 'F11')!;
  const story = { story: `FLOW ${flow.id}: ${flow.title}` };
  const oldStyle = (id: string, text: string) => ({ kind: 'message', id, contextId: id, from: { agent: 'claude', sessionId: '' }, to: { agent: 'user', sessionId: '' }, text, fromHandle: '<P-computer.handle>', fromAgent: '<P.name>' });
  const forged = (plain: unknown) => ({ 'P forges': plain, with: "P's device certificate", to: '<T>', 'the relay answered': 'sent' });
  const forgedChunk = { 'P forges a chunk': { kind: 'chunk', id: 'leg-4', f: 0, seq: 0, n: 2, sha256: TWO_CHUNKS.sha }, with: "P's device certificate", to: '<T>', 'the relay answered': 'sent' };
  const fromP = { 'envelope from P': { to: '<T>', relay: 'sent' } };
  const receipt = (certificate: string, content: Record<string, unknown>) => ({ 'envelope for P': { 'relay says from': '<T>', 'signed by': '<T>', certificate, 'sealed to': "P's prekey #1", relay: 'sent', content } });
  const byAddress = (id: string, request: 'filed' | 'dropped') => receipt('none', { kind: 'receipt', id, request });
  const theOldWay = (id: string, request: 'filed' | 'dropped') => receipt('certificate of <T-computer.device>', { kind: 'receipt', id, request });
  // (P's client knows no such device: the certificate-carrying receipt is nobody's it wrote to)
  const pDropsIt = { "P's log": 'relay: dropped message from UNPAIRED device <T-computer.device> — if you know them: morse pair add <their handle>' };

  // THE PINNED DIFFERENCE — every line that is not in both transcripts, in order.
  //   at H's second address: answered by address — signed by T, no certificate; ONE message request, keyed by
  //   P's address (the second old-style message and the one that says `addr: 1` are "dropped": it waits already)
  //   (ADR-091) …and at a first address the same ONE request by P's address: only the two answers to the old-style
  //   messages carry that computer's certificate — the form a client of the release before reads. The message that
  //   says `addr: 1` is answered by address at both.
  const ONLY_AT_ANOTHER_ADDRESS = [byAddress('leg-1', 'filed'), byAddress('leg-2', 'dropped')];
  const ONLY_AT_A_FIRST_ADDRESS = [theOldWay('leg-1', 'filed'), theOldWay('leg-2', 'dropped')];
  void pDropsIt;

  // Everything P observes at H's second address from the start of the flow — the same lines in EVERY state.
  const AT_ANOTHER_ADDRESS = [
    story,
    forged(oldStyle('leg-1', 'the old way, with my certificate')),
    fromP,
    byAddress('leg-1', 'filed'),
    forged(oldStyle('leg-2', 'the old way, again')),
    fromP,
    byAddress('leg-2', 'dropped'),
    forged(message('leg-3', 'by address, certificate attached')),
    fromP,
    byAddress('leg-3', 'dropped'),
    forgedChunk,
    fromP,
    { 'envelope for P': 'nothing' },
  ];

  const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  /** The flow's part of a transcript, without the mailbox at the end (P's own rows for S are in there — P's doing, not T's). */
  const flowOf = (lines: string[]) => lines.slice(lines.findIndex((l) => l.startsWith('{"story":"FLOW ')), -1);
  /** P's mailbox as a transcript shows it under `label` (the label left out). */
  const mailbox = (lines: string[], label: string) => {
    const { "P's mailbox": _label, ...rest } = parsed(lines).find((e) => e["P's mailbox"] === label)!;
    return rest;
  };

  for (const state of STATES) {
    it(`F11 (second vs first) × ${state.id} — the difference is exactly the pinned one — when ${state.title}`, async () => {
      const { script, checks } = scripted(state, flow);
      const { same, other } = await playBoth(`F11 known difference × ${state.id}`, {}, script, {
        ...checks,
        inspect: (s, sameHome) => {
          checks.inspect(s, sameHome);
          // what each computer kept (not an observation of P's): by address at the second address, the old way at a first
          const d = s.T.dev;
          const [byHandle, atT] = [d.mailbox.requests.get(s.P.handle, ''), d.mailbox.requests.get(s.P.address, s.T.my)];
          if (sameHome) {
            expect(d.mailbox.requests.find(s.P.handle)).toEqual([]);
            expect(atT).toMatchObject({ myAddress: s.T.address, handle: s.P.address, deviceId: s.P.address, toAddress: s.T.address, msgId: 'leg-1', count: 3 });
            expect(atT!.fromAgent).toBeUndefined();
          } else {
            // (ADR-091) at a first address too the old-style envelopes are decided by the address that signed them:
            // one request, by address — only the form of the answers still differs (they carry the certificate)
            expect(byHandle).toBeUndefined();
            expect(atT).toMatchObject({ handle: s.P.address, deviceId: s.P.address, toAddress: s.T.address, msgId: 'leg-1', count: 3 });
            expect(atT!.fromAgent).toBeUndefined();
          }
        },
      });

      // (1) the two transcripts differ in the pinned lines and in nothing else
      const diff = changes(same, other);
      expect(parsed(diff.onlySameComputer)).toEqual(ONLY_AT_ANOTHER_ADDRESS);
      expect(parsed(diff.onlyOtherComputer)).toEqual(ONLY_AT_A_FIRST_ADDRESS);

      // (2) nothing of S shows at H's second address: what P observes there is the one fixed list, whatever the state …
      expect(parsed(flowOf(same))).toEqual(AT_ANOTHER_ADDRESS);
      // … said once more in so many words: no address but T's and P's own, no computer's device id, handle or certificate
      for (const line of flowOf(same)) expect(line).not.toMatch(/<S[>~.-]|<E\d|-computer\.device|certificate of|<[STE]\d*-computer\.handle>/);
      // … and P's own mailbox is what it was before the flow (the old-style envelopes made no row, contact or request)
      expect(mailbox(same, 'at the end')).toEqual(mailbox(same, 'before the flow'));
      expect(mailbox(other, 'at the end')).toEqual(mailbox(other, 'before the flow'));
    }, 60_000);
  }
});

// --- H is the sender, P the observer ------------------------------------------------------------------------

describe.concurrent('ADR-083 — sender side: what P receives from T does not depend on what S has going with P', () => {
  const told = async (s: Scene, who: Scene['T'], r: unknown) => s.ownerWasTold(who, await r);

  for (const mirror of [false, true]) {
    const tag = mirror ? 'mirror ' : '';
    it(`${tag}S has a pending message request at P; T writes; T's computer restarts; P accepts S — nothing of T's is released or probed by it`, async () => {
      await indistinguishable(`${tag}sender side: a request of S pending at P`, { mirror }, async (s) => {
        // S writes first: one request at P, a second message held on S's computer
        await told(s, s.S, s.owner(s.S).write('hello from S'));
        await told(s, s.S, s.owner(s.S).write('more from S (held)'));
        await s.snapshot('S waits at P');
        // T writes: a request of its own at P (not "dropped — they have a request from you already")
        await told(s, s.T, s.owner(s.T).write('hello from T'));
        await told(s, s.T, s.owner(s.T).write('more from T (held)'));
        await told(s, s.T, s.owner(s.T).outbox());
        // the computer of T restarts: what is held for P stays held — per pair (one probe each, of their own)
        await s.owner(s.T).restart();
        await told(s, s.T, s.owner(s.T).write('from T, after the restart'));
        await told(s, s.T, s.owner(s.T).write('from T, once more'));
        await s.snapshot('both wait at P');
        // P accepts S, and only S
        await s.accepts(s.S);
        await told(s, s.S, s.owner(s.S).outbox());
        await told(s, s.T, s.owner(s.T).outbox());
        await told(s, s.T, s.owner(s.T).write('from T, while S is in'));
        await s.reply(s.S, 'hello from S', 'hello S, welcome');
        await told(s, s.T, s.owner(s.T).outbox());
        await s.snapshot('S accepted, T still waits');
        // then T
        await s.accepts(s.T);
        await told(s, s.T, s.owner(s.T).outbox());
      }, {
        baseline: (lines) => {
          const all = lines.join('\n');
          for (const re of [/"text":"hello from T"/, /"P accepts the message request of":"<S>","ok":true/, /"P accepts the message request of":"<T>","ok":true/, /"text":"from T, while S is in"|"text":"more from T \(held\)"/]) if (!re.test(all)) throw new Error(`nothing in the transcript matches ${re}`);
        },
      });
    }, 60_000);

    it(`${tag}S has a pending message request at P and holds mail for it; P writes to T — nothing S holds is released by that`, async () => {
      await indistinguishable(`${tag}sender side: P writes to T while S waits at P`, { mirror }, async (s) => {
        await told(s, s.S, s.owner(s.S).write('hello from S'));
        await told(s, s.S, s.owner(s.S).write('more from S (held)'));
        // P tells T "accepted" (hand-made), then writes to T (a stranger there): for S's computer "they accepted" /
        // "they wrote to you" is true of T only
        await s.raw(s.T, { kind: 'accepted' });
        await told(s, s.S, s.owner(s.S).outbox());
        await s.say(s.T, 'hello T');
        await told(s, s.S, s.owner(s.S).outbox());
        await s.owner(s.T).accept();
        await told(s, s.T, s.owner(s.T).reply('hello T', 'welcome'));
        await told(s, s.S, s.owner(s.S).outbox());
        await told(s, s.S, s.owner(s.S).write('S, still waiting'));
      }, {
        baseline: (lines) => {
          const all = lines.join('\n');
          for (const re of [/"text":"hello from S"/, /"text":"welcome"/, /"the owner was told":\{"ok":false,"waiting":true,"error":"waiting for morse\.im\/<P> to accept your message request[^}]*\},"at":"<S>"/]) if (!re.test(all)) throw new Error(`nothing in the transcript matches ${re}`);
        },
      });
    }, 60_000);

    it(`${tag}P blocked S / P is a contact of S / S's message requests at P are answered "dropped": T is a plain stranger to P's computer either way`, async () => {
      await indistinguishable(`${tag}sender side: P blocked S`, { mirror }, async (s) => {
        await told(s, s.S, s.owner(s.S).write('hello from S'));
        // P's computer blocks S (declines its request)
        s.P.mailbox.requests.remove(s.S.address);
        s.P.mailbox.contacts.blockAt(s.S.address);
        s.note('P blocks <S>');
        await told(s, s.S, s.owner(s.S).write('S again, blocked'));
        await told(s, s.T, s.owner(s.T).write('hello from T'));
        await s.accepts(s.T);
        await told(s, s.T, s.owner(s.T).outbox());
        await told(s, s.T, s.owner(s.T).write('T, as a contact of P'));
        await s.reply(s.T, 'hello from T', 'hello T');
      }, {
        baseline: (lines) => {
          const all = lines.join('\n');
          for (const re of [/"text":"hello from T"/, /"text":"T, as a contact of P"/]) if (!re.test(all)) throw new Error(`nothing in the transcript matches ${re}`);
        },
      });
    }, 60_000);
  }
});

// --- the caches of one address are not another's (ADR-083 review R1) ------------------------------------------------
//
// F16 (in the tables above, every state, both directions) is the review's scenario: P writes to S, replaces its
// prekey, writes to T for the first time. The cases here are the other two places where something one address
// had learned about P decided what ANOTHER address of the same computer did. Each plays, like every test of this
// file, once with T = the other address of S's computer and once with T = an unrelated computer.
describe.concurrent('ADR-083 — what one address knows about P (its prekey, how it reaches P) is not what another address goes by', () => {
  const told = async (s: Scene, who: Scene['T'], r: unknown) => s.ownerWasTold(who, await r);

  // The device path (old name + certificate) is the first address's alone, and so is its per-device prekey cache.
  // A "rekey" notice that arrives BY ADDRESS at another address of the computer used to empty that cache too: the
  // first address then answered P's next old-way message sealed to P's new prekey, where a computer that never got
  // the notice goes on with the one it had looked up (#1, which P still holds).
  // (ADR-091, stage 2) removed: "S answers P the old way and remembers P's prekey…" — its premise (the old way: an old name, a device path) is gone.

  // Whether mail to the ADDRESS of a device paired the old way goes by address or over the device path depends on
  // whether that address ever wrote "by address" — to the address that now writes (the first), not to another one
  // of the same computer.
  it('S is paired with P the old way; P writes to T by address and is accepted there; S writes to P\'s address: it goes the way it would have gone anyway', async () => {
    await indistinguishable('R1: mail P wrote to T does not change how S reaches P', {}, async (s) => {
      await s.pairTheOldWay();
      await s.say(s.T, 'hello T, by address');
      await s.owner(s.T).accept();
      await told(s, s.S, s.owner(s.S).write('from S, to your address'));
      await told(s, s.T, s.owner(s.T).reply('hello T, by address', 'welcome, from T'));
    }, {
      baseline: (lines) => {
        const all = lines.join('\n');
        // (ADR-091) S → P and T → P: both by address — a computer paired the old way is reached by its address too
        for (const re of [/"signed by":"<S>","certificate":"none".*"text":"from S, to your address"/, /"signed by":"<T>","certificate":"none".*"text":"welcome, from T"/]) if (!re.test(all)) throw new Error(`nothing in the transcript matches ${re}`);
      },
    });
  }, 60_000);
});

// --- inside H: every row belongs to one address -----------------------------------------------------------------

describe('ADR-083 — inside the computer: P\'s rows are kept strictly per address', () => {
  const sql = <R>(s: Scene, q: string, ...params: unknown[]): R[] => s.H.db.prepare(q).all(...params) as R[];

  it('requests, contacts, blocks, tombstones, dedupe marks and messages of P at A and at B never touch each other', async () => {
    await play({ sameHome: true }, async (s) => {
      const { A, B, P } = s;
      const p = P.address;
      const contacts = () => sql<{ id: string; my_address: string; state: string; remark: string | null; group_label: string }>(s, 'SELECT id, my_address, state, remark, group_label FROM contacts WHERE address = ? ORDER BY my_address', p);
      const requests = () => sql<{ my_address: string; handle: string; msg_id: string; to_address: string | null }>(s, 'SELECT my_address, handle, msg_id, to_address FROM morse_requests WHERE handle = ? ORDER BY my_address', p);
      const blocks = () => sql<{ my_address: string }>(s, 'SELECT my_address FROM address_blocks WHERE address = ? ORDER BY my_address', p).map((r) => r.my_address);
      const seen = () => sql<{ from_id: string; msg_id: string }>(s, "SELECT from_id, msg_id FROM inbound_seen WHERE msg_id LIKE 'same-%' ORDER BY msg_id, from_id");
      const marks = () => new Set(sql<{ key: string }>(s, "SELECT key FROM migration_marks WHERE key LIKE 'removed:%'").map((r) => r.key));
      const inbound = () => s.messagesOf(s.H).filter((m) => m.direction === 'in' && m.from.device === p).map((m) => ({ text: m.parts[0]!.text, my: m.myAddress, contact: m.contactId }));

      // the same message id to both addresses, as a stranger: one request per address
      await s.raw(A, message('same-1', 'one id, to A'));
      await s.raw(B, message('same-1', 'one id, to B'));
      expect(requests()).toEqual([
        { my_address: '', handle: p, msg_id: 'same-1', to_address: A.address },
        { my_address: B.address, handle: p, msg_id: 'same-1', to_address: B.address },
      ]);
      expect(contacts()).toEqual([]);

      // accepting P at B makes no contact at A, and leaves A's request waiting
      await s.owner(B).accept();
      expect(contacts()).toEqual([{ id: `a:${p}~${B.address}`, my_address: B.address, state: 'active', remark: null, group_label: 'other' }]);
      expect(requests()).toEqual([{ my_address: '', handle: p, msg_id: 'same-1', to_address: A.address }]);
      expect(s.H.mailbox.contacts.byAddress(p, '')).toBeNull();
      expect(inbound()).toEqual([{ text: 'one id, to B', my: B.address, contact: `a:${p}~${B.address}` }]);

      // …then at A: a second, separate contact — its own id, remark and group
      await s.owner(A).accept();
      await s.owner(A).set({ remark: 'p at a', group: 'colleague' });
      await s.owner(B).set({ remark: 'p at b' });
      expect(contacts()).toEqual([
        { id: `a:${p}`, my_address: '', state: 'active', remark: 'p at a', group_label: 'colleague' },
        { id: `a:${p}~${B.address}`, my_address: B.address, state: 'active', remark: 'p at b', group_label: 'other' },
      ]);
      expect(requests()).toEqual([]);

      // one message id sent to A and to B is filed twice — once per address, each under its own contact
      await s.raw(A, message('same-2', 'a second id, to A'));
      await s.raw(B, message('same-2', 'a second id, to B'));
      await s.raw(B, message('same-2', 'a second id, to B')); // (a duplicate at B is still one)
      expect(inbound()).toEqual([
        { text: 'one id, to B', my: B.address, contact: `a:${p}~${B.address}` },
        { text: 'one id, to A', my: A.address, contact: `a:${p}` },
        { text: 'a second id, to A', my: A.address, contact: `a:${p}` },
        { text: 'a second id, to B', my: B.address, contact: `a:${p}~${B.address}` },
      ]);
      expect(seen()).toEqual([
        { from_id: p, msg_id: 'same-1' },
        { from_id: `${p}|${B.address}`, msg_id: 'same-1' },
        { from_id: p, msg_id: 'same-2' },
        { from_id: `${p}|${B.address}`, msg_id: 'same-2' },
      ]);

      // a thread the owner started from A: P's answer counts as "in my own thread" at A only — the same thread id
      // written to B is ordinary mail for B's mailbox (ADR-071 is decided per contact, and those are two)
      const started = (await s.owner(A).write('a thread started from A')) as { ok: boolean };
      expect(started.ok).toBe(true);
      const thread = s.messagesOf(s.H).find((m) => m.direction === 'out' && m.parts[0]!.text === 'a thread started from A')!.contextId;
      await s.raw(B, message('same-thread-b', 'answered at the other address', { contextId: thread }));
      await s.raw(A, message('same-thread-a', 'answered where it was started', { contextId: thread }));
      const answers = s.messagesOf(s.H).filter((m) => m.direction === 'in' && m.contextId === thread).map((m) => ({ text: m.parts[0]!.text, my: m.myAddress, ownThread: Boolean(m.ownThread), to: m.to.sessionId }));
      expect(answers).toEqual([
        { text: 'answered at the other address', my: B.address, ownThread: false, to: 'inbox' },
        { text: 'answered where it was started', my: A.address, ownThread: true, to: 's-1' },
      ]);
      const before = inbound().length;

      // blocking P at A leaves B's contact active (and B still takes P's mail)
      await s.owner(A).block();
      expect(blocks()).toEqual(['']);
      expect(contacts().map((c) => [c.my_address, c.state])).toEqual([['', 'blocked'], [B.address, 'active']]);
      await s.raw(A, message('same-3', 'a third id, to A (blocked)'));
      await s.raw(B, message('same-3', 'a third id, to B'));
      expect(inbound().map((m) => m.text).filter((t) => t.startsWith('a third'))).toEqual(['a third id, to B']);
      expect(inbound()).toHaveLength(before + 1);
      expect(seen().filter((r) => r.msg_id === 'same-3')).toEqual([{ from_id: `${p}|${B.address}`, msg_id: 'same-3' }]);

      // removing P at B: B's tombstone only; A's (blocked) contact is untouched
      await s.owner(B).remove();
      expect(marks()).toEqual(new Set([`removed:${B.address}:${p}`]));
      expect(contacts()).toEqual([{ id: `a:${p}`, my_address: '', state: 'blocked', remark: 'p at a', group_label: 'colleague' }]);
      // …and the other way round: unblocked and removed at A, P is a plain stranger at both, with one request each
      await s.owner(A).unblock();
      await s.owner(A).remove();
      expect(marks()).toEqual(new Set([`removed:${B.address}:${p}`, `removed:${p}`]));
      await s.raw(A, message('same-4', 'a fourth id, to A'));
      await s.raw(B, message('same-4', 'a fourth id, to B'));
      expect(requests().map((r) => [r.my_address, r.msg_id])).toEqual([['', 'same-4'], [B.address, 'same-4']]);
      expect(contacts()).toEqual([]);
      // every message of P kept its contact id and its address (history stays where it was)
      expect(new Set(inbound().map((m) => `${m.my === A.address ? 'A' : 'B'}:${m.contact === `a:${p}` ? 'A' : 'B'}`))).toEqual(new Set(['A:A', 'B:B']));
    });
  }, 60_000);

  // (ADR-083 §5: one message id sent to two of my addresses is two unrelated messages — so are their attachments.
  // Inline attachments are stored under inbox-files/<message id>/, chunked ones are assembled into the same place.)
  it('one message id with an attachment, sent to A and to B with different bytes: each address keeps its own file', async () => {
    await play({ sameHome: true }, async (s) => {
      const { A, B, P } = s;
      await s.owner(A).add();
      await s.owner(B).add();
      const withFile = (bytes: string) => {
        const data = Buffer.from(bytes);
        return { files: [{ name: 'note.txt', data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') }] };
      };
      await s.raw(A, message('file-1', 'a note, to A', withFile('the bytes sent to A')));
      await s.raw(B, message('file-1', 'a note, to B', withFile('the bytes sent to B — other bytes')));
      const rows = s.messagesOf(s.H).filter((m) => m.direction === 'in' && m.from.device === P.address);
      expect(rows.map((m) => m.myAddress)).toEqual([A.address, B.address]);
      const fileOf = (my: string) => rows.find((m) => m.myAddress === my)!.parts.flatMap((x) => x.files ?? [])[0]!;
      expect(readFileSync(fileOf(B.address).path, 'utf8')).toBe('the bytes sent to B — other bytes');
      expect(readFileSync(fileOf(A.address).path, 'utf8')).toBe('the bytes sent to A');
    });
  }, 60_000);
});
