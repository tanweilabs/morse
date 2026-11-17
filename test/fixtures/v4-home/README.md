# test/fixtures/v4-home — a `~/.morse` written by the release before v2 was removed

> Created: 2026-11-16 · Last updated: 2026-11-16

Used by `test/migrate-v5.test.ts` (ADR-091, mailbox schema `user_version` 4 → 5: every contact by address, your own
computers paired the old way ordinary contacts in group `mine`), through `test/helpers/v4-fixture.ts`. **Never open
`morse/mailbox.db` in place** — opening it with the current code migrates it, and even a read-only look with `sqlite3`
leaves `-wal` / `-shm` files next to it (the database is in WAL mode).

No real address, name, message or other personal data is in it.

## No key is in the fixture — keys are generated when the test runs

Exactly as for `test/fixtures/p3-home` (see its README): no device key, no key of the second address, no
certificate of this computer. What the builder's keys gave — two addresses and a device ID — is in `fixture.json`
(`mine.first`, `mine.work`, `mine.device`); `materialiseV4Home()` generates new keys, replaces those identifiers
everywhere in a temp copy (every text column of every table, the dead bytes of the database file, every other file)
and checks itself. The public certificates of the OTHER computers (in `peer-keys.json`) are not keys.

## What is in it

- me: old name `me`, two addresses (`mini` the first, `work`); `config.json` has attendant settings for group
  `colleague`, for contact `bobby` (by remark), `erin` (by old handle) and `air` (one of my own computers, by remark).
- my own computers paired the old way (owner tier in `trusted-devices.json`, certificates pinned): `air` (`me/air`)
  and `win` (`me/win`) in group `self`; `studio` (paired by device ID) moved to group `colleague` before. Mail from
  my air (owner tier, a session id) and to my Windows PC, filed under `self` by the released code; one to `me/air`
  still waiting in the outbox.
- `nina`: a contact by address put into group `self` by hand.
- contacts by old handle WITH a known address (the relay named it — ADR-077 split done): `bob` (remark `Bobby`,
  group `colleague`, history both ways, a thread, one message to `bob/mbp` still waiting), `alice` and `alice/air`
  (split), `erin`, `lee` (blocked afterwards: the handle in `morse-blocked.json`, his address NOT in `address_blocks`).
- `carl`: a contact by old handle with NO address on the row, but his paired computer's certificate is pinned (one
  device under `carl` in the trust list) — and a message to him waiting.
- `dave` (written to by old handle, nothing known) and `eve` (blocked, no address): contacts that need their address.
  `mallory`: a handle blocked without ever being a contact.
- `ann`: a contact by address (a request she wrote to my first address, accepted, answered).
- requests waiting: `rob` by address at `work`; `carol` the old way from a device whose certificate is pinned (a
  stranger the relay confirmed); `gail` the old way from a device whose certificate is not.

## How it was built

By the released code itself — origin/main at `1afe17e` (the release 20261116042458 line, schema v4) — not by this
worktree's `src`:

```sh
OLD=<scratch>/released                # any empty directory outside the repository
git archive 1afe17e | tar -x -C "$OLD"
ln -s <repo>/node_modules "$OLD/node_modules"
H=$(mktemp -d)                        # a throw-away home; never the real one
cd "$OLD" && MORSE_HOME=$H HOME=$H ANYTOANY_HOME=$H \
  node --import tsx <repo>/test/fixtures/v4-home/build.mjs "$OLD" <repo>/test/fixtures/v4-home
```

`build.mjs` imports the OLD tree's modules by absolute path and refuses to run when `MORSE_HOME`, `HOME` and
`ANYTOANY_HOME` are not one and the same fresh directory, or when the tree is not that release (it has the v5
migration, or no v4 one). It writes only `morse/` (the database, the four JSON files, `addresses/agents.json`) and
`fixture.json`, and refuses to finish if any file it wrote holds key material.
