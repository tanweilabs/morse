# test/fixtures/p3-home — a `~/.morse` written by the release before ADR-083

> Created: 2026-11-14 · Last updated: 2026-11-15 (rebuilt for the ADR-083 review: fay, kim, lee, mel)

Used by `test/migrate-v4.test.ts` (ADR-083, mailbox schema `user_version` 3 → 4), through
`test/helpers/p3-fixture.ts`. **Never open `morse/mailbox.db` in place** — opening it with the current
code migrates it; even a read-only look leaves `-wal` / `-shm` files next to it (the first test fails
when the directory holds anything but the files listed below).

No real address, name, message or other personal data is in it.

## No key is in the fixture — keys are generated when the test runs

The directory holds **no key and no certificate**: not the device key (= the computer's first address),
not the keys of its two other addresses. A key does not belong in a repository, not even a throw-away
one. What the builder's keys gave — three addresses and a device ID — is written down in `fixture.json`
(`mine.first`, `mine.work`, `mine.lab`, `mine.device`) and stands in the committed files wherever the
released code put it: `contacts.known_as`, `messages.my_address`, `morse_requests.to_address` and
`morse/addresses/agents.json`.

`materialiseP3Home()` (`test/helpers/p3-fixture.ts`), once per test file:

1. copies `morse/` into a fresh temp home;
2. generates a device identity there the way the product does (`loadOrCreateIdentity`: an Ed25519 key
   and its self-signed certificate, `identity/{key,cert}.pem`) and a key for each of the two other
   addresses (`addresses/<address>/key.pem`, 0600 in a 0700 directory);
3. replaces the four committed identifiers by the ones the new keys give — in every text column of
   every table of the copied database (by SQL, so any index stays right), in the bytes of the database
   file that no row uses any more (rows the released code rewrote left copies of themselves in the
   pages' free space; an identifier has a fixed length, so it is overwritten where it stands and the
   layout of the file stays the one that release left), in every other file, and in the view of
   `fixture.json` the test reads. Everybody else's address, device ID and every message id stay as
   committed;
4. checks itself and throws otherwise: no old identifier is left in any path, in any byte of any file
   (the database file included) or in any value of any table; putting the old identifiers back gives
   the committed database row for row, with the same row ids, schema and `user_version`; SQLite's
   `integrity_check` says `ok`; the database is one checkpointed file again.

The test then copies that home for every case, so all cases of one run share the same keys (two homes
can be compared row by row) and every run has other addresses. Nothing in the test is hard-coded but
the number of places the identifiers stood in (its first case) — a rebuilt fixture may change those.

## How it was built

By the released code itself — commit `af4ca40` (the release before ADR-083, schema v3) — not by this
worktree's `src`:

```sh
OLD=<scratch>/p3                      # any empty directory outside the repository
git archive af4ca40 | tar -x -C "$OLD"
ln -s <repo>/node_modules "$OLD/node_modules"
H=$(mktemp -d)                        # a throw-away home; never the real one
cd "$OLD" && MORSE_HOME=$H HOME=$H ANYTOANY_HOME=$H \
  node --import tsx <repo>/test/fixtures/p3-home/build.mjs "$OLD" <repo>/test/fixtures/p3-home
```

`build.mjs` imports the OLD tree's modules by absolute path (`src/mailbox/db.ts`, `mailbox.ts`,
`contacts.ts`, `home-context.ts`, `src/cluster/identity.ts`, `e2e.ts`, `requests.ts`, `blocklist.ts`,
`trust.ts`, `src/identity/address-key.ts`, `agent-addresses.ts`, `src/machine-config.ts`) and refuses to
run when `MORSE_HOME`, `HOME` and `ANYTOANY_HOME` are not one and the same fresh directory, or when the
tree it is given has a v4 migration. Clock: a counter starting at 2026-11-10T08:00:00Z, one second per
call (`t0` / `lastAt` in `fixture.json`). Keys and message ids are random: a rebuild gives other
addresses and ids — the test reads all of them from `fixture.json`, nothing is hard-coded.

The builder writes **no key file and no certificate** into the fixture (it refuses to finish if a
`.pem` or a PEM private-key block is among the files it wrote): the keys it generated stay in the
throw-away home `$H` — delete that directory afterwards. It records `mine.device`, the device ID its
certificate gave, next to the three addresses.

Everything in the database was written through that release's own API (`createDb`, `createMailbox`,
`mailbox.send / reply / claimNextPending / markDelivered / markFailed / markReceipt / markRequest /
markProcessed / firstSeen`, `contacts.ensure / ensureAddress / ensureOwnDevice / set / remove /
applySplit`, `requests.file / remove`, `acceptRequest`, `declineRequest`, `blockHandle`,
`unblockHandle`, `ensureAgentAddresses`, `updateMachineConfig`). **No hand-written SQL.** What is not
the product's own call:

- `trusted-devices.json` and `peer-keys.json` are written as JSON by the builder (as
  `test/helpers/v2-home.ts` does): real device certificates of throw-away homes, fixed `addedAt`.
- No transport runs. Mail that "came by address" is filed with the arguments the transport passes
  (`src/cluster/morse.ts` `fileMessage` / `fileRequest`); `morse contact block` and the daemon's
  `acceptAddress` are done as the same store calls in the same order (commented in `build.mjs`).

## What it contains

`fixture.json` lists every address, device and message id by the names below.

Not in it, because that release's own API cannot produce them — the test writes them with the statements that
release runs, and says so where it does (`test/migrate-v4.test.ts`): a contact with mail whose `known_as` is
NULL (that release records it with the first mail; NULL is what its `ALTER TABLE … ADD COLUMN known_as` left on
older rows), a blocked own computer (no command of it blocks one), and blocked people whose KEY the test holds
(to write to the migrated daemon as them).

| File | What |
| --- | --- |
| `morse/mailbox.db` | the mailbox, `user_version` 3, WAL checkpointed (one file, ~140 KB): 21 contacts, 41 messages, 4 message requests |
| `morse/morse-blocked.json` | `eve`, `mallory`, `lee`, `mel` (old handles) and the addresses of bart, wanda, bea, zed, fay |
| `morse/config.json` | `relay: { url: ws://127.0.0.1:9, handle: me, agent: mini, agents: [mini, work, lab] }` |
| `morse/trusted-devices.json`, `morse/peer-keys.json` | my two other computers (owner tier) and bob's (peer), certificates pinned |
| `morse/addresses/agents.json` | which agent has which address: `mini` → `mine.first`, `work` → `mine.work`, `lab` → `mine.lab` |

Not in it (made when the test runs, see above): `morse/identity/{cert,key}.pem` — the device key, whose
address is `mine.first` — and `morse/addresses/<address>/key.pem`, the keys of `work` and `lab`.

My addresses: `mine.first` (agent `mini`, the device key), `mine.work`, `mine.lab`.

| Who | In the fixture (schema v3) |
| --- | --- |
| ann | wrote to my first address (request, accepted), I answered. `known_as` = the literal first address. Remark Ann, group friend |
| abe | I wrote first, naming no address: `known_as` = `''`. The message is in the outbox, waiting (failed + waiting) |
| wendy | wrote to `work` (request, accepted), a second message unread, I answered from work. `known_as` = work. Remark Wendy, group colleague |
| lou | I wrote first, from `lab` — pending in the outbox. `known_as` = lab. Remark Lou |
| tess | knows `work` (request, accepted, answered) — AND wrote to my first address (answered from it; one more sent with `''`) AND I wrote to her from `lab`: one contact, history at three of my addresses. Remark Tess, group colleague |
| nina | added by hand, nothing exchanged: `known_as` NULL |
| bart | wrote to my first address, accepted, then blocked (file + row) |
| wanda | wrote to `work`, accepted, then blocked |
| bea | wrote to my first address, accepted, I wrote to her from `work`, then blocked |
| una | wrote to my first address, accepted, blocked — then I wrote to her again, which unblocks: gone from `morse-blocked.json` (what that release obeys), the row's `state` column still says `blocked` |
| gus | wrote to my first address, accepted, then removed: tombstone `removed:<address>`, his message keeps the contact id |
| zed | wrote to my first address, rejected: blocked by address, nobody's contact |
| fay | wrote to `work`, rejected while her request waited there: blocked by address, nobody's contact (ADR-083 review R2: that block was the whole computer's) |
| kim | wrote to `work` (request, accepted), a second message (both unread), I answered from work — then removed: tombstone `removed:<address>`, her three messages keep the contact id `a:<kim>` with `my_address` = work (ADR-083 review R3) |
| rob / rita / ruth | message requests waiting, written to my first address / `work` / `lab` |
| carol | a message request the old way (a computer under the handle `carol`, no `to_address`) |
| bob | contact by old handle (paired computer, address known), remark Bobby, group colleague: mail both ways, a thread I started that he answered (own-thread reply), one message sent to him from `work` and his answer by address written to `work` (both filed under `c:bob`), one pending in the outbox |
| alice | old handle split by the relay's answer into `c:alice` (mini) and `c:alice/air`, group friend, mail with both; `c:alice/pro` was split off and removed again (two tombstones) |
| erin | contact by old handle with a known address; the only mail went out from `work` (`known_as` = work) |
| dave | I wrote to his old handle; it waits in his message requests (`request` = 1) |
| eve | wrote once by old handle, then blocked; mallory: a blocked handle that never was a contact |
| lee | contact by old handle, wrote once, the relay named his address (on the row and in `contact_addresses`) — then blocked by handle (`morse contact block lee`; his computer is not in the trust list, as that command leaves it) |
| mel | contact by old handle with a known address, removed (tombstone `removed:<address>` naming the handle), then blocked: the released command makes the contact by handle again (`split` pending, no address) and blocks it — her address is known from the tombstone only |
| my air | own computer (`origin = own-device`), group self; one message from it (contact `self`) |
| studio | own computer moved out of group self (group colleague, `demoted:` mark); I wrote to its address from my first address and from `lab` |

Also: one message between two sessions of this computer (`internal`), dedupe marks (`inbound_seen`) for
the accepted requests and for bob's computer, some received messages processed and some not.
