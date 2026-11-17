# 「电脑 / 设备」的说法清单：哪里说了、改成什么（ADR-086 的附件）

> 创建：2026-11-15 · 最后更新：2026-11-15
> ADR-086 落到文字上的清单，按 ADR-088 的定稿改过：**产品里只有两个名词——地址（自己的）和联系人（别人）；「Agent」只用来说谁在用 Morse，不当宾语。** 状态（2026-11-15）：第 1 节（命令行）、`site/install.sh` / `install.ps1`、技能、`site/agent.md`、QUICKSTART、README 的相应段落已按此改；**第二轮**（分支 `chore/no-computer-wording`）改了 `site/index.html` 首屏以下几节、`site/agent.md` / `llms.txt` / 技能里剩下的、命令行里剩下的、一部分 daemon 日志和两段提示词（P 类），见[第 7 节](#7-第二轮把剩下的改完2026-11-15)。行号是改之前 `main` 009b78f 的。清单由脚本从源码和文档里扫出来，下面「改成」一栏是现在实际用的说法（没实现的几处是建议）。

## 归类和改法

| 归类 | 现在怎么说 | 改成 | 中文文档里 |
| --- | --- | --- | --- |
| **A 身份** | this computer's address(es) · on this computer · an address of this computer | **your addresses here** · **here** · your first address。说「谁的」时说地址，不说电脑，也不说 Agent | 「这里的地址」「你的地址」；不说「这台电脑的地址」「你的 Agent 的地址」 |
| **B 对方** | their computer / their device · that computer is offline | **they** · **the other side** | 「对方」；不说「对方那台电脑」「对方的 Agent」 |
| **C 别处的地址** | another computer of yours | **another machine of yours**：在那边也装 Morse，它有自己的地址，两边互相加成联系人——它就是一个联系人 | 「你的另一台机器」「你另一台机器上的地址」；不说「你在别的机器上的 Agent」 |
| **D 以前配对的** | your own computer(s)（`self` 分组、own-device 来源的联系人） | **不改**：它们说的就是更新前按电脑配对的那些，照实叫 computer；等删 v2 时一起走 | 「更新前已经配好的、你自己的电脑」 |
| **N 名字** | name（地址的）· rename | 地址的名字和联系人的名字一样起：`morse address set <which> --name <name>`；只有一个地址时哪里都不显示。英文里联系人的叫 remark、自己地址的叫 name，选项都是 `--name` | 两边都叫「备注名」 |
| **K 保留** | 说的就是这台机器：丢了、离线、时钟、文件存在本地、后台服务 | 不改（这些地方说「机器」是对的） | 同左 |
| **H 旧命令** | `pair`、`device`、`join --code`、`lan`、`relay show`、`agent list`、管理员邀请、设备 ID：`morse --help` 不列的命令和局域网配对那条路 | 不改（它们说的本来就是设备；等这些命令删掉时一起走） | README 里 anytoany 时期的大段同理，见下 |
| **L 日志** | `~/.morse/daemon.log` 里的行 | P-B 不改；以后顺手统一 | — |
| **P 提示词** | 写进 Agent 会话的那两段话 | 要改，但它们决定 Agent 认不认授权：P-B 里单独过、带测试 | — |

两条原则：**能不提机器就不提；必须提的时候（它丢了、它不在线、文件存在它上面）照实说。** 「here」只指「这一份 Morse 安装」，不是身份。**「agent」不当宾语**：不写 your agents、agent name、which agent、another agent here；会话目标 `@<agent>:<session>` 和隐藏的 `agent` 命令是 v2 的写法，不在这一轮里，和 v2 一起删。

## 1. 命令行里用户看得见的字（50 处，逐条给出改法）

| 位置 | 现在 | 归类 | 改成 |
| --- | --- | --- | --- |
| `src/cli.ts:168` | `morse: contacts upgraded to one per address${r.ownDevices ? ` | D 以前配对的 | 不改（D）：`… — N of your own computer(s) are now contacts in group self` |
| `src/cli.ts:1056` | 'Your address(es) on this computer (lists them); add <name> = another address here with its own key; rename, remove' | A 身份 | `Your address (lists them when there are several); add, set, remove` |
| `src/cli.ts:1066` | `error: ${address} is not an address of this computer — morse address lists them` | A 身份 | `error: <address> is not one of your addresses here — morse address lists them` |
| `src/cli.ts:1084` | 'Create another address on this computer: a new agent with its own key and address (the name is your local label: a-z 0-9 -)' | A 身份 | `Create another address here, with its own key (optionally with your name for it — see set)`；名字可以不写 |
| `src/cli.ts:1092` | 'Rename one of this computer\'s addresses (the address itself does not change)' | A 身份 | `rename` 变成隐藏别名；文档里的是 `address set [which] --name <name>`：`Change your name for one of your addresses (the address itself does not change, and whoever has it keeps reaching it)` |
| `src/cli.ts:1114` | `error: ${first} is this computer's own address (its first one) — it cannot be removed; remove the other addresses, or rename it: morse address rename ${first} <new name>… | A 身份 | 几个地址：`error: <name> is the first address here (it uses this install's own key) — it cannot be removed; remove the others, or rename it: morse address set <name> --name <new name>`；只有一个地址：`error: this is your only address here (it uses this install's own key) — it cannot be removed` |
| `src/cli.ts:1120` | 'Remove one of this computer\'s addresses (it stops receiving; its key stays on disk)' | A 身份 | `Remove one of your addresses here (it stops receiving; its key stays on disk)` |
| `src/cli.ts:1603` | 'who is sending: one of your addresses on this computer (its name in `morse address`, or the address) — or a session here, @<agent>:<session> (resolved like a target)' | A 身份 | `--from <name>`：`which of your addresses here it goes out from (its name in morse address, or the address; default: MORSE_ADDRESS, else your first address)`；会话另用 `--session` |
| `src/cli.ts:1629` | `error: "${opts.from}" is not one of this computer's addresses — morse address lists them (a session is written @<agent>:<session>)` | A 身份 | **不改**（保留已发布的原文，它在「只有一个地址时逐字不变」的对照里；删 v2 时和别处统一） |
| `src/cli.ts:1748` | `  it had already taken the message [${body.message.id.slice(0, 8)}] — that one may have gone out from this computer's first address: morse message --id ${body.message.id… | A 身份 | `… that one may have gone out from your first address: morse message --id <id>` |
| `src/cli.ts:1917` | 'Morse inbox (this computer)' | A 身份 | `Morse inbox (the addresses here)` |
| `src/cli.ts:2030` | "pull this computer's Morse agent inbox (morse.im/<you>/<agent>) instead of a session's messages" | A 身份 | `pull the Morse inbox of the addresses here instead of a session's messages` |
| `src/cli.ts:2082` | "with --pull: this computer's Morse agent inbox instead of a session's messages" | A 身份 | `with --pull: the Morse inbox of the addresses here instead of a session's messages` |
| `src/cli.ts:2100` | 'built-in (own agents: same-machine session mail, your own devices)' | D 以前配对的 | 不改（D） |
| `src/cluster/chunks.ts:108` | `file too large: ${f.name} is ${f.size} bytes, this device accepts at most ${maxFileBytes} (morse.maxFileBytes)` | B 对方 | `file too large: <name> is <n> bytes, this address accepts at most <max> (morse.maxFileBytes)` |
| `src/cluster/chunks.ts:111` | `attachments too large: ${total} bytes in one message, this device accepts at most ${maxFileBytes} (morse.maxFileBytes)` | B 对方 | `attachments too large: <n> bytes in one message, this address accepts at most <max> (morse.maxFileBytes)` |
| `src/cluster/direct.ts:326` | 'the device is offline' | B 对方 | `the other side is offline` |
| `src/cluster/morse.ts:536` | `this computer does not hold the address ${address} right now (or its key is not loaded)` | A 身份 | `the address <address> is not here right now (or its key is not loaded)` |
| `src/cluster/morse.ts:1966` | 'their computer confirmed a message to its inbox' | B 对方 | `the other side confirmed a message to its inbox` |
| `src/cluster/morse.ts:2135` | 'their device confirmed a message to its inbox' | B 对方 | `the other side confirmed a message to its inbox` |
| `src/cluster/morse.ts:2548` | `this message was written from your address morse.im/${address}, which this computer no longer has (or its key is not loaded) — not sent` | A 身份 | `this message was written from your address morse.im/<address>, which is no longer here (or its key is not loaded) — not sent` |
| `src/cluster/morse.ts:2571` | `this message was queued from your address "${name}", which this computer no longer has under that name — send it again (morse send --from <name>; morse address lists the… | A 身份 | `this message was queued from your address "<name>", which is no longer here under that name — send it again (…)` |
| `src/cluster/morse.ts:2666` | `${asAddress} is an address of this computer — use a session target (@<agent>:<session>) for your own agents here` | A 身份 | `<address> is one of your addresses here — to write to a session here use a session target (@<agent>:<session>)` |
| `src/cluster/morse.ts:2676` | `${to}: mail from your address "${nameOfAddress(self)}" can only go by address, and no address is known for this contact yet — send from this computer's first address, or… | A 身份 | `… no address is known for this contact yet — send from your first address, or ask them for their address (morse address)` |
| `src/cluster/morse.ts:2993` | 'their device confirmed a message to its inbox' | B 对方 | `the other side confirmed a message to its inbox` |
| `src/cluster/morse.ts:3090` | 'their device took a message into its inbox' | B 对方 | `the other side took a message into its inbox` |
| `src/cluster/requests.ts:74` | `\n\n[${req.droppedFiles} attachment(s) not kept while this was a message request${list} — their device sends them again now that you accepted (if it does not: their Mors… | B 对方 | `… — they send them again now that you accepted (if they do not: their Morse is older — ask them to send the files again)` |
| `src/cluster/requests.ts:77` | `the request filed under morse.im/${handle} did not come from that address (it came the old way, from a computer the relay listed under an address-shaped name) — it canno… | B 对方 | `… (it came the old way, from a sender the relay listed under an address-shaped name) — it cannot be accepted: …` |
| `src/cluster/requests.ts:165` | `    [this did NOT come from this address — a computer the relay listed under an address-shaped name wrote it; it cannot be accepted: morse contact reject ${r.handle}]` | B 对方 | `[this did NOT come from this address — a sender the relay listed under an address-shaped name wrote it; …]` |
| `src/commands/known-as.ts:59` | `knows you as: morse.im/${k.address} — an address this computer no longer has: mail to them is not sent unless you name one (morse send … --from <name>)` | A 身份 | `knows you as: morse.im/<address> — an address that is no longer here: mail to them is not sent unless you name one (…)` |
| `src/commands/known-as.ts:107` | `"${from}" is not one of this computer's addresses — morse address lists them` | A 身份 | `"<from>" is not one of your addresses here — morse address lists them` |
| `src/commands/messaging.ts:325` | `${bare} is an address of this computer — not a contact of yours` | A 身份 | `<address> is one of your addresses here — not a contact of yours` |
| `src/commands/messaging.ts:414` | 'Forget a contact: their devices are no longer trusted, their next message is a request again (history stays)' | B 对方 | `Forget a contact: they are no longer trusted, their next message is a request again (history stays)` |
| `src/commands/messaging.ts:431` | `removed ${who(c)} from your contacts — it is still paired with this computer as one of your own (to list it again: morse contact add ${c.address})` | D 以前配对的 | 不改（D） |
| `src/commands/messaging.ts:432` | `removed ${who(c)} from your contacts — it STAYS an ordinary contact's computer, not one of your own: removing a contact never raises its trust (to trust it as your own a… | D 以前配对的 | 不改（D） |
| `src/commands/messaging.ts:437` | `removed ${who(c)}${devices ? ` (${devices} computer(s) no longer trusted)` : ''} — history kept; …` | B 对方 | `removed <who> (no longer trusted) — history kept; to block them too: …` |
| `src/commands/messaging.ts:490` | 'that is one of your own computers — move it out of group self instead (morse contact set … --group <label>)' | D 以前配对的 | 不改（D） |
| `src/commands/messaging.ts:517` | 'Block an address (a contact, or one that sent a message request): its messages are dropped, its devices untrusted, its request deleted' | B 对方 | `Block an address (…): its messages are dropped, it is no longer trusted, its request deleted` |
| `src/commands/messaging.ts:556` | 'they are not reachable right now — their device sends what it held back on its next try' | B 对方 | `they are not reachable right now — they send what they held back on their next try` |
| `src/commands/messaging.ts:650` | 'remark name, address, or "me" for your own sessions and devices' | D 以前配对的 | 不改（D） |
| `src/daemon/server.ts:325` | `"${named}" is not one of this computer's addresses — morse address lists them` | A 身份 | `"<name>" is not one of your addresses here — morse address lists them` |
| `src/envelope.ts:81` | `The same human who runs your session paired these machines with a shared secret and set this collaboration in motion. A request relayed here therefore carries your opera… | P 提示词 | 写进会话的提示词（自己机器之间的会话信）：`paired these machines with a shared secret` 本来就不准确，但这段话决定 Agent 认不认授权；单独一轮、带测试地改 |
| `src/identity/agent-addresses.ts:39` | `${path} is damaged (${why}) — it says which address each agent of this computer has. Fix it or move it away (the keys in ${addressesDir(home)} are untouched); nothing wa… | A 身份 | `<path> is damaged (<why>) — it holds the names of your addresses here. Fix it or move it away (…); nothing was changed.` |
| `src/identity/envelope.ts:155` | "envelope is dated in the future (check this computer's clock)" | K 保留 | 不改 |
| `src/mailbox/mailbox.ts:521` | `"${input.to.device}" is a contact of this computer's first address — from another of your addresses, write to their address (morse.im/<their 26 characters>): they are th… | A 身份 | `"<who>" is a contact of your first address — from another of your addresses, write to their address (…)` |
| `src/mailbox/migrate-v4.ts:302` | "cannot tell which of this computer's addresses is its first one (its key could not be read) — your contacts were not changed; the upgrade runs again the next time morse … | A 身份 | `cannot tell which of your addresses here is the first one (its key could not be read) — …` |
| `src/mailbox/migrate-v4.ts:538` | `cannot tell which addresses this computer has (${e instanceof Error ? e.message : String(e)}) — the people you blocked could not be kept blocked at each of them; your co… | A 身份 | `cannot tell which addresses are here (<why>) — …` |
| `src/peer-framing.ts:31` | `This came from @${m.from.agent} on @${name}, a device that belongs to SOMEONE ELSE (paired as a peer, not as one of your operator's devices).` | P 提示词 | 写进会话的提示词（别人的信）：`an agent that belongs to SOMEONE ELSE (a peer, not one of your operator's own agents)`。同上，单独过 |
| `src/plugins/ilink/config.ts:95` | `plugins.ilink.target "${target}": must be a session of yours on this computer, like @claude:<session id>` | A 身份 | `plugins.ilink.target "<target>": must be a session of yours here, like @claude:<session id>` |
| `src/plugins/ilink/inbound.ts:306` | `用户通过微信发来 ${saved.length} 个附件，已保存到本机：` | K 保留 | 不改 |

## 2. 技能、站点、安装脚本（逐条给出改法）

### `skills/morse/SKILL.md`

已经整份换过（P-A），ADR-088 又改了一遍：第一次使用 = 没装就装 → `morse address` → 把地址告诉主人，没有起名这一步；「一台机器上几个地址」是一小段（`morse address add <name>`，`--from <name>` 或 `MORSE_ADDRESS`，改名用 `morse address set <name> --name <new name>`）。只改 `skills/`，`skill-repo/` 和站点上的拷贝由 `scripts/lib/skills.mjs` 生成。改之前那份里的 16 处：

- `skills/morse/SKILL.md:3` …e other AI agent sessions (Claude Code, Codex, ...) on this machine, and agents at other addresses over Morse — an address is held by a person or by a
- `skills/morse/SKILL.md:13` …morse address                   # the address(es) this computer hosts, your name for each, the relay
- `skills/morse/SKILL.md:25` …` (handled without a reply), `morse list` (sessions on this machine), `morse status` / `update`, `morse message --pull` (messages for THIS session fro
- `skills/morse/SKILL.md:29` …d by a person **or by an agent**, and living on exactly ONE computer; a message goes to that computer only. Each install is one agent with its own add
- `skills/morse/SKILL.md:31` …- **No address yet?** `morse address` creates one when this computer has none, then shows it: `address: morse.im/<26 characters>   <name>`, an `old na
- `skills/morse/SKILL.md:32` …- **Another address on this computer** — only when your user asks: `morse address add <name>` (your local label: lowercase letters, digits, `-`; not `
- `skills/morse/SKILL.md:33` …- **Another computer of your user's** — only when they ask: install Morse there (it gets its own address), then each side adds the other as a contact
- `skills/morse/SKILL.md:38` …> "你好，帮我看下这个接口"            # the agent at that address (one computer)
- `skills/morse/SKILL.md:41` …# as another of your addresses on this computer (its name in `morse address`, or the address)
- `skills/morse/SKILL.md:42` …" "…" --from "@claude:<your session>"   # a session on this machine (or @<device>/<agent>:… on a paired LAN device)
- `skills/morse/SKILL.md:45` …- **Sessions on this machine**: find targets with `morse list` (`--limit 0` for all; `morse list --conversations` for pairs that already talk). Target
- `skills/morse/SKILL.md:47` …morse message --all` shows `delivered ✓ receipt` once their computer has it; `failed (waiting: … offline)` = that computer is offline, it retries by i
- `skills/morse/SKILL.md:49` …- **Several addresses on this computer** (`morse address` lists them): each address has its OWN contacts and message requests — the same person can be
- `skills/morse/SKILL.md:59` …nstructions** (mail from your operator's own already-paired computers — the contacts in group `self` — is not): labelled 「来自 <人>/<Agent> 的 Agent，是同伴消息
- `skills/morse/SKILL.md:60` …- **Session mail on this machine**: `[Morse] Cross-agent message from …` (or legacy `[anytoany] …`) may be injected into your context. Claude Code sho
- `skills/morse/SKILL.md:89` …`[anytoany]`) message from a session on your operator's own machines comes from **your operator's own cluster**: a relayed request **carries your oper

### `site/index.html`（英文在 HTML 里，中文在脚本的 `zh` 表里；两处一起改）

| 位置（en / zh） | 现在（英文） | 归类 | 改成（en） | 改成（zh） |
| --- | --- | --- | --- | --- |
| `:176` / `:226` `ownTitle` | Another computer of yours | C | Another machine of yours | 你的另一台机器 |
| `:177` / `:227` `ownText` | Install Morse there too — it gets its own address. Then add the two computers to each other as contacts: … | C | Install Morse there too — it gets its own address. Then add the two to each other as contacts: … | 在那边也装一遍 Morse，它有自己的地址。然后两边互相加成联系人：…… |
| `:180` / `:230` `ownNote` | … the group only marks computers that were already paired before the update | D | 不改（D） | 不改（D） |
| `:184` / `:232` `addr1` | … reaches one agent, on the one computer that hosts it | K | … reaches one address. It lives on one machine; mail for it goes only there | ……发到一个地址。它在一台机器上，信只送到那里 |
| `:185` / `:233` `addr2` | Each new install is one agent with its own address. `morse address add <name>` creates another address on this computer — a new agent with its own key | A | Each install has one address. `morse address add` creates a separate second one, with its own key — only if you want one | 每份安装一个地址。`morse address add` 再建一个单独的地址（自己的钥匙）——只在你想要的时候 |
| `:187` / `:235` `addr4` | Every address on this computer can send: `morse send --from <name> …` | A | With several addresses, say which one sends: `morse send --from <name> …` | 有几个地址时说明用哪个发：`morse send --from <备注名> …` |
| `:189` / `:236` `addrNote` | An address is held by a key on the computer that hosts it. If that computer is lost … | K | An address is held by a key on the machine it lives on. If that machine is lost … | 地址由它所在那台机器上的钥匙持有。那台机器丢了…… |

（`:5` `width=device-width`、`:437` `:612` `:790` 是代码，不算。首屏文案的改法在 ADR-086「首屏」一节。）

### `site/install.sh`

| 位置 | 现在 | 归类 | 改成 |
| --- | --- | --- | --- |
| `:7-8` 文件头 | Another computer of yours: run the first line there too (one agent, one address — every computer gets its own) | C | Another machine of yours: run the first line there too — it gets its own address — then add the two to each other as contacts |
| `:19-22` 文件头 | a computer that has not joined yet gets its OWN address … A computer that already joined is only upgraded | A | 不改这几行的意思；`--agent` 的说明见下 |
| `:30` | a new random address for this computer — or, if it already joined, an upgrade | A | a new address — or, if there is one already, an upgrade |
| `:32-34` `--agent` | your name for this computer's address (… default: from the computer's name — mini, air, pro …) | A | (kept for compatibility) a name for the address this install creates; it only shows once you have several addresses here. Ignored where Morse already has an address: no address is added, nothing is renamed |
| `:35` `--name <device>` | name this computer (default: its hostname) | K | 不改（局域网里显示的机器名） |
| `:108-109` | every computer gets its own address: 1. here, for this computer's own address: … | A | every install gets its own address: 1. here, for this computer's own address: … |
| `:116` | If "<arg>" is another computer of yours: install here the same way, then add each other as contacts | C | 不改 |
| `:138` | Nothing was changed on this computer. | K | 不改 |
| `:289` `:291` | Adding this computer to morse.im/<handle> … / could not add this computer … | H | 不改（配对码那条旧路） |
| `:453` | This computer's address is named <name> (rename: …) | A | 删掉这一行，换成 `Your address any time: morse address`（只有一个地址时不说名字） |
| `:455` | Another address on this computer: morse address add <name> (a new agent with its own key). | A | A separate, second address here (only if you want one): morse address add <name> |
| `:456` | Another computer of yours: install Morse there too, then add each other as contacts (…) | C | Another machine of yours: install Morse there too — it gets its own address — then add each other as contacts (…) |

根目录的 `install.sh`（anytoany 时期的 git 安装脚本，只有 `anyd pair --invite` 还会打印它）归 H，不改。

## 3. 文档（按行列出、标归类；P-B 里按上表的说法整段重写）

### `docs/QUICKSTART.md`（41 处）

| 行 | 现在 | 归类 |
| --- | --- | --- |
| `17` | …给 Claude Code / Codex 装上 Morse 技能和收件提醒 → **给这台电脑分配一个你自己的地址** → 设成开机自动在后台运行。最后会告诉你： | A 身份 |
| `23` | - 地址有 26 位，由这台电脑的钥匙算出来，独一无二、别人冒用不了。**没有账号、没有密码**：这台电脑的私钥（在 `~/.morse/identity/`）就是你的身份。 | K 保留 |
| `25` | …se.im/k7f3a9xq`；旧域名已停用，现在一律写 `morse.im`，以前装好的电脑什么都不用改。 | A 身份 |
| `26` | - **这台电脑的地址有个名字，由你定**（只是你在这台电脑上的叫法）：`... \| bash -s -- --agent macbook-air`；不指定就用一个短名（比如 Mac mini → `mini`，MacBook Air → | A 身份 |
| `27` | …地址：`morse address`（还没有地址时它直接建一个，再显示出来）。已经加入过的电脑再跑安装命令只是升级，地址不变。 | A 身份 |
| `36` | 第一行是这台电脑的地址，后面是你给它起的名字。**发给别人的就是这一行**：对方没见过你也能直接 `morse contact add morse.im/<地址>` 或给它发信。`old name` 是 8 位的旧链接，照样能找到你；对 | A 身份 |
| `48` | ### 你自己的另一台电脑 | C 别处的 Agent |
| `50` | 在那台电脑上照样装一遍 Morse（`curl -fsSL https://morse.im/install.sh \| bash`），它有自己的地址。然后两台电脑互相加成联系人：在每台上运行 `morse address`，把第一行的地址… | C 别处的 Agent |
| `53` | morse contact add morse.im/<另一台的地址> --name air --group mine      # air 是你给它起的备注；两台电脑上各做一次 | C 别处的 Agent |
| `54` | …e --cwd ~/work --tools Read,Grep,Glob      # 这台电脑的 Agent 可以替 mine 分组做什么 | A 身份 |
| `57` | - 只在一边加也行：一台先给另一台发一条消息，另一台用 `morse contact accept morse.im/<地址>` 同意，再用 `morse contact set` 起备注、分组。 | C 别处的 Agent |
| `58` | …N.md](PLUGIN-ATTENDANT.zh-CN.md)。Morse 没有「自己的电脑」这种专门的信任：另一台电脑就是一个联系人，它发来的消息和别的联系人一样是同伴消息，你的 Agent 只在你给的权限里替它做事。**新加的电脑不要 | D 以前配对的 |
| `59` | - 更新前已经配在同一个地址下的电脑不用动：更新后它们出现在 `morse contact` 里，分组是 `self`，信任和以前一样。把其中一台移出 `self` 分组，它就是普通联系人。 | D 以前配对的 |
| `61` | ### 电脑丢了怎么办 | K 保留 |
| `63` | 没有账号系统，**无法自助找回**：地址由电脑上的私钥持有，一个地址所在的电脑都丢了，这个地址就找不回来。在新电脑上重新安装拿一个新地址，告诉朋友新地址，再和你其他的电脑重新互加联系人。想释放旧地址（地址下的设备、Agent 一起清掉；随机 | K 保留 |
| `81` | …v8c4h6jt5rwn8d2p` \| 这个地址的 Agent——**只送到托管它的那一台电脑** \| | A 身份 |
| `84` | \| `air`（你起的备注） \| 你的一个联系人，包括你自己的另一台电脑 \| | C 别处的 Agent |
| `90` | 每个安装默认有一个 Agent，代表「这台电脑上的 Agent 收件箱」：这台电脑上的任何 Agent（Claude Code、Codex）用 `morse message` 都能看到发给它的消息。 | A 身份 |
| `109` | …# 所有消息，含发出去的：delivered ✓ receipt = 对方那台电脑已收到 | B 对方 |
| `110` | …ssage --pull --inbox                    # 把发给这台电脑 Agent 的新消息取出来（取过就算处理了） | A 身份 |
| `115` | - 对方那台电脑不在线也没关系，不用重发。对方是新版时，消息密封后留在中转的离线信箱里，最多 7 天，他一上线就取走，中转随即删掉（中转看不到内容；7 天没取，你这边显示 `not delivered: … did not come onl | B 对方 |
| `119` | …的 Agent 会把它当成别人的话来处理，不会当成你的命令去执行。更新前已经配在你地址下的电脑（`morse contact` 里 `self` 分组的联系人）发来的不算同伴消息。 | D 以前配对的 |
| `121` | …ed`，送达后显示 `delivered`。对方离线或网络断了不用重发：已收到的块留在对方电脑上，恢复后只补剩下的。对方收齐、校验通过后，正文和附件才一起出现在他的收件箱里；收齐之前他的 `morse message` 显示 `receiv | B 对方 |
| `122` | - 发给还没同意你的人：附件不会传过去（对方请求区里只看到文件名和大小），他同意后你的电脑自动把文件补发过去。 | B 对方 |
| `124` | ## 4. 这台电脑上的地址 | A 身份 |
| `127` | morse address                      # 这台电脑上的地址、各自的名字、连的哪个中转 | A 身份 |
| `128` | morse address add codex            # 在这台电脑上再建一个地址：一个新 Agent，有自己的钥匙 | A 身份 |
| `151` | …、要先过好友请求。所以**同时知道你两个地址的人，从你这边的任何回应里都看不出它们是同一台电脑**。只有一个地址时什么都不变。有几个地址时： | A 身份 |
| `153` | - `morse contact`、`morse message` 列出这台电脑上的全部，每行末尾标 `via <名字>`；只看某个地址的加 `--from <名字>`。 | A 身份 |
| `154` | …就是第一个地址）。`morse send <备注>` 从这条联系人所属的地址发；备注在整台电脑上不重名。 | B 对方 |
| `162` | - 名字是你在这台电脑上的叫法，用小写字母、数字和 `-`，不能叫 `add`、`rename`、`remove`。`rename`、`remove` 写名字或地址都行。 | A 身份 |
| `163` | …新加的地址要重启后台服务后才能收发。`--from @<agent>:<会话>` 仍然表示这台电脑上的一个会话。 | A 身份 |
| `164` | - 这里只列**这台电脑**上的地址。你的其他电脑是联系人，在 `morse contact` 里，见上面「你自己的另一台电脑」。 | C 别处的 Agent |
| `172` | …# 分组标签随你起，新加的人是 other；self 留给更新前已经配好的自己的电脑，不要手动用 | D 以前配对的 |
| `185` | …ct                         # 联系人，末尾是请求区：地址、哪台电脑、第一条消息、时间 | B 对方 |
| `194` | - 已经加过的联系人（包括 `self` 分组里你以前配好的电脑）不受影响。 | D 以前配对的 |
| `206` | …"totalPerMinute": 300 }`：默认不限（ADR-073）。写了才限：这台电脑每分钟最多收同一个人 30 条、总共 300 条，超出的丢掉（对方那边会留着、稍后自动重发）；两个上限各自生效，0 = 不限。 | A 身份 |
| `211` | …` 里加 `"update": {"auto": false}`。**这个功能出现之前装的电脑要最后手动升级一次**（再跑一遍安装命令）。 | A 身份 |
| `212` | - 从旧版升级：再跑一遍安装命令（什么都不带）即可，已加入的电脑地址不变。它会换掉旧的后台服务（`dev.anytoany.daemon` → `talk.morse.daemon`），把 `~/.anytoany` 整个搬到 `~/.mo | A 身份 |
| `241` | - 先删掉这台电脑上的地址（不然名字会一直占着）：`morse address` 看有哪些，逐个 `morse address remove <名字>`——要在卸载 npm 包之前做。 | A 身份 |
| `244` | - 数据：`~/.morse/`（收件箱、配对名单、**这台电脑的身份密钥**；以前装过的，`~/.anytoany` 是指向它的链接，一起删）。删掉后这台电脑的地址就没了，再安装会拿到一个新地址（原来的回不来）；想让管理员把旧设备从名单里 | H 旧命令 |

### `docs/QUICKSTART.en.md`（40 处）

| 行 | 现在 | 归类 |
| --- | --- | --- |
| `15` | …hooks to Claude Code / Codex → **gives this computer its own address** → runs the daemon in the background at login. At | A 身份 |
| `19` | …address is 26 characters, derived from this computer's key — unique, and nobody else can use it. **No account, no passw | K 保留 |
| `21` | …is retired, so write `morse.im` from now on. Computers installed before need no change. | A 身份 |
| `22` | - **This computer's address has a name, and you choose it** (just your label on this computer): `... \| bash -s -- --age… | A 身份 |
| `23` | …ows it). Re-running the install command on a computer that already joined only upgrades it; the address stays. | A 身份 |
| `32` | The first line is this computer's address, followed by your name for it. **That line is the one to give out**: someone | A 身份 |
| `44` | ### Another computer of yours | C 别处的 Agent |
| `46` | …— it gets its own address. Then add the two computers to each other as contacts: run `morse address` on each and add th | C 别处的 Agent |
| `49` | …# "air" is your remark for it; once on each computer | A 身份 |
| `50` | …ols Read,Grep,Glob               # what this computer's agent may do for group mine | A 身份 |
| `54` | …IN-ATTENDANT.md)). Morse has no special "own computer" trust: the other computer is a contact, its messages are peer mes | D 以前配对的 |
| `55` | - Computers that were already paired under one address before this release need nothing: after the update they show up i | D 以前配对的 |
| `57` | ### If you lose a computer | A 身份 |
| `59` | …an address is held by the private key on its computer, and once every computer of an address is gone, so is the address. | D 以前配对的 |
| `77` | …\| the agent at that address — **only the one computer that hosts it** \| | A 身份 |
| `80` | …our remark) \| one of your contacts — another computer of yours included \| | C 别处的 Agent |
| `86` | Each install has one agent by default, "this computer's agent inbox": any agent on it (Claude Code, Codex) sees its mess | A 身份 |
| `105` | …, sent ones too: delivered ✓ receipt = their computer has it | B 对方 |
| `106` | …# take new messages for this computer's agent (marks them processed) | A 身份 |
| `111` | - Their computer offline? Do not resend. If they run the current Morse, the sealed message waits in the relay's offline | B 对方 |
| `114` | …cept. What you send after that waits on your computer (`waiting for … to accept your message request`) and goes out by i | D 以前配对的 |
| `115` | …words, never as your commands. Messages from computers that were already paired under your address before this release ( | D 以前配对的 |
| `117` | …t resend: the chunks they have stay on their computer and only the rest is sent later. The message (text and files toget | B 对方 |
| `118` | …nly names and sizes); once they accept, your computer sends the files by itself. | D 以前配对的 |
| `120` | ## 4. The addresses on this computer | A 身份 |
| `123` | …# the addresses on this computer, your name for each, the relay | A 身份 |
| `124` | …d codex            # another address on this computer: a new agent with its own key | A 身份 |
| `147` | …anything your side answers that they are one computer**. With one address nothing changes. With several: | A 身份 |
| `149` | …and `morse message` list everything on this computer, each row ending `via <name>`; add `--from <name>` to see one addr | A 身份 |
| `150` | …ct belongs to; remarks are unique across the computer. | A 身份 |
| `158` | - The name is your label on this computer: lowercase letters, digits, `-`, and not `add`, `rename` or `remove`. `rename` | A 身份 |
| `159` | …nt>:<session>` still means a session on this computer. | A 身份 |
| `160` | - Only **this** computer's addresses are listed. Your other computers are contacts — see `morse contact` and "Another co | C 别处的 Agent |
| `168` | …contacts are "other"; "self" is for your own computers paired before the update — do not set it by hand | D 以前配对的 |
| `181` | …ontacts, then the message requests: address, computer, first message, time | A 身份 |
| `190` | …tacts you already added (your earlier-paired computers in group `self` included) are not affected. | D 以前配对的 |
| `207` | …"auto": false}` to `~/.morse/config.json`. **Computers installed before this feature need one last manual upgrade** (run | D 以前配对的 |
| `208` | …tall command again (nothing after `bash`); a computer that already joined keeps its address. It also replaces an older d | H 旧命令 |
| `237` | - First remove this computer's addresses (otherwise the names stay taken): `morse address`, then `morse address remove < | A 身份 |
| `240` | - Data: `~/.morse/` (inbox, contacts, **this computer's identity key**; `~/.anytoany` is a link to it on older installs) | K 保留 |

### `README.md`（26 处）

`README.md` 一大半还是 anytoany 时期按设备配对的写法（H）：P-B 里重写成「发一句话」开头的版本，旧内容挪到历史文档。

| 行 | 现在 | 归类 |
| --- | --- | --- |
| `8` | …sion on another Mac — across vendors, across machines — and the reply comes home to the session you asked from.<br> | A 身份 |
| `32` | …talls the CLI, configures every agent on the machine (skill + inbox hook): | A 身份 |
| `46` | ## Link a second device | C 别处的 Agent |
| `48` | On the first machine: | A 身份 |
| `54` | …opy-paste command**. Paste it into the other machine's terminal, or hand it to any agent running there. The command inst | C 别处的 Agent |
| `60` | …cs.syncthing.net/users/security.html): every device has its own key, its device ID is that key's certificate fingerprint | H 旧命令 |
| `72` | …, sends it, and tells you it's queued. Cross-device is identical — it just carries a device prefix: `@mini/codex:api`. W | H 旧命令 |
| `96` | …n by **multiple AI coding agents on multiple machines** — Claude Code refactoring the backend on your MacBook, Codex fix | A 身份 |
| `100` | …inside a single process. Cross-vendor, cross-device, session-to-session messaging didn't exist. That's the gap `anytoany | H 旧命令 |
| `123` | …— discovers every addressable session on the machine (by scanning each CLI's own session store), queues messages in a du | H 旧命令 |
| `124` | …jour and talk over **mutual TLS 1.3**. Every device has its own Ed25519 key, and its device ID is the certificate finger | H 旧命令 |
| `133` | …ress              # your address(es) on this computer, the relay | A 身份 |
| `142` | …, which keeps working. Every address on this computer can send: `morse send --from <name> <who> "…"`. **Another computer | C 别处的 Agent |
| `212` | anyd pair                  # each machine: print its device ID (public) | H 旧命令 |
| `213` | anyd pair add <other ID>   # each machine: trust the other one | H 旧命令 |
| `214` | anyd pair list             # who this machine trusts | H 旧命令 |
| `215` | anyd pair remove mini      # revoke one device — nothing to rotate elsewhere | H 旧命令 |
| `216` | …yd pair --name mini      # optional friendly device name | H 旧命令 |
| `227` | \| `@mini/codex:fron` \| same, on the paired device `mini` \| | H 旧命令 |
| `231` | …a session only for mail you send on your own machines. A message from another person's address never picks one of your s | A 身份 |
| `235` | anytoany runs entirely on **your own machines, on your own LAN** — no cloud, no accounts. The trust boundary is delibera | H 旧命令 |
| `237` | - **A single-operator cluster.** Every device you pair is **yours**, and gets the highest trust tier (`owner`). A messag | H 旧命令 |
| `238` | …promised peer.** The boundary is your paired devices' keys, not the message text. A stolen `~/.morse/identity/key.pem` c | H 旧命令 |
| `239` | …ll-permission execution is an explicit **per-machine owner opt-in** (off by default, set locally) — never something a se | A 身份 |
| `241` | …* The web console binds to `127.0.0.1` only. Device-to-device traffic uses a separate port (7434) over TLS 1.3 with forw | H 旧命令 |
| `247` | Same-machine and **LAN cross-device** messaging are **implemented and verified end-to-end** — 224 tests, real-delivery s | H 旧命令 |

### `README.zh-CN.md`（24 处）

同上。

| 行 | 现在 | 归类 |
| --- | --- | --- |
| `24` | 一条命令——装好 CLI、配好本机全部 agent（skill + 收件 hook）： | K 保留 |
| `38` | ## 连接第二台设备 | C 别处的 Agent |
| `46` | 它会打印**一条复制粘贴命令**。贴到另一台机器的终端，或者直接交给那台机器上的任何 agent：命令会装好 anytoany、信任第一台机器，并打印新机器自己的**设备 ID**。回到第一台机器，反过来信任它： | C 别处的 Agent |
| `52` | …://docs.syncthing.net/users/security.html)：每台设备有自己的钥匙，设备 ID 就是证书指纹，双方互相添加对方的**公开** ID，全程没有任何秘密要粘贴。之后两台 daemon 走**双向 TLS | H 旧命令 |
| `62` | 跨设备同样写法：`@mini/codex:前端 …`。回信自动回到你的会话。也可以打开[控制台](http://127.0.0.1:7433)手动连线两个会话。 | H 旧命令 |
| `66` | 同一个项目，常常同时被**多台设备上的多个 AI agent** 开发：MacBook 上的 Claude Code 在改后端，Mac mini 上的 Codex 在修前端，Kimi 在别处跑另一块。 | H 旧命令 |
| `70` | …塞进一家壳里并不是答案。Codex 已能把活交给自己的子代理，但只限单进程内部。跨厂商、跨设备、session 到 session 的互通此前是空白——`anytoany` 填的就是这个，而且**零编排层：它把各家自己的 headless | H 旧命令 |
| `81` | - **一个小 daemon（`anyd`）**——自动发现本机全部可寻址会话（扫描各家 CLI 自己的会话存储），消息进 SQLite 持久驿站（回执/重试/死信），通过各厂商**官方 headless resume 通道**投递（`cl | H 旧命令 |
| `82` | …emon 之间用 mDNS/Bonjour 自动发现，走**双向 TLS 1.3**。每台设备有自己的 Ed25519 钥匙，设备 ID 就是证书指纹，配对就是互相添加对方的公开 ID（照抄 Syncthing）。没配对的设备一律被拒；冒用 | H 旧命令 |
| `90` | morse address              # 这台电脑上我的地址、中转 | A 身份 |
| `91` | …#   address add <名字>（在这台电脑上再建一个：新 Agent，有自己的钥匙）\| rename \| remove | A 身份 |
| `99` | …old，改用他的 old name 旧链接（`morse.im/…`），旧链接照常能用。这台电脑上的每个地址都能发信：`morse send --from <名字> <谁> "…"`。**你自己的另一台电脑**：在那台电脑上照样装一遍 M | C 别处的 Agent |
| `108` | …v ZCODE_MESSAGE_ENABLED 1`，然后退出并重新打开 ZCode（重启电脑前有效）。如果回合结束时信还没被取走，anytoany 会把它收回、改用原来的方式投递，不丢也不重复。 | A 身份 |
| `134` | anyd pair                  # 每台：打印本机设备 ID（公开） | H 旧命令 |
| `136` | anyd pair list             # 本机信任哪些设备 | H 旧命令 |
| `137` | anyd pair remove mini      # 吊销一台，其他设备无需任何改动 | H 旧命令 |
| `138` | anyd pair --name mini      # 可选：设备名 | H 旧命令 |
| `167` | \| `@mini/codex:前端` \| 同上，目标在已配对设备 `mini` 上 \| | H 旧命令 |
| `171` | 这些写法只对你在自己的电脑上发的信选会话。别人的地址发来的信，不管带着什么 agent 名、会话名，都不会选中你的任何一个会话：它在那个 agent 的信箱里等着（`morse message`）——只有你的会话发起的线程里的回信会回到那个 | A 身份 |
| `177` | - **单一操作者集群。** 你配对的每台设备都是**你自己的**，享有最高信任档（`owner`）。只有你明确信任过其钥匙的设备，消息才能进入集群（双向 TLS、指纹锁定）。在这个边界内，agent 之间当作**可信队友**协作——把自己 | H 旧命令 |
| `178` | - **不假装能防住被攻陷的 peer。** 边界是已配对设备的钥匙，不是消息正文。偷走 `~/.morse/identity/key.pem` 就能冒充该设备（与 Syncthing 相同），请像保护 SSH 私钥一样保护它；用 `any | H 旧命令 |
| `179` | …I 按键、不碰 `--dangerously-*`。把 agent 提到全权执行是**机主本机的显式开关**（默认关、本地配置）——发送方永远无法要求。 | A 身份 |
| `180` | …**回环 + 双向 TLS；默认不设防循环上限。** 控制台仅绑 `127.0.0.1`；设备之间走独立端口（7434）的 TLS 1.3，具备前向保密，线路上读不了也伪造不了。未配对设备收到 403，只会显示为配对请求，永远不会变成消息。 | H 旧命令 |
| `186` | 同机与**局域网跨设备**消息互通**已实现并端到端实证**——224 个测试、真实投递冒烟套件，以及一台 MacBook + 一台 Mac mini 上的日常自用（Codex ↔ Claude ↔ Kimi ↔ ZCode）。今天已上线五 | H 旧命令 |

## 4. 不改的：隐藏的旧命令和旧配对路径（H，84 处）

`morse --help` 不列这些命令；它们说的就是设备（设备 ID、局域网配对、中转的设备名单）。列在这里只为了说明「扫到了、决定不动」。


- `src/cli.ts`：353, 354, 515, 554, 737, 894, 895, 896, 897, 898, 903, 916, 917, 919, 937, 945, 950, 973, 989, 1129, 1133, 1191, 1209, 1212, 1217, 1222, 1251, 1270, 1301, 1324, 1330, 1331, 1336, 1353, 1359, 1363, 1365, 1423, 1452
- `src/cluster/e2e.ts`：151
- `src/cluster/join.ts`：83, 95, 102, 170, 401, 414
- `src/cluster/lan.ts`：187, 188, 197
- `src/cluster/morse.ts`：629, 1037, 1140, 1398, 1406, 2181, 2195, 2492, 2497, 3344
- `src/cluster/pair-commands.ts`：76, 94, 139, 144, 151, 152, 173, 191, 213, 224, 230, 233
- `src/cluster/peer-api.ts`：70, 109
- `src/cluster/peers.ts`：176, 248
- `src/cluster/secure-transport.ts`：80, 105
- `src/cluster/sync-agents.ts`：47
- `src/cluster/trust.ts`：68
- `src/daemon/dispatcher.ts`：90
- `src/daemon/server.ts`：428
- `src/doctor.ts`：158, 162, 166

## 5. 不改的：daemon 日志（L，56 处）

- `src/cli.ts`：464, 559, 755, 909, 969, 992, 1165, 1166, 1173, 1174, 1198, 1228, 1306, 1381, 1383, 1762
- `src/cluster/contact-split.ts`：119, 192
- `src/cluster/direct.ts`：311, 560
- `src/cluster/effective-trust.ts`：62
- `src/cluster/morse.ts`：576, 767, 1082, 1098, 1099, 1237, 1367, 1376, 1377, 1415, 1460, 1747, 1769, 1794, 1907, 2061, 2077, 2367, 2380, 2753, 2780
- `src/cluster/pair-commands.ts`：47, 49, 50, 52, 58, 60, 104, 124, 154, 176
- `src/cluster/relay-client.ts`：400
- `src/commands/messaging.ts`：437, 719
- `src/plugins/dispatch/main.ts`：152

## 6. 测试里钉着这些字的地方

改 A / B / C / D 类的字，下面这些测试里的期望要一起改（它们逐字比较输出）：`test/cli-personas.test.ts`、`test/cli-older-daemon.test.ts`、`test/cli-upgrade-refused.test.ts`、`test/migrate-v4.test.ts`、`test/address-personas.test.ts`、`test/install-sh.test.ts`，以及 `test/cli-personas.test.ts` 用的那份从上一版抓下来的 50 步文字输出（ADR-083「只有一个地址的电脑输出逐字不变」那一条——改字之后这条对照要换成新的基线，这是 P-B 里要主人知情的一处）。


## 7. 第二轮：把剩下的改完（2026-11-15）

原则同上：**只有两个名词——地址（自己的）、联系人（别人，包括自己在别处的 Morse）**；「电脑 / 设备 / 这台机器」能不说就不说，句子必须仍然是真的。「here」= 这一份 Morse 安装。

### 7.1 `site/index.html`（首屏以下；英文在 HTML 里、中文在 `zh` 表里，两处一起改）

| 键 | 改之前（en） | 现在（en） | 现在（zh） |
| --- | --- | --- | --- |
| `ownTitle` | Another computer of yours | Morse somewhere else too | 在别处也装了 Morse |
| `ownText` | Install Morse there too — it gets its own address. Then add the two computers to each other as contacts … | Wherever else you install Morse, it gets its own address — to you it is a contact. Add the two to each other: run `morse address` on each side … | 在别处再装一份 Morse，它有自己的地址——对你来说它就是一个联系人。两边互相加上…… |
| `ownNote` | … the group only marks computers that were already paired before the update | … the group only marks the contacts that were already paired with you the old way, before the update | ……这个分组只是更新时自动标给以前按旧方式和你配好的那些联系人…… |
| `addr1` | … reaches one agent, on the one computer that hosts it | … mail to it goes only to where its key is kept | ……发给它的信只送到存着它钥匙的地方 |
| `addr2` | Each new install is one agent with its own address. `morse address add <name>` creates another address on this computer — a new agent with its own key | Each new install has its own address. `morse address add <name>` creates a second, separate one with its own key — only if you want one | 每个新安装有自己的地址。`morse address add <名字>` 再建一个单独的地址（有自己的钥匙）——只在你想要的时候 |
| `addr4` | Every address on this computer can send | Each of your addresses can send | 你的每个地址都能发信 |
| `addrNote` | An address is held by a key on the computer that hosts it. If that computer is lost … | An address is held by its key, kept where Morse is installed. If that key is lost … | 地址由它的钥匙持有，钥匙存在装 Morse 的地方。钥匙丢了…… |
| `story2` | your identity is a key on your own computer, your messages are kept on your own computers | your identity is a key you hold, your messages are kept on your side | 身份是你自己手里的钥匙，消息存在你自己这边 |

剩下的「machine / device」只在脚本注释和代码里（`width=device-width`、`devicePixelRatio`），页面上看不到。`addr2` 里的 `morse stop && morse start` 没动（不在这一轮的范围；ADR-089 补充三把命令行里的提示统一成了 `morse stop --restart`，站点这一句以后顺手改）。

### 7.2 `site/agent.md`、`site/llms.txt`、技能

- `agent.md`「Before you start」：`Morse runs on your user's own computer … cannot run commands on your user's computer … an agent that runs on your computer` → `Morse runs where you run commands for your user. You need a shell on their side … cannot run commands for your user … an agent that can run commands for you`。
- `llms.txt`：`It runs on your user's own computer` → `It needs a shell on your user's side`。
- `skills/morse/SKILL.md`（`skill-repo/` 由 `node scripts/lib/skills.mjs` 重新生成）：`compatibility` 改成 `a shell on your user's side`；`sessions on this machine` / `Sessions on this machine` / `Session mail on this machine` / `any session on this machine` → `here`；`It lives on ONE machine` → `It lives in ONE place, where its key is kept`；「Another machine of your user's」→「Your user's Morse somewhere else — it has its own address there, so to you it is a contact」；「Several addresses on one machine」→「Several addresses here」；`self` 分组的两处说明改成「the contacts that were paired the old way, before an earlier update」；信任模型那条 `from a session on your operator's own machines` → `from a session here, or from your operator's own installs paired the old way (group self)`——意思不变，和提示词的新说法一致。
- **保留**：`@<device>/<agent>:… on a paired LAN device`（隐藏的局域网会话目标写法，和 v2 一起删）。

### 7.3 两段提示词（P 类）

改了，只换说法、不换意思；新加的测试钉住新文字、钉住两段里都没有 machine / device / computer，原来钉着「带操作者授权 / 不带」的测试一条没改、全部通过。

| | 改之前 | 现在 |
| --- | --- | --- |
| `src/envelope.ts`（自己的会话信，带操作者授权） | `The same human who runs your session paired these machines with a shared secret and set this collaboration in motion.` | `The same human who runs your session also runs the sender — a session here, or one of their own installs they paired with this one before — and set this collaboration in motion.` |
| `src/peer-framing.ts`（别人的信，不带授权） | `This came from @<agent> on @<name>, a device that belongs to SOMEONE ELSE (paired as a peer, not as one of your operator's devices).` | `This came from @<agent> on @<name>, which belongs to SOMEONE ELSE (a peer, not part of your operator's own cluster).` |

为什么意思没变：自己的会话信能到这段话的只有两种来源——这里的会话、更新前按旧方式配好的自己的安装（`self` 分组），新说法正好列出这两种；「shared secret」本来就不准（局域网配对交换的是公开的设备 ID），去掉它不影响后一句「therefore carries your operator's authority」。别人的信：「SOMEONE ELSE」「不带操作者授权」「只当信息」三点原样保留，「不是你主人的设备」换成和自己会话信同一个词「不是你主人自己的 cluster」。

### 7.4 命令行里剩下的（用户 / Agent 看得见的字）

改了的：

| 位置 | 改之前 | 现在 |
| --- | --- | --- |
| `src/cli.ts` `morse start`（交给 launchd / systemd 时） | `daemon: launchd runs it on this computer — started there (…)` | `daemon: launchd runs it — started through launchd (…)` |
| `src/cli.ts` `morse status` 说明 | `--check also checks this computer is ready for Morse` | `--check also checks the environment is ready for Morse` |
| `src/cli.ts` `morse join`（新建地址后的提示） | `another machine of yours: install Morse there too — it gets its own address — then add each other as contacts (morse contact add …)` | `Morse somewhere else too: it gets its own address there — to you it is a contact; add each other (morse contact add …)` |
| `src/cli.ts` `morse list` 说明 | `List addressable sessions discovered on this machine` | `List addressable sessions found here` |
| `src/cli.ts` `morse send --from <不存在的名字>` | `error: "<x>" is not one of this computer's addresses — …` | `error: "<x>" is not one of your addresses here — …`（和别的命令同一句了；ADR-088 原来为了「只有一个地址时逐字不变」留着它，这一轮按主人的要求改，对照里这一行跟着改） |
| `src/cli.ts` `morse plugin`（dispatch 那一行） | `built-in (own agents: same-machine session mail, your own devices)` | `built-in (own agents: session mail here, your own devices)` |
| `src/cli.ts` `morse plugin`（Windows） | `note: none of them runs on this computer — plugins are …` | `note: none of them runs here — plugins are …` |
| `src/commands/messaging.ts` `morse contact remove` | `removed <who> (N computer(s) no longer trusted) — history kept; …` | `removed <who> (no longer trusted) — history kept; …`（JSON 的 `devices` 字段不变） |
| `src/daemon/server.ts` 控制台接口的两句报错 | `files can only be sent to another device over the Morse relay` · `the web console sends between sessions on this computer only — …` | `… to another address over the Morse relay` · `the web console sends between sessions here only — …` |
| `src/platform/doctor-win.ts` `morse status --check`（Windows） | `fine if you do not use Claude Code on this computer` · `no Claude Code or Codex session found on this computer yet` | `… here` · `… found here yet` |
| `src/platform/platform.ts` Windows 不支持的功能 | `LAN (devices on the same network)` | `LAN (Morse on the same network)` |

保留的（照实说机器，或者是要和 v2 一起删的旧路）：

| 位置 | 文字 | 为什么留 |
| --- | --- | --- |
| `src/cli.ts:212` | `… N of your own computer(s) are now contacts in group self` | D：说的就是更新前按电脑配对的那些 |
| `src/cli.ts:1010` | `open it in a browser on this computer within a minute` | K：链接是 `127.0.0.1`，只能在这台机器的浏览器里开 |
| `src/cli.ts:1036` | `device: <id>`（`morse status`） | 内部调试行；`key: value` 格式，脚本按行首读 |
| `src/cli.ts:506-507, 662` | `--peer-port`（other devices）、`--relay`（paired devices off the LAN）、`lan: device "…" … paired device(s)` | H：局域网配对；`^lan: device` 被 `scripts/morse-e2e-lan*.sh`、`morse-e2e-requests.sh` grep |
| `src/cli.ts:722, 768, 773` | `device "…" unreachable …`、`not this device (another HOME?)`、`relay: paired … device(s)` | H：v2 设备路由 / 旧配对 |
| `src/cli.ts:1211-1309`（`pair`、`relay`、`relay show`） | 设备 ID、`(this computer)` 等 | H：隐藏命令；`relay show` 的行被 `install.sh` 和 `scripts/morse-e2e-agents.sh` 读（`^agents: … (this computer)`、`^device:`） |
| `src/cli.ts:1533-1635`（`join` 的选项和配对码、`device`） | `this device was already a member`、`on the computer of the new agent`、`N computer(s)` 等 | H：配对码 / `join --code` / 隐藏的 `device` 命令 |
| `src/cli.ts:1657-1763`（隐藏的 `agent` 命令） | `on this computer`、`this computer's first address`、`which computer hosts each` | H：隐藏的 v2 `agent` 命令；`(default, this computer)` 被 `scripts/morse-e2e-agents.sh`、`morse-e2e-register.sh` grep |
| `src/cli.ts:1769-1833`（`admin invite`、`peers`） | `another device of an existing one`、`LAN devices` | H |
| `src/cli.ts:2625` | `your own devices`（dispatch 那一行的后半） | D |
| `src/cluster/requests.ts:158` | 请求列表里旧请求的 `computer <名字>` | H：只有按 v2 设备来的旧请求才有这一栏 |
| `src/commands/messaging.ts:472, 473, 532, 692` | `still paired with this computer as one of your own`、`an ordinary contact's computer`、`one of your own computers — move it out of group self`、`"me" for your own sessions and devices` | D |
| `src/cluster/join.ts`、`pair-commands.ts`、`lan.ts`、`peer-api.ts`、`secure-transport.ts`、`e2e.ts` | 设备 ID、配对、局域网 | H（同第 4 节） |
| `src/cluster/morse.ts:633, 1040, 1143, 1401, 1409, 2495, 2500, 3385` | `the relay does not list that device under …`、`no paired device has the address …`、`"<x>" is N devices`、`is this device on its allowlist?` | H：按 v2 名字（handle）找设备的旧路 |
| `src/cluster/morse.ts:2184, 2198` | 给对方 daemon 的 HTTP 报错 `this device is paired under …`、`not sealed by this device` | H：协议里的回复，对方程序读 |
| `src/doctor.ts:171-179` | `device identity (mutual TLS)`、`paired device(s)` | H：局域网的设备身份 |
| `src/identity/envelope.ts:155` | `check this computer's clock` | K：说的就是这台机器的时钟 |
| `src/cluster/agents.ts:55` | 默认名 `computer` | 是一个值不是句子（主机名里一个字母数字都没有时的内部名），`contact-split.ts` 也用它推旧联系人的名字，测试钉着；和 v2 的 agent 名一起走 |
| `src/integrations/sds.ts`（闪电说的中文技能） | 「这台电脑上其他 AI agent 会话」「本机 daemon」 | K：这份技能只管本机的会话、只走本机的 HTTP 接口，范围就是这台机器 |
| `src/plugins/ilink/inbound.ts:306` | 「已保存到本机」 | K |

### 7.5 daemon 日志（`~/.morse/daemon.log`）

改了的（纯说明、没有测试或脚本读）：

| 位置 | 改之前 | 现在 |
| --- | --- | --- |
| `src/cluster/morse.ts` 收件限速 | `— their device keeps them and tries again later` | `— they keep them and try again later` |
| `src/cluster/morse.ts` 地址不在了 | `— this computer no longer has it (or its key is not loaded)` | `— it is no longer here (or its key is not loaded)` |
| `src/cluster/morse.ts` 同意请求后通知对方（两处） | `— their computer sends …` / `— their device sends what it held back on its next try` | `— they send what they held back on their next try` |
| `src/cluster/morse.ts` 丢弃的 v3 信封 | `an address this computer does not hold right now` | `an address that is not here right now` |
| `src/cluster/morse.ts` v3 起不来 | `cannot set up this computer's address` | `cannot set up your address here` |
| `src/cluster/morse.ts` 本地投递 | `is for <x> — this computer; filed locally` | `is for <x> — here; filed locally` |
| `src/cluster/relay-client.ts` | `says this computer's old name is …` | `says your old name is …` |
| `src/plugins/dispatch/main.ts` 启动行 | `own agents only (same-machine session mail, your own devices)` | `own agents only (session mail here, your own devices)`（行首 `morse-plugin-dispatch started` 不变，测试读它） |
| `src/cluster/direct.ts` | 关直连的原因 `the device is offline` | `the other side is offline` |
| `src/cli.ts` 启动时的 relay 行 | `— LAN first for devices on this network` | `— LAN first on this network` |

保留的：

- 测试读的：`relay only for this device for N min`（`test/direct.test.ts`）、`that is an address of this computer`（`test/morse-address.test.ts`）、`ONLY this computer's first address is online`（`test/morse-address-binding.test.ts`，同一行里的 `the addresses of this computer's other agents` 也就一起留着）。
- D：`your computer <x> … is now a contact in group self`（`contact-split.ts`）、`whether your own computers are still in group self`（`effective-trust.ts`）、启动行里的 `your own devices`。
- H：v2 / 局域网配对的那些（`UNPAIRED device`、`auto-paired … device(s)`、`tier owner — your own devices`、`no device certificate`、`not devices paired here`、`not a contact or paired device here`、`not on the relay allowlist`、`lan: …`、`relay: … device(s) under your own handle … upgraded`、`relay: paired … on first send (N device(s)`）。

### 7.6 「只有一个地址时逐字不变」的对照和别的逐字测试

对照（`test/cli-personas.test.ts` 第 1 组）只变了一行：`send --from nosuch` 的报错（见 7.4）。另外跟着改的逐字期望：`test/cli-address.test.ts`（`morse join` 的提示、`--from` 报错）、`test/platform.test.ts`（`LAN (Morse on the same network)`）、`test/local-api-followups.test.ts`（控制台报错）。新加：`test/envelope.test.ts` 两条（两段提示词的新文字、没有 machine / device / computer、授权的有无不变）。
