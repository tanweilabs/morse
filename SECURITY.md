# Security Policy

Morse moves messages between AI agent sessions: on one machine, across your LAN, and between people through a relay. Thanks for helping keep it tight.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's [private vulnerability reporting](https://github.com/tanweilabs/morse/security/advisories/new) instead. You should get a response within a few days.

## How Morse is meant to be secure

- **Identity is a key.** Every device has its own Ed25519 key; the device ID is the fingerprint of its certificate (ADR-028). A v3 address is derived from the agent's own key (ADR-073). There are no accounts and no passwords.
- **Two trust tiers.** Your own devices are `owner`: a message between your own sessions carries your authority (ADR-016, ADR-034). Other people's agents are `peer`: their messages are data, not instructions, and the core does not resume them into your sessions (ADR-048; a reply in a thread you started goes back to the session that started it, ADR-071). The agent or session name a sender writes only chooses a mailbox, never a session — the mailbox enforces this when it files the message, whichever way it came in (ADR-082). A stranger's first message waits as a message request until you accept it (ADR-037).
- **What an agent may do for a contact is your setting.** The attendant plugin answers contacts with the permissions you give them (`morse contact set`; ADR-059, ADR-066, ADR-070); destructive or outward-facing actions stop and wait for you, and only you, in a terminal, can approve them (ADR-060).
- **Transport.** On the LAN: mutual TLS 1.3 with pinned certificate fingerprints (ADR-028). Across networks: end-to-end encrypted, signed envelopes; the relay forwards them and cannot read or alter them. For a v3 address that is offline the relay holds the sealed envelope for up to 7 days and deletes it when the recipient acknowledges it (ADR-073). Direct WebRTC links are set up with signalling that is signed and bound to the device identity (ADR-069).
- **Delivery into an agent** uses each vendor's official headless channel, **argv-only** — message text never reaches a shell. A sender can never raise an agent's permissions: that is the machine owner's local configuration, and permission-bypass modes are refused in code (ADR-054).
- **Local API.** The daemon's HTTP API binds to `127.0.0.1`, refuses non-loopback callers, and answers only a caller that presents a credential (ADR-087): the per-start token in `~/.morse/daemon.json`, an external agent's own token, or a web-console session. Requests a browser on another page could send (a foreign `Origin` or `Host`, a body that is not `application/json`) are refused, and no CORS header is sent. A process already running as you can read the token — the boundary is your user account.
- **Updates** are signed (Ed25519). The client only installs a release that verifies against its pinned public key or a rotation chain starting from it, and never downgrades (ADR-039, ADR-041).

## In scope

- Reading, forging or altering message content as the relay or as a network attacker.
- Impersonating a device or an address without its private key; getting past the pinned-certificate check on the LAN.
- A message from a peer or a stranger being treated as the owner's instruction, entering a session it should not, or getting past the message-request gate, a contact's permissions or the approval step.
- Message text reaching a shell.
- A sender causing an agent to run with raised or bypassed permissions.
- Reaching the local API from a non-loopback address, from a web page, or without a credential; a `morse` command talking to the daemon of another Morse home.
- Getting a client to install an update that the release key did not sign.
- Private keys, recovery phrases or session ids leaking to a party that should not have them.

## Out of scope, and known limits

- A device of yours that is already compromised, or a stolen `~/.morse` directory: whoever holds the keys is that device. Protect it like an SSH key.
- An agent acting on a message from your own devices — that is the intended behaviour.
- Metadata: the relay sees which address or device talks to which, when, and how much; it can also drop or delay traffic.
- Agents replying to each other without end: Morse sets no thread-depth or rate caps by default (ADR-072). Limits are yours to configure (`maxTurnsPerContext`, `rateLimit`).
- A compromised release machine or a poisoned npm dependency (ADR-039 covers a compromised site, not these).
