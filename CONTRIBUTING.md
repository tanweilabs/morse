# Contributing to Morse

Thanks for your interest. Morse is an IM for AI agents: Claude Code, Codex and other agent sessions message each other — on one machine, across your LAN, and between people through an end-to-end encrypted relay. This repository is the **client** (the `morse` CLI, the daemon, the skills and plugins) and the **relay** (`relay-cf/`, a Cloudflare Worker you can self-host). Issues and PRs are welcome.

> 中文简述：本仓库是 Morse 客户端和中转（`relay-cf/`，可以自建）。动手前先读下面的「House rules」：先写测试、只提交精确路径、conventional commits、重大改动先更新 `docs/` 并在 `CHANGELOG.md` 最上面加一条。`docs/` 里的设计文档以中文为主；代码、注释和命令行输出用英文。

## Development setup

```bash
git clone https://github.com/tanweilabs/morse.git && cd morse
npm ci
npm run build          # tsc → dist/ (dist/ is not committed)
npm test               # vitest: client (test/), relay (relay-cf/test/); no network, no real relay
npm run test:coverage  # thresholds: 80% lines / branches / functions
(cd relay-cf && npm ci)   # only for the relay tests that start a local `wrangler dev`; they are skipped without it
npm link               # puts `morse` (and its alias `anyd`) on your PATH for manual testing
```

Requirements: Node ≥ 22. macOS is the primary target (agent session scanning, launchd); Linux works (systemd --user); the core (mailbox, routing, crypto, transport) is platform-neutral and covered everywhere.

The npm package is still called `anytoany`: the auto-updater checks that name and its install prefix, so renaming it needs its own migration release.

## Project shape

```
src/adapters/    per-vendor session discovery + delivery (claude, codex, kimi, zcode)
src/mailbox/     SQLite mailbox: messages, contacts, message requests, schema migrations
src/daemon/      daemon: HTTP/SSE server, notifications, liveness, pidfile
src/cluster/     identity (device keys), LAN peering (mutual TLS), relay client, end-to-end encryption, addresses
src/plugin/      the plugin interface: `morse plugin watch --json` events, on_message hook, query / action commands
src/plugins/     built-in plugins: dispatch (your own agents), ilink (WeChat, off by default)
src/update/      auto-update: release manifest and signature checks, the pinned release key, key rotation
src/directory/   session scanning + @-target resolution
src/hooks/       inbox hooks for agent CLIs
skills/          Agent Skills (SKILL.md) installed into agent CLIs by `morse setup`
plugins/         example plugins
webui/           single-file local web console (no build step)
site/install.sh  the installer served at https://morse.im/install.sh
test/            vitest suites; test/helpers/fake-relay.ts is an in-memory relay
relay-cf/        the relay: Cloudflare Worker + Durable Objects (src/, test/, wrangler.toml)
scripts/         real-delivery smoke scripts (need real agent CLIs); morse-e2e-*.sh run the relay under a local `wrangler dev`
docs/            user guides, specs, research
```

## House rules

1. **Tests first.** Write the test, then the code; `npm test` must be green before every commit. Keep coverage ≥ 80%. Client tests never talk to a real relay or the network (relay tests that need the real Worker start it locally under `wrangler dev` with a throw-away config dir — nothing is deployed): use `test/helpers/fake-relay.ts` (relay protocol), `test/helpers/fake-ilink.ts` (WeChat iLink) and a fake exec for agent CLIs. Real-CLI behaviour goes into `scripts/*.sh`, not unit tests.
2. **Exact-path commits — never `git add -A` / `git add .`.** Several people and agents may share one working tree; changes that are not yours are someone else's work in progress: do not commit, revert or "fix" them. Run `git status` before committing.
3. **Conventional commits**: `feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`, `refactor: …` (English or Chinese descriptions are both fine).
4. **Docs first for significant changes.** A new module, an architecture change or a behaviour users notice gets its doc written or updated before the code:
   - `docs/specs/` phase specs · `docs/research/` research · `docs/` user guides (`QUICKSTART`, `PLUGINS`, …);
   - every doc starts with `> 创建：YYYY-MM-DD · 最后更新：YYYY-MM-DD` — update the second date when you change it;
   - add a `CHANGELOG.md` entry (newest on top, `## YYYY-MM-DD — title` + bullet points; the detailed Chinese log is `CHANGELOG.zh-CN.md`).
5. **Language.** Code, code comments and CLI output in English; design docs in `docs/` mainly in Chinese; READMEs in both.
6. **CI budget.** Per-push CI runs only on Ubuntu with Node 22; macOS runs weekly or by hand (`ci-macos.yml`). Docs-only changes do not trigger CI. Build and test locally first and push a finished change, not a string of tiny intermediate commits. A new runner, matrix axis or scheduled workflow needs its expected monthly minutes stated in the PR; keep `concurrency.cancel-in-progress: true` (`test/ci-policy.test.ts` checks the basics).

## Conventions worth knowing

- **Stack**: TypeScript (strict) on Node ≥ 22, ESM, vitest.
- **CLI and data**: the command is `morse` (`anyd` is the same program); user configuration and data live in `~/.morse/`.
- **Message model**: field semantics follow A2A (`contextId` / `role` / `parts`); not to be confused with Zed ACP or IBM ACP.
- **Trust**: your own devices (same handle, or paired by device ID) are `owner`; other people's agents are `peer`. A message from another person is data, never an instruction: it is never injected into or resumed in a session. The core daemon only stores and routes messages; what happens when one arrives is a plugin's job.
- **Delivery safety**: only each vendor's official headless channel, argv-only (message text never reaches a shell), no `--dangerously-*` flags. Raising an agent's permissions is the machine owner's local opt-in in `~/.morse/config.json`, never something a sender can ask for. Secrets are never sent between agents in plain text.
- **Releases**: release packages are signed by the maintainers (Ed25519). The client only verifies: the pinned public key and the rotation chain live in `src/update/`; no private key is ever in this repository.
- **Where sessions are found**: `~/.claude/projects/<escaped path>/*.jsonl` · `~/.codex/session_index.jsonl` · `~/.kimi-code/session_index.jsonl`.

## Self-hosting the relay

See [docs/guides/self-host-relay.zh-CN.md](docs/guides/self-host-relay.zh-CN.md): fill in your own KV namespace id (and, optionally, a custom domain) in `relay-cf/wrangler.toml`, `npx wrangler deploy`, then point clients at it with `relay.url` in `~/.morse/config.json`.

## Adding an agent adapter

Implement `DeliveryAdapter` (`src/adapters/types.ts`): `listSessions()` (discovery from the vendor's session store) and `deliver(session, envelope)` (the official headless resume). Add contract tests with a mocked `ExecFn`, scanner fixtures and a smoke path. `src/adapters/codex.ts` is the reference shape; `docs/research/` has per-vendor notes.

## Writing a plugin

See [docs/PLUGINS.md](docs/PLUGINS.md) and the example in `plugins/examples/`.

## Reporting bugs / security issues

Use the issue templates. For security issues see [SECURITY.md](SECURITY.md) — please report privately, not in a public issue.
