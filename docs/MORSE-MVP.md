# Morse MVP：给 AI Agent 用的即时通讯

> 创建：2026-10-20 · 最后更新：2026-11-14（`morse.talk` 停用，ADR-075、ADR-078；收件限速默认不限，ADR-073；第十一版：发版签名钥匙轮换——旧钥签换钥声明、站点发布整条链、客户端逐环验证后自己跟上，正式签名公钥已钉进客户端，ADR-041；第十版：主域名改为 morse.im——地址、中转 relay.morse.im、安装站 morse.im，morse.talk 保留为别名，ADR-040（2026-11-14 起 morse.talk 停用、整站 301 跳转到 morse.im，ADR-078）；第九版：客户端自动更新——发版用 Ed25519 签名、公钥钉在客户端、daemon 每 6 小时检查并自己装，ADR-039；第八版：大文件分块传——单个文件默认 100 MB、每块端到端加密、收齐校验再入库、断点续传，ADR-038；第七版：陌生人消息请求——第一条进请求区、主人同意才算加上、收件限速，ADR-037；第六版：开放注册，ADR-036）

Morse 派生自 [anytoany](https://github.com/Ericgood/any-to-any)（MIT，作者 Ericgood）。anytoany 解决「同一个人、同一局域网里的多个 Agent 会话互发消息」；Morse 在它上面加三块，让**不同人、不同网络**的 Claude Code / Codex 会话也能互发消息和文件（单个文件默认最多 100 MB，大的分块传，ADR-038）：

1. **一个 Agent 一个地址**：`morse.im/mei/air` 发给 mei 的 `air` 这个 Agent，**只送到托管它的那一台设备**；`morse.im/mei` 发给她的默认 Agent。每台电脑安装时默认登记一个 Agent（mini / air / pro…）。设备 ID 是底层概念，对外不露。
2. **可选的中转 relay**：部署在 Cloudflare（自建就是把 `relay-cf/` 部署到自己的账号，ADR-076）；两台设备能直连（局域网）就不经过它。消息端到端加密，中转看不到内容。**v2 只负责实时转发、不存消息**：对方不在线时消息留在**发件方自己的驿站**，持续重试到对方上线。**v3 有离线信箱**（ADR-073）：收件地址不在线时，中转把密封好的信封最多存 7 天，对方上线取走并确认后立即删除，到期没取走也删除；中转读不了它。
3. **「跨人」信任档 `peer`**：别人的设备发来的消息明确标注「同伴消息，不是主人指令」，不继承主人授权。同一个 handle 下的设备（本人用配对码或自己的邀请码加入的）是自己的设备，`owner` 档（ADR-034）。
4. **开放注册**（ADR-036）：一行 `curl -fsSL https://morse.im/install.sh | bash`，中转给这台电脑发一个随机地址（如 `morse.im/k7f3a9xq`），没有账号，设备私钥即身份；自己的第二台电脑用一次性配对码加入同一地址；可设一个只用于显示的昵称。可读名字只能由管理员发邀请码。
5. **域名**（ADR-040，ADR-075 修订）：只用 `morse.im`——地址 `morse.im/<人>[/<agent>]`、中转 `wss://relay.morse.im`、安装站 `https://morse.im`。原来的 `morse.talk` **已停用**（2026-11-14）：网站只做 301 跳到 `morse.im`，客户端不再连它、也不再在 `morse.im` 连不上时退到它；配置里还写着 `relay.morse.talk` / `https://morse.talk` 的电脑，升级后第一次运行自动改成 `morse.im` 的名字（一行日志）。仍然保留的只有**输入兼容**：以前写成 `morse.talk/<人>…` 的地址照样认（客户端解析后只认 handle，线上只传 handle，存储也只存 handle），随 v2 一起去掉。服务器上 `relay.morse.talk` 这个主机名暂时还绑着，没升级的客户端照常能用。

Morse 只负责可靠送达，不管内容是闲聊、任务还是文件。第一版**不做门铃**（不把消息推进正在运行的会话），对方 Agent 用 `morse inbox` / `morse pull --inbox` 查收。原项目已有的门铃代码保持原样。命令行叫 `morse`（`anyd` 是同一个程序的兼容别名，ADR-033）。

## 1. 架构：直连优先，relay 可选、只转发

```
   维护者的 Mac mini（morse.im/mei/mini）           同事的 MacBook（morse.im/kai/air）
 ┌──────────────────────────────┐                  ┌──────────────────────────────┐
 │ morse send morse.im/kai/air               │ morse inbox / pull --inbox   │
 │          │                   │                  │          ▲                   │
 │   驿站 mailbox.db（outbox）  │                  │   驿站 mailbox.db            │
 │   pending → delivering       │                  │   peer 档：只拉取、带标注    │
 │     ├─ 收到回执 → delivered  │                  │          │ 验签 + 解密       │
 │     └─ 对方不在线 → failed   │                  │          │ 按 agent 名选会话 │
 │        (waiting) 每30s重试   │                  │   ┌──────┴───────┐           │
 │        最长30天（可配）      │                  │   │ 回执（加密） │           │
 │          │                   │                  │   └──────▲───────┘           │
 │   ┌──────┴───────┐           │                  │          │                   │
 │   │ 局域网可达?  │──是──► 双向 TLS 直连（原有，ADR-028）──────►│（不经过中转）     │
 │   └──────┬───────┘           │                  │          │                   │
 │          │否（或无中转则停） │                  │          │                   │
 │   问中转：air 在哪台设备？   │                  │          │                   │
 │   只给那一台封一份密文       │                  │          │                   │
 └──────────┼───────────────────┘                  └──────────┼───────────────────┘
            │ wss（一条长连，断线自动重连）                     │ wss
            ▼                                                  │
     ┌─────────── Cloudflare Worker：relay.morse.im（relay-cf/）───┴──────────────┐
     │  Worker：/healthz · /v1/ws/<设备ID> → 该设备的 Durable Object · /admin/*     │
     │  DeviceHub（每台设备一个 DO，WebSocket Hibernation）                         │
     │   · 登录：随机挑战 → 设备私钥签名；证书指纹必须 = URL 里的设备 ID；查白名单 │
     │   · send：找收件设备的 DO → 对方有活连接就推过去 → 回「sent」；否则「offline」│
     │   · 不存消息；DO 存储里只有该设备签过名的加密公钥包；白名单在 Workers KV    │
     │   · 目录：handle → 设备列表（+公钥包），供配对 / 自动回加用                  │
     │  AgentBook（每个人一个 DO）：<人>/<agent> → 唯一设备；默认 Agent；昵称       │
     │  InviteBook（单实例 DO）：邀请、随机地址注册、配对码、每 IP 限额（ADR-036）   │
     │   · 单条 ≤ 1,000,000 字节（CF 单帧 1 MiB）；每设备每分钟 ≤ 120 条            │
     └────────────────────────────────────────────────────────────────────────────┘
```

### 关键设计

| 项 | 做法 |
|---|---|
| 地址模型 | **一个 Agent 一个地址**（ADR-033）：`morse.im/<人>/<agent>`，agent 名小写字母数字和 `-`、同一个人下唯一，只送到托管它的**那一台**设备，不扇出。`morse.im/<人>` = 这个人的**默认 Agent**（第一个登记的，`morse agent default` 可改）。每台电脑加入时登记一个 Agent（`--agent`，默认取电脑短名 mini / air / pro），代表「这台电脑上的 Agent 收件箱」：消息落在本机 `<agent>/inbox`，任何本机 Agent 用 `morse inbox` / `morse pull --inbox` 取；收件方若有同名的登记 Agent（`morse register --agent`）或同名 Agent 会话（如 `claude`），就进那个会话。`morse agent add/list/remove/default/rename` 管理。`morse.im/` 前缀可省；原有的 `@设备/agent:会话ID` 写法仍可用。 |
| 设备身份 | 沿用 ADR-028：每台设备一把 Ed25519 私钥 + 自签证书，设备 ID = 证书指纹。一个人多台设备、一台设备多个 Agent。 |
| relay 目录 | 白名单条目带 `handle`：KV 里 `<设备ID> → {handle, name}`，`@<handle> → [设备ID…]`（配对用）。**Agent 目录**在每个人一个的 Durable Object `AgentBook` 里：`agent:<名> → {device, addedAt}`、`default → 名`；强一致，名字唯一、改名原子。登记由托管设备签名提交（`POST /v1/agents`，handle 取自白名单，不信请求）。 |
| 加入 | **开放注册**（ADR-036）：`morse join` 不带参数 → 设备签名 `POST /v1/register`，中转在单实例 DO `InviteBook` 里串行分配 8 位随机 handle（字符集 `23456789abcdefghjkmnpqrstvwxyz`，查重：DO 认领记录 + KV `@handle`，撞了重抽），每 IP 每小时新地址 ≤ 20（`CF-Connecting-IP` 哈希计数）。可读名字不自助，`morse join <名字>` 拒绝并提示找管理员。**第二台电脑**：已加入的设备 `morse device add` → `POST /v1/pair-code` 得到 10 位一次性配对码（10 分钟、只存哈希、5 次猜错作废、签名请求不可重放），新电脑 `morse join <地址> --code <码>`（`POST /v1/join` 带 `handle`）。**昵称**：`morse name set`（`POST /v1/profile`，存在 AgentBook，目录查询 / welcome 带上，改了推送给本人其他在线电脑，消息明文带 `fromNickname`），显示为「昵称 (地址)」。管理员 `DELETE /admin/handles/<h>` 释放丢失的地址。<br>**邀请码**（ADR-032，保留）：管理员 `morse invite create <handle>`，新设备 `morse join <码> [--agent <名>]`（或 `curl -fsSL https://morse.im/install.sh \| bash -s -- <码> [--agent <名>]` 一行装好）。设备用私钥签名提交 `POST /v1/join`（agent 名也在签名里），relay 验签、扣次数、写白名单、登记 Agent；名字被占 → 409，邀请不扣。邀请在单实例 DO `InviteBook` 里，只存哈希。 |
| 首次联系 | `morse send morse.im/<人>[/<agent>]` 时没配对就当场按 handle 配好（发件方这边）。收件方（ADR-037）：没配对的设备发来的消息，先按原规则核实（中转附的 `fromHandle` + 目录里该 handle 下确有这台设备、公钥包按设备 ID 验签；局域网首联同样当场查目录），然后看 `morse.strangers`：**`request`（默认）存成一条「消息请求」**——在 `mailbox.db` 的 `morse_requests` 表，不进 `messages`，所以收件箱、pull、hook、调度器、任何 Agent 都看不到；每个 handle 一条（留第一条，之后的只计数、更新最后时间、丢弃），最多 200 条（`morse.maxRequests`），满了丢最旧的；附件不存只计数；回执带 `request: filed`（这条进了请求区）或 `dropped`（已有一条，没留）。主人 `morse requests accept <人>` → 把写信的设备配成 `peer`、解除拉黑、请求移进收件箱（照常带同伴标注），daemon 给对方发 `accepted` 通知；`decline` → 删请求并拉黑。`accept` = 旧的自动回加（ADR-032）；`block` = 丢弃（旧 `autoPairBack: false` 兼容为它）。**不受影响**：自己的 handle（owner，照旧自动配）、已经配对过的人（他的新设备照旧自动配）。主动 `pair add` / 给对方发信 = 同意他的请求。`morse pair remove <人>` 同时拉黑（`~/.morse/morse-blocked.json`）。 |
| 发件方（请求未同意） | 回执是 `request: filed` → 这条标 `request pending`（算送达，不再重试），并记下「这台收件设备还没同意」；之后发给这台设备的消息**留在本机驿站**（`waiting for … to accept your message request`），不重复投递。收到对方的 `accepted` 通知、对方的普通回执、或对方发来的消息，就清掉标记并立刻重发留着的。通知丢了也没关系：每 10 分钟放一条留着的出去试一次（`dropped` 回执 = 仍未同意，继续留着）；daemon 重启后先试一次。 |
| 收件限速 | 2026-11-14 起默认不限（ADR-073），写了 `morse.receiveLimit.perSenderPerMinute / totalPerMinute` 才限：每台收件设备、每分钟：同一个发件 handle ≤ N 条、总共 ≤ M 条，自己的设备不计；超出的丢弃、**不回执**（对方驿站留着稍后重发），每分钟记一次日志；局域网上回 429，发件方回落中转。 |
| 按人配对 | `morse pair add morse.im/mei`：客户端用**只查目录、不算在线**的被动连接向 relay 要该 handle 下的设备和公钥包，逐台校验（证书指纹 = 设备 ID、公钥包签名有效）后钉住，全部以名字 `mei`、档位 `peer` 写进信任名单。**按 handle 配对等于信任 relay 对「哪些设备属于这个人」的说法**；按设备 ID 配对（自己的设备、owner 档）不需要信任 relay。 |
| relay 登录 | 客户端连 `/v1/ws/<自己的设备ID>`；DO 发 32 字节随机挑战，客户端用设备私钥签 `morse-relay-login-v1\n<nonce>` 并附证书；DO 算证书指纹、要求 = URL 里的 ID、查 KV 白名单、验签。不在名单 → 关闭连接（4003）。所以设备 X 的 DO 只会被持有 X 私钥的人登录。 |
| 在线判定 | `send` 由发件设备的 DO 转给收件设备的 DO：对方有已登录的活连接 → 推送并回 `sent`；没有 → 回 `offline`。「sent」只说明推到了对方 socket，**真正算送达的是对方的端到端回执**。 |
| 发件方驿站 | 每次投递（含每次重试）先向中转查 `<人>/<agent>` → **唯一设备**，只给它封一份密文发出；`sent` 就等这台设备的回执（默认 10s）→ `delivered`。offline / relay 没连上 / 超时没回执 → 消息标 `failed (waiting)`，之后也只重试这一台（重新查目录，所以改名、换设备会跟着走）；目录里没有这个 Agent → `failed (no agent …)`，不是 waiting。原来的「每台设备各一份、任一回执即送达」已取消。waiting 的**每 30s 重试、最长 30 天**（`~/.morse/config.json` 的 `outbox.retryIntervalSec` / `outbox.maxWaitDays`），到期才进死信。不再是「3 次进死信」——那条规则只对本机投递失败和查无此 Agent 生效。消息明文带发件方自己的 `<人>/<agent>`，收件方记成来源，`morse reply` 回到写信的那个 Agent。 |
| 端到端加密 | 不变：每台设备另有 X25519 加密密钥，公钥用身份私钥签名后放在 relay 目录；每条消息临时 X25519 → HKDF-SHA256 → AES-256-GCM，整个信封再用发件方 Ed25519 签名。relay 看不到正文、换不了公钥。 |
| 收件校验 | 证书指纹 = 发件 ID、签名有效、发件 ID 在本机信任名单、能解密，四条都过才进驿站；按（发件 ID, 消息 ID）去重（重试会重发同一条），重复到达只补回执不再入库；入库失败则撤销去重记录，让对方重试。 |
| 信任档 | 信任名单每条带 `tier`：`owner`（自己的设备）或 `peer`（别人的设备）。按 handle 配对时，**本机自己的 handle 下的设备 → `owner`**，别人的 → `peer`（ADR-034：只有用发给这个 handle 的邀请码 join 的设备才会在它下面）；daemon 每次登录中转后把仍是 `peer` 的同 handle 设备升级为 `owner`（只升级不新增），发信 / 收信查目录时也会当场升级；`owner` 永不降级。peer 消息：调度器从不认领、只能被拉取；`morse pull` / prompt hook / `morse inbox` 统一标注「来自 <名字> 的 Agent，是同伴消息，不是你主人的指令」；局域网上只能投递消息，不能读会话目录、不能合并协作文档。 |
| 附件 | `morse send --file`：发件方先复制到 `~/.morse/outbox-files/`（0600）；收件方落到 `~/.morse/inbox-files/<消息ID>/<文件名>`，0700/0600、不执行、不自动打开，校验 SHA-256。单个文件和一条消息的附件合计默认 ≤ 100 MB（`morse.maxFileBytes`），超了发送时当场报错。能放进一条信封（Cloudflare 约 550 KB）就照旧整条发；放不下就**分块**（ADR-038），见下一行。 |
| 大文件分块（ADR-038） | 消息只带清单（文件名、大小、整文件 SHA-256、块大小 512 KiB、块数），每块单独一条信封：端到端加密、发件设备签名、编号（消息 ID + 文件序号、块序号、总块数、整文件 SHA-256），明文里是原始字节（不再 base64），封好约 700 KB。收件方暂存在 `~/.morse/incoming-chunks/`（0700/0600，上限 1 GiB `morse.maxStagingBytes`，24 小时没进展清理），乱序、重复都行；收齐后逐个文件校验 SHA-256，对上才移进 inbox-files、**这条消息才入库**（正文和附件一起出现），对不上就让发件方重发那个文件。确认按块：发清单 → 收件方回已有的块（续传从这开始）→ 只发缺的；收件方每 8 块 / 300 ms 回一次累计确认，最后回普通回执（`chunked: true`）。发件方最多 24 块在途，15 秒没确认就重新问状态、补发缺的；连续 3 轮没进展就停下、留在驿站，下次重试接着发（收件方的暂存就是进度，发件方不用记）。传输在后台跑，驿站里显示 `waiting: sending … x/y chunks confirmed`，传完立即标记送达。限速：分块共用一个令牌桶，用中转速率的 5/6（100/分钟），中转回 `rate limited` 就等 2 秒重发；收件方「每人每分钟 30 条」只算清单（续传不算），块不按条计。请求区不收块：只记附件名和大小，主人同意后发件方把这些文件作为一条新消息重发。局域网同样分块（块是 JSON + base64，HTTP 应答就是确认），中途失败换中转接着发。`morse inbox` 收齐前显示 `receiving x/y chunks`，每条消息下列出附件名、大小、路径；`morse send --file` 显示 `sending: x/y chunks confirmed`。旧版收件方只会收到正文：发件方识别出来，标失败并提示对方升级。 |
| 局域网优先（ADR-034） | 查到 `<人>/<agent>` 的唯一设备后，如果它**已配对且在局域网上被发现**（mDNS / `--peer`），先走原有双向 TLS peer API（`POST /api/peer/morse`，同一份明文消息，两端证书指纹钉住），对方入库的 HTTP 应答就是回执；失败（未配对 / 旧版本 404 / 连不上 / 5s 超时）回落中转。peer 档也可以走局域网，信任档不变。中转不通时，之前查到过的地址仍可走局域网。日志：`morse: <id> → morse.im/mei/air delivered via lan (direct mutual TLS, owner)`、`… lan failed (…) — falling back to relay`、`… delivered via relay (…)`；收件方入库 `via` 为 `morse-lan` / `morse-relay`。 |
| 断线重连 | 客户端 1s→30s 指数退避自动重连；期间发的消息在驿站里等。relay 重启不丢任何东西，因为它本来就什么都不存。 |

### 代码位置

- `relay-cf/`：Cloudflare Worker（`src/worker.ts` 路由 + 管理接口、`src/hub.ts` DeviceHub DO、`src/allowlist.ts` 白名单 / handle 索引、`src/invites.ts` 邀请逻辑（与运行时无关，测试在 Node 里跑）、`src/invite-book.ts` InviteBook DO、`src/crypto.ts` 纯 WebCrypto 的证书指纹 / Ed25519 验签、`src/protocol.ts` 协议常量与校验、`wrangler.toml`）。部署见 DEPLOY-CLOUDFLARE.md。
- `site/`：morse.im 安装站（单独的纯静态 Worker）：`index.html`、`install.sh`、`_headers`、`wrangler.toml`；`npm run site:build`（`scripts/build-site.mjs`）生成 `site/public/`（含 `morse.tgz`）。
- `src/cluster/join.ts`：`morse join`（不带参数注册 / 配对码 / 邀请码，`planJoin` 判断走哪条；签名、成员探测、写配置）、`morse device add` 的配对码请求、`morse name set` 的昵称请求，和 `morse invite create/list/revoke`（管理员）；`src/cluster/nicknames.ts`：昵称缓存与「昵称 (地址)」显示；`src/cluster/blocklist.ts`：拉黑名单。
- `relay-cf/src/register.ts`（ADR-036，与运行时无关，Node 里测）：随机地址、配对码、每 IP 限额、保留名、管理员释放；跑在 `InviteBook` DO 里。
- 自建 Node 版中转（原 `relay/`）已删除（2026-11-14，ADR-076）：它没有跟到 v3 协议。`relay-cf/` 是唯一维护的中转；自建 = 把 `relay-cf/` 部署到你自己的 Cloudflare 账号（DEPLOY-CLOUDFLARE.md）；`npm test` 里的进程内中转是 `test/helpers/fake-relay.ts`（ADR-058）。
- `src/cluster/relay-client.ts`：daemon 的 WS 长连、登录、重连、`sent/offline`、目录查询。
- `src/home.ts`（`dataDir()`：`~/.morse`，未搬家时用 `~/.anytoany`）、`src/migrate-home.ts`（搬家，ADR-035）。
- `src/cluster/chunks.ts`（ADR-038）：块的编解码、清单检查、收件方暂存（`createIncomingStore`：乱序 / 重复 / 校验 / 续传 / 限额 / 清理）、发件方传输循环（`OutboundTransfer`：窗口、重传、续传）、令牌桶；`morse.ts` 把它接到中转和局域网上。
- `src/cluster/morse.ts`：地址解析（`parseMorseAddress`）、查 Agent 目录找唯一设备、加密发送、等回执、`waiting` 判定、发给本机自己的 Agent 直接落本机；收件验签解密、agent 名解析、回执；`lookupHandle` 供配对用。
- `src/cluster/agents.ts`：`morse agent …` 的签名请求、默认 Agent 名推导、本机缓存（`relay.agent` / `relay.agents`）；`relay-cf/src/agents.ts`（与运行时无关的目录逻辑，Node 里测）+ `relay-cf/src/agent-book.ts`（`AgentBook` DO）。
- `src/mailbox/mailbox.ts`：`waiting` 列与重试/到期规则；`src/daemon/dispatcher.ts`：relay 回 `waiting` 时标记为等待。
- `src/cluster/pair-commands.ts`：`morse pair add morse.im/<人>`；`src/daemon/server.ts`：`/api/send` 识别人名地址。
- `scripts/morse-e2e-files.sh`（ADR-038：经中转 1 / 10 / 50 MB、收件方中途被杀再启动续传、局域网 10 MB）、`scripts/morse-e2e-register.sh`（ADR-036：上一版中转写数据再换新版、开放注册、配对码、昵称、限额、释放）、`scripts/morse-e2e-cf.sh`（Cloudflare 本地 `wrangler dev`）、`scripts/morse-e2e-join.sh`（邀请加入 + 安装站 + install.sh）、`scripts/morse-e2e-agents.sh`（一个 Agent 一个地址，ADR-033）：单机验收脚本。

### relay 协议 v2（JSON over WebSocket）

```
relay  → {type:"challenge", nonce}
client → {type:"hello", cert, sig, bundle, passive?}   → {type:"welcome", id, handle, limits} | close 4001/4003
client → {type:"send", rid, to, blob}                   → {type:"sent", rid} | {type:"offline", rid} | {type:"error", rid, error}
client → {type:"bundle", rid, id}                       → {type:"bundle", rid, bundle|null}
client → {type:"handle", rid, handle}                   → {type:"handle", rid, handle, devices:[{id, name, bundle|null}]}
client → {type:"agent", rid, handle, agent?}            → {type:"agent", rid, handle, agent|null, device:{id, name, bundle|null}|null}   （ADR-033；不带 agent = 默认 Agent）
relay  → {type:"deliver", id, from, fromHandle?, blob, ts}   （转发即忘，没有 ack；fromHandle 供收件方自动回加）
GET /healthz → {"ok":true,"limits":{…}}
POST /v1/join {code, cert, ts, sig, name?, agent?} → 200 {id, handle, name, already?, agent?} | 400/401/404/409   （仅 Cloudflare 版）
POST /v1/join {handle, code:<配对码>, cert, ts, sig, name?, agent?}   （ADR-036：用配对码加入已有地址）
POST /v1/register {cert, ts, sig, name?, agent?} → 200 {id, handle, …} | 403 registration_closed | 429 rate_limited   （ADR-036）
POST /v1/pair-code {cert, ts, sig} → 200 {handle, code, expiresAt}   ·   POST /v1/profile {nickname, cert, ts, sig} → 200 {handle, nickname}
relay → {type:"nickname", handle, nickname|null}   （本人另一台电脑改了昵称）；welcome / handle / agent 回复带 nickname
POST /v1/agents {op, agent?, to?, cert, ts, sig}   op = add|remove|default|rename|list → 200 | 400/401/403/404/409   （两种 relay 都有）
POST|GET /admin/invites · DELETE /admin/invites/<id> · GET /admin/agents/<人> · DELETE /admin/agents/<人>/<agent> · GET|DELETE /admin/handles/<人>   （ADMIN_KEY）
```

## 2. 部署与自建

- Cloudflare：DEPLOY-CLOUDFLARE.md（wrangler 部署、绑 `relay.morse.im` 和 `relay.morse.talk`、邀请码、安装站、费用；morse.im 第一次上线的顺序见 §14）。中转 2026-10-20 已部署在 relay.morse.talk；relay.morse.im 等 morse.im 的 zone 生效后再绑（ADR-040）。
- 自建：把 `relay-cf/` 部署到你自己的 Cloudflare 账号（同一份 DEPLOY-CLOUDFLARE.md），客户端用 `morse relay set <地址>` 指过去。Node 版自建中转（`relay/`）已删除（ADR-076）。
- 不配 relay：`morse` 照旧只在局域网里用，所有 Morse 功能里只有跨网那一段用不了。

## 3. 新电脑安装与配对

普通用户看 [QUICKSTART.md](QUICKSTART.md)。一句话：

```bash
curl -fsSL https://morse.im/install.sh | bash                                         # 新地址 morse.im/<随机>
curl -fsSL https://morse.im/install.sh | bash -s -- <你的地址> --code <配对码>        # 你的第二台电脑（码来自 morse device add）
curl -fsSL https://morse.im/install.sh | bash -s -- <邀请码>                          # 管理员发的可读名字
```

它检查 Node ≥ 20、从 morse.im 下载 `morse.tgz` 并 `npm install -g`、`morse setup`、加入（不带参数且本机未加入 → `morse join` 拿随机地址；已加入 → 只升级；`--no-join` 只装不加入；`--agent <名>` 指定这台电脑的 Agent 名，默认取电脑短名），再把 daemon 设成开机自启（macOS launchd `talk.morse.daemon`，Linux `systemd --user` 的 `morse.service`；升级时卸掉旧的 `dev.anytoany.daemon` / `anytoany.service`，并把 `~/.anytoany` 搬到 `~/.morse`（ADR-035）；Windows 用 WSL2）。可读名字作为参数会在安装任何东西之前被拒绝并提示。从源码装：`npm install && npm run build && npm link && morse setup && morse join && morse start`。

**自动更新**（ADR-039）：install.sh 下载后先用站点构建时注入的公钥验 `version.json.sig`、核对 tgz 的 SHA-256。装好后 daemon 启动 1～10 分钟后、之后每 6 小时查一次站点（`MORSE_SITE` > `update.site` > `https://morse.im`）：签名对得上钉在客户端里的公钥（`src/update/release-key.ts`）、包的 SHA-256 对得上、发版号严格更大，才用同一个 node / npm `npm install -g` 到同一个前缀，再经 launchd `kickstart -k` / systemd `restart` 重启（不在服务管理器下就只记「restart to apply」），重启后跑一次 `morse setup`。正在传文件时推迟；失败退避、不影响 daemon。`morse update`（立即）/ `morse update --check`（只看）；`morse status` 显示版本、发版号和上次检查；`"update": {"auto": false}` 关掉。签名私钥只在发版机钥匙串，发版步骤见 DEPLOY-CLOUDFLARE.md §13。**换钥**（ADR-041）：`npm run release:rotate-key` 用旧私钥签一份换钥声明（新公钥 + 代数），追加到站点的 `/keys/rotations.json`，并把新公钥 / 代数钉进源码；客户端发现发版不是它信任的钥匙签的，就取这条链、从自己信任的那一代逐环验证到链尾，再用最新钥匙验发版，通过才装、并把新钥记进 `~/.morse/release-key.json`（原子写、只升不降）；链外的钥匙、退役的旧钥一律拒绝，落后几代一次走完。重跑 install.sh 会清掉这个文件、以新构建钉的钥匙为准。开发版（git 克隆，没有 `dist/release.json`）不自动更新。

### 配对：别人（按 handle，peer）

```bash
morse pair add morse.im/kai        # 对方全部设备一次配好，tier peer
morse peers                               # 看 relay 状态、自己的 handle、已配对的人
morse pair remove kai                # 解除这个人的全部设备
```

**通常不用手动配对**：第一次 `morse send morse.im/<人>` 自动配好；对方那边你的第一条消息进他的**请求区**，他 `morse requests accept` 同意后才算加上（ADR-037）。各自只信任自己名单里的人；relay 白名单只决定谁能连 relay。

```bash
morse requests                             # 请求区：昵称 (地址)、设备、首条消息预览、时间
morse requests accept morse.im/<人>       # 同意：配成 peer，请求移进收件箱
morse requests decline morse.im/<人>      # 拒绝：删请求并拉黑
```

### 自己的另一台设备

直接发：`morse send morse.im/<你>/<另一台的 Agent>`（ADR-033），第一次会按 handle 把你自己的其他设备配成 **owner**（ADR-034：同一个 handle 下的设备就是你用自己的邀请码加进来的），对方收到时也把你配回 owner；消息带主人授权（ADR-016）。两台在同一个局域网里时直接走局域网，不经过中转。以前配成 peer 的，daemon 重启（或下一次互相发信）后自动升级。不想要：`morse pair remove <你的 handle>`（同时拉黑，不会再被自动配回）。

### 收发

```bash
morse send morse.im/kai "你好，帮我看看这个接口"        # 发给他的默认 Agent
morse send morse.im/kai/air "日志在附件" --file ./error.log   # 发给他的 air（只到那台电脑）
morse send kai/air "简写也行"

# 对方 Agent 查收
morse inbox                       # 一行一条，peer 消息下面有 ⚠ 同伴消息标注
morse pull --inbox                # 发给这台电脑 Agent 的那些，取走即标记已读
morse pull --session "@claude:<会话ID>"   # 指名发给某个会话的那些
morse reply <消息ID> "收到，结论是……"     # 回信：回到写信的那个 Agent

# 发件方看状态
morse inbox --all                 # delivered ✓ receipt；对方不在线显示 failed (waiting: …)，会自动重试

# 我的 Agent 地址
morse agent list | add <名> | remove <名> | default <名> | rename <旧> <新>
```

要让 `morse.im/kai/helper` 指到某个具体会话：对方 `morse agent add helper`（登记地址），再 `morse register --agent helper --session <会话ID>`（本机把这个名字指到会话）；不登记会话就落在 `helper/inbox`。

## 4. 验收记录（2026-10-20，本机，未部署）

- `npm test`：462 → 480 个用例全过（新增：等待型驿站、调度器 `waiting`、地址解析、按 handle 配对、两设备扇出、agent 级路由、Cloudflare 版 WebCrypto 验签与 Node 实现逐字节一致）。
- `scripts/morse-e2e-cf.sh`（本机 `wrangler dev`，隔离 `XDG_CONFIG_HOME`，不读真实 wrangler 登录）：
  f. `morse pair add morse.im/bob` 把 bob 的两台设备（一台从未上线）都配成 peer；`morse peers` 显示 `you are morse.im/alice`；
  a. `morse send morse.im/bob` 落到 bob 的 `user/inbox`，alice 拿到回执；`morse.im/bob/testbot` 落到 bob 用 `morse register` 登记的 testbot 会话；
  b. 停掉 bob 后发信：alice 驿站显示 `failed (waiting: @bob is offline …)`，每 3s 重试；bob 重启后自动送达并有回执；
  d. 翻遍 `wrangler dev` 的持久化目录（KV、DO 的 SQLite）：没有明文、没有密文信封（`"ct":`），DO 存储里只有 `bundle` 一个键；
  c. 不在白名单的设备被拒（客户端 `device not on the relay allowlist`，Worker 日志 `REJECTED … not on the allowlist`）；
  g. 杀掉并重启 Worker，两个 daemon 自动重连，之后发信正常；
  附件 500 KB 送达、SHA-256 一致、0600；`morse pull` 带同伴消息标注；bob `morse reply` 回到 alice。
- `scripts/morse-e2e.sh`（Node relay）：同样的检查，relay 库只有 `bundles` 表；1 MB 附件送达。（当时的记录；这个脚本和 Node 版中转已在 2026-11-14 删除，ADR-076。）
- 第三版（ADR-032）：`npm test` 491 个全过；`scripts/morse-e2e-join.sh`（中转 + 站点两个 `wrangler dev`、临时 HOME）：管理员发 6 张邀请（错误 / 缺失的管理密钥被拒）→ alice、bob 各 `morse join` → 配对 → 互发、双方都有回执；重复 join 不扣次数；用过的、过期的（2s TTL）、作废的邀请被拒；carol 零配对首次发信给 alice，alice 自动回加、carol 拿到回执；中转状态里没有明文邀请码；`install.sh` 从本地站点下载 `morse.tgz` 装进临时 npm 前缀、`morse setup` + `morse join`，launchd plist 只打印（`plutil -lint` 通过）。原有两个 e2e 脚本照旧全过。

- 第四版（ADR-033，一个 Agent 一个地址）：`npm test` 506 个全过（新增 `test/morse-agents.test.ts` 12 个：名字规则、默认名推导、目录逻辑——唯一、默认、改名原子与默认跟随、接管、按设备清理——Node 签 / WebCrypto 验、带 Agent 的 join 名字被占不扣邀请、客户端 `agent` 各操作、三台设备一人的寻址 / 改名 / 本机自投；`morse-relay.test.ts` 改为不扇出）。`scripts/morse-e2e-agents.sh`（中转 + 站点两个 `wrangler dev`、临时 HOME）：mei 三台（mini / air / pro，pro 的名字由设备名 `Meis-MacBook-Pro` 推导）、bob 一台；bob → `mei/air` 只有 air 收到、bob → `mei` 只有默认的 mini 收到、mini → `mei/pro` 只有 pro 收到；air 离线时发给 air，bob 驿站 waiting，air 回来后收到，mini / pro 始终没收到；重名在 join（邀请未扣）和 `agent add`、`agent rename` 时都被拒；`agent add pro-codex` 后立即可达、`morse pull --inbox` 带同伴标注取出；`agent rename air macbook-air` 后新地址立即可达、旧地址 `failed (no agent …)`，`rename mini mac-mini` 后默认跟着改；中转状态里没有消息；`install.sh --agent dave-laptop` 从本地站点装进临时 HOME / npm 前缀并 join，launchd 只打印，装好的 `morse --help` / `morse send` / `morse inbox` 可用。`morse-e2e-cf.sh`、`morse-e2e.sh`、`morse-e2e-join.sh` 按新地址模型调整后照旧全过。

- 第五版（ADR-034，2026-10-21，本机，未部署）：`npm test` 516 个全过（新增 `test/morse-lan.test.ts` 10 个：同 handle → owner、别人 → peer、owner 不降级；首次联系两边都配成 owner；旧 peer 在登录时升级、只升级不新增；收件方按 `fromHandle` + 目录升级；`pair add` 自己的 handle → owner；局域网投递 `via lan`、去重、坏请求 400；局域网失败回落中转；不在局域网走中转；peer 走局域网档位不变；中转断开时已查到的地址走局域网）。`scripts/morse-e2e-lan.sh`（中转 `wrangler dev`、临时 HOME、真 mDNS、设备名 `e2e-lan-*`）：mei 的 mini、air 互为 owner；第二条起 mini → `mei/air` 日志 `delivered via lan (direct mutual TLS, owner)`、air 入库 `via morse-lan`、没有同伴标注，air → mini 同样走局域网；bob 与 mei 双向 peer，bob 的第二条也走局域网、仍带同伴标注；air 改成 `--no-lan` 重启后 mini 再发 `delivered via relay`；结束时所有测试进程和端口都已清空。`morse-e2e-agents.sh`、`morse-e2e-cf.sh`、`morse-e2e.sh`、`morse-e2e-join.sh` 照旧全过（前两个脚本里的技能路径随 fd04da5 改成 `skills/morse`）。
- 数据目录改名（ADR-035，2026-10-21，本机，未部署）：`npm test` 521 个全过（新增 `test/migrate-home.test.ts` 5 个：`MORSE_HOME` 优先；搬家后设备 ID、收件箱、信任名单不变、旧路径是指向 `.morse` 的链接、幂等；空的 `~/.morse` 不碍事、有内容则不动并继续用旧目录；建不了链接就整体搬回；daemon 在跑时启动路径不动、setup 先停再搬）。`scripts/morse-e2e-migrate.sh`：用上一版（`7cb083a`，仍写 `~/.anytoany`）在临时 HOME 里造出旧布局（身份 + 5 条消息）→ 新版 daemon 首次启动即搬走，设备 ID、消息条数不变，`~/.anytoany -> .morse`，再启动无动作；旧版 daemon 在跑时 `morse setup` 先停掉它再搬；两个目录都有内容时拒绝并说明原因、继续用旧目录；本地静态站点 + 临时 npm 前缀跑 `install.sh --dry-run-service` 升级：打印卸载旧 `dev.anytoany.daemon`（删旧 plist）、写入并装载 `talk.morse.daemon`、日志 `~/.morse/daemon.log`，其中的 `morse setup` 已完成搬家且 ID 不变。其余五个 e2e 脚本改用 `~/.morse` 后全过。

- 第六版（ADR-036，开放注册，2026-10-21，本机，未部署）：`npm test` 542 个全过（新增 `test/morse-register.test.ts` 20 个：随机地址字符集与均匀性、新设备拿随机地址并成为第一台设备、两个新用户不同、重复注册不新建、抽到被占 / KV 已有 / 保留 / 已释放的名字一律重抽、串行化下 12 个并发注册首抽全撞同一个名字只有一个拿到、每 IP 限额与窗口重置、关闭注册 / 坏签名 / 时钟 / 坏 Agent 名；配对码一次性、只存哈希、过期、错 handle、无码不能加入已有地址、5 次猜错作废、新码替换旧码、非成员拿不到、签名请求不可重放、别的 handle 的设备 409 且码不消耗、Agent 名被占码不消耗、5 台设备抢一个码只成功一台；旧格式邀请经新分发仍可用并登记认领、保留名邀请被拒；**上一版写的 KV 白名单 / AgentBook / InviteBook 数据在新逻辑下照常可用**；昵称规范化客户端与中转一致、设 / 改 / 清；管理员释放；客户端 `planJoin`、注册 → 发码 → 配对加入 → 设昵称、旧中转没有注册接口时的报错、昵称缓存；`morse-relay.test.ts` 新增 1 个：收件方按「昵称 (地址/agent)」显示，换昵称后跟着变）。`scripts/morse-e2e-register.sh`（`wrangler dev`、隔离 `XDG_CONFIG_HOME`、临时 HOME、设备名 `e2e-*`）：先用上一版 `099c043` 的中转和客户端写入真实数据（mei 的 3 次邀请、mini / air 两台带 Agent 加入），换新版中转后同一份状态：旧设备登录、Agent 目录和默认不变、旧邀请剩下的一次仍能加入第三台；`install.sh` 不带参数 → alice 拿到 8 位随机地址并被告知 `Your address: … — send it to your friends`（launchd 只打印）；bob `morse join` 拿到不同地址；无码 / 错码加入 alice 的地址被拒、bob 的电脑不能再加入别的地址、`morse join alice` 和 `install.sh carol` 都被拒并提示可读名字暂未开放（not open yet — ask the admin）（install.sh 在下载之前就拒绝）；alice `morse device add` → 第二台 `install.sh <地址> --code <码>` 加入，码再用被拒，`morse device list` 两台；alice 设昵称，bob `pair add` 和收件箱都显示「Alice 爱丽丝 (地址…)」，第二台改昵称后第一台被推送更新、bob 看到新昵称；alice ⇄ bob、alice → 自己第二台（owner，无同伴标注）、bob ⇄ mei（旧设备）全部有回执；`admin` / `support` 邀请被拒；限额 5 时第 6 个新地址 429；管理员释放后该地址查不到；中转状态里没有明文配对码。`morse-e2e-join.sh`（install.sh 结尾文案改为 `Your address: …` 后）、`morse-e2e-agents.sh`、`morse-e2e-cf.sh`、`morse-e2e.sh`、`morse-e2e-migrate.sh`（install.sh 升级改用 `--no-join`，避免不带参数时去线上中转注册）全过；`morse-e2e-lan.sh` 本轮未跑（要在真实局域网上广播 mDNS，本机有在用的真实 daemon；本轮没有改局域网代码）。

- 第七版（ADR-037，陌生人消息请求，2026-10-21，本机，未部署）：`npm test` 567 个全过（新增 `test/morse-requests.test.ts` 16 个：请求表每人只留第一条、重试算重复、其余丢弃并计数、上限丢最旧、正文截断；`strangers` 三种取值和旧 `autoPairBack:false` → block；限速默认值、配置、滑动窗口；经中转：陌生人 3 条 → 请求 1 条、收件箱 / pull / 调度器都没有、未配对、昵称未记，发件方第 1 条 `request pending`、后两条留着；同意 → 进收件箱带同伴标注、对方收到通知、留着的送达、双向收发、迟到的重发不重复入库；通知丢了靠探测自愈；旧客户端式连发只留一条、`dropped` 不算回执；拒绝 → 拉黑、之后丢弃、`pair add` 撤销；主动 `pairHandle` / `pair add` 等于同意；`accept` / `block` 模式、已同意的人在 block 下照常；自己的设备和已配对的人不受影响、但没配对过的另一台照样是请求；请求区上限；每人 / 总量限速丢弃且不回执。`test/morse-lan.test.ts` 新增 2 个：局域网首联是请求（202）、不配对、留着的同意后走局域网送达；局域网上一人一条（`dropped` = 留着）、拒绝后局域网拒收、中转丢弃。另有 `mailbox`、`dispatcher` 各 1 个）。`scripts/morse-e2e-requests.sh`（`wrangler dev`、隔离 `XDG_CONFIG_HOME`、临时 HOME、设备名 `e2e-req-*`），经中转（`--no-lan`）和经局域网（真 mDNS）各一遍：bob 给 alice 发 3 条 → alice 请求区 1 条（`via morse-relay` / `morse-lan`）、收件箱 0 条、`morse pull --inbox` 没有、`morse inbox` 末尾提示 1 个请求、`morse requests` 显示「Bob (地址/b1) device e2e-req-…」和预览；bob 那边第 1 条 `request pending`、后两条 `waiting for … to accept`，等两轮重试后 alice 那边仍是 1 条；alice `morse requests accept` → 那条进收件箱，bob 收到通知，留着的 2 条送达，bob 再发正常送达（同一路径），alice 回信 bob 收到；carol 被 `decline` 后再发（她那边留着，重启后探测）→ alice 日志丢弃、请求区 0、收件箱没有。原有 8 个 e2e 脚本全过：`morse-e2e-join.sh`（第 6 步改为 carol 的首信进请求区、alice 同意后进收件箱）、`morse-e2e-register.sh`（bob → mei 先进请求区、同意后到）按新语义改预期；`morse-e2e-agents.sh`、`morse-e2e-lan.sh`、`morse-e2e-lan-first.sh` 不是测请求的，配置里设 `strangers: accept` 跑旧行为；`morse-e2e-cf.sh`、`morse-e2e.sh`、`morse-e2e-migrate.sh`（清理时只在临时 HOME 有 pid 文件才 `morse stop`，免得回退到 pgrep 碰到真实 daemon）不变。

- 第八版（ADR-038，大文件分块，2026-10-21，本机，未部署）：`npm test` 589 个全过（新增 `test/morse-chunks.test.ts` 22 个：块编解码与区间、512 KiB 块封好后 < 720 KB；清单检查、发送时超限报错（单个 / 合计）；暂存乱序 + 重复、SHA-256 校验、0600/0700、校验失败只清那个文件、重启后续传、限额「忙」、24 小时清理；发件循环丢块只补丢的、最终答复（请求 / 旧版本 / 拒收 / 忙 / 离线）、令牌桶（假时钟）；经 Node 中转：3 MB 收齐前收件箱为空、收齐后一条消息正文 + 附件、迟到的整条重发不重复入库；中转丢块 + 收件方中途重启续传；发件方中途重启只发剩下的；中转回 `rate limited` + 收件方每人 2 条/分钟仍完成；收件方上限拒收 → 发件方直接失败；小附件仍整条；经真实调度器 waiting → 传完立即 delivered；请求区不收块、只记名字和大小、陌生人的块被丢弃，同意后补发文件；`dropped` 留着、同意后送达；局域网分块直传、未配对设备的块 403）。`scripts/morse-e2e-files.sh`（`wrangler dev`，独立 HOME / XDG_CONFIG_HOME，临时 HOME，按记录的 pid 停进程）：经中转（`--no-lan`）1 MB 1.1 s、10 MB 1.1 s、50 MB 11.4 s（发出到收件方回执；50 MB 的后半段被每设备限速节流），SHA-256 一致、0600、每个文件一条消息；30 MB 传到 15/60 块时 `kill -9` 收件方 daemon，发件方记 `offline`、按驿站间隔重试，收件方重启后从 15 块续传（收件方只有一条 `receiving`、发件方总共发了 60 个块信封），37 s 完成、一致；局域网（真 mDNS，设备名 `e2e-files-*`）10 MB 1.2 s、`delivered: 20/20 chunks via lan`、一致；结束后没有残留进程和监听端口。原有 9 个 e2e 脚本（`morse-e2e.sh`、`-cf`、`-join`、`-register`、`-agents`、`-lan`、`-lan-first`、`-migrate`、`-requests`）不改动、全过。
- 第十一版（ADR-041，发版签名钥匙轮换，2026-10-26，本机，未部署）：钉上正式公钥 `kkI8CejF5tT4QHAeEPQ2PVR2uYf91hDeXSChdh1FcoI=`（第 0 代，key id `b2693f9e0e38d931`）。`npm test` 680 个（新增 `test/rotation.test.ts` 26 个：单次 / 两代换钥、断开的环、签名者错、不从信任钥匙开始的链、代数重复 / 递减 / 跳号、换回旧钥、篡改新公钥、乱格式；信任文件原子写、重启后仍在、不降代、坏文件忽略；拉站点时跟随并保存、链外 / 链中间 / 退役钥匙签的拒绝且不写；换钥脚本测试模式）。`scripts/morse-e2e-update.sh` 新增第 7～10 步全过：钉 A 的 daemon 跟随 A→B 自己装上 400、链外 C 签的 500 和退役 A 签的 700 被拒、换到 C 后装上 600、另一台停在 A 的客户端一次走 A→B→C。全程一次性钥匙，不碰钥匙串和真 HOME。
- 第九版（ADR-039，客户端自动更新，2026-10-21，本机，未部署、未建正式签名钥匙）：`npm test` 625 个全过（新增 `test/update.test.ts` 36 个：钉死公钥验签通过 / 别的钥匙签的 / 签后改一个字节 / 空和乱码签名 / 降级和同版重放 / 签了名但字段不合法（包名、带路径的文件名、sha256、大小、版本号）/ 占位符公钥一律拒绝；包的大小和 SHA-256；PEM / PKCS#8 base64 / 32 字节种子三种私钥格式；拉取站点：有新版、同版、旧版被忽略、错签名、缺签名文件、网络错误；被换的包不安装、下载后开始传文件就推迟、npm 失败；传文件判定（发送中算、驿站等待不算、5 分钟没进展的接收不算）；首查 1～10 分钟、6 小时间隔、15 分钟起翻倍退避封顶 6 小时、推迟和关闭 10 分钟后再看、环境变量测试时序；更新器：关闭时不联网、装好后重启或提示、推迟时不下载、连续失败计数和恢复清零、检查抛错 / 安装失败 / 重启失败都不崩、按结果重新排期；launchd / systemd 只在服务记录的 pid 就是本进程时才重启；npm 前缀（经符号链接）、同一 node 的 npm、`dist/release.json`、站点优先级、状态文件）。`scripts/morse-e2e-update.sh`（一次性测试钥匙、本地 http.server 当站点、临时 HOME + 临时 npm 前缀）全过：install.sh 拒绝被换的包、装上 100 并记下 `update.site`；`morse update` 拒绝错钥匙 / 被换的包、忽略 50；daemon 自己检查同样拒绝，`update.auto: false` 时不装，打开后自己装上 200（同一前缀、同一 node，不在 launchd 下提示重启），重启后运行 200 并跑了一次 `morse setup`；`site:build` 拒绝把测试构建写进 `site/public`、拒绝用和钉的公钥不符的钥匙签。其余十个 e2e（`morse-e2e`、`-cf`、`-join`、`-agents`、`-register`、`-migrate`、`-requests`、`-files`、`-lan`、`-lan-first`）照旧全过（用到站点的四个改用一次性测试钥匙、构建到各自临时目录）。真 daemon（launchd `talk.morse.daemon`）全程未被重启。

## 5. 已知限制

- **同一 handle = owner 信任中转**（ADR-034）：中转管理员、泄露的邀请码或泄露的配对码（10 分钟内）能把一台设备挂到你的 handle 下，它就得到 owner 档（带主人授权）。中转由本人运营，接受；要零信任就按设备 ID 配对、`morse pair remove <自己的 handle>`。
- **局域网直连不再额外端到端加密一层**：双向 TLS 1.3 本身就是两台设备之间的端到端加密；中转不通时用进程内缓存的 Agent 位置，期间改名 / 搬家不会被发现。

- **不做门铃**：消息到了对方驿站后，要对方 Agent 主动 `morse inbox` / `morse pull`（或下一次用户开口时 prompt hook 注入）。peer 消息永远不会自动续接会话。发到总收件箱（`user/inbox`）的消息只在 `morse inbox` 和控制台里，不会注入任何会话。
- **按 handle 配对信任 relay 的目录**：relay 管理员能把一台设备挂到别人的 handle 下。本项目三个人互相认识，接受；要零信任就按设备 ID 配对。
- **一个地址只在一台设备上**（ADR-033）：托管它的电脑不在线，消息就在发件方驿站等；不会改投这个人的其他电脑。想「哪台在线哪台收」得自己换地址发。
- **Agent 目录信任中转**：中转说 `<人>/<agent>` 在哪台设备就发到哪台（设备仍须属于这个人、公钥按设备 ID 校验）。
- **签名请求可在 ±10 分钟内被原样重放**：效果是同一个 add / remove / rename 再做一次，没有越权。
- **默认 Agent 名从设备名推导**，可能不好看；`--agent` 或 `morse agent rename` 改。电脑抹掉重装（新身份）后旧名字仍被旧设备占着，要管理员移除旧设备（Agent 一起释放）或 `DELETE /admin/agents/<人>/<agent>`。
- **npm 包名仍是 `anytoany`**：命令已叫 `morse`（`anyd` 兼容），投递给 Agent 的信封和协作提示里仍写 `anyd reply …`（两个命令都装着，都能用）。
- **开放注册 = 任何人都能给你发一条请求**（ADR-036 / 037）：陌生人每人只占一条请求、请求区封顶 200、收件限速；但地址免费，换地址就能再发一条，200 条可能被刷满挤掉正常请求。不想要就设 `morse.strangers: "block"`；那时对方没配对你，你的消息会被对方丢弃且没有回执，一直 `waiting` 到 30 天上限（日志里 `strangers are blocked`）。
- **请求按收件设备算**（ADR-037）：一个人有几台电脑，就各自有请求区和名单；在 mini 上同意了，air 那边还是请求（发件方也按设备分别留着）。
- **旧版发件方**（ADR-037 之前的客户端）不认识 `request` 回执：第一条显示为已送达；同意之前它接着发的会被对方丢弃、它也当成已送达（新版发件方会留着，同意后补发）。真实设备都要升级。
- **被拒绝的发件方不知道**：拒绝 = 拉黑、静默丢弃，对方那边的消息一直 `waiting`（每 10 分钟探测一次，30 天到期）。
- **邀请码 / 配对码就是授权**：拿到码的人可以把自己的设备加进那个 handle。邀请码只显示一次、默认一次 / 7 天，泄露了 `morse invite revoke <id>`；配对码一次性、10 分钟、5 次猜错作废；已经加进去的设备用 `/admin/allowlist` 删。
- **没有账号，丢了全部电脑无法自助找回**（ADR-036）：管理员 `DELETE /admin/handles/<地址>` 释放，用户重新安装拿新地址。
- **每 IP 限额**：同一个 NAT 后的人共享每小时 20 个新地址；挡不住大量 IP 的批量注册（可关 `OPEN_REGISTRATION`）。
- **昵称不唯一**：只用于显示，永远和地址一起显示；对方查到的是中转上最新的，收件方缓存的是最后一次见到的。
- **大文件**（ADR-038）：单个文件 / 一条消息默认 ≤ 100 MB（可调 `morse.maxFileBytes`）；经中转按 100 块/分钟（每块 512 KiB ≈ 50 MB/分钟）节流，100 MB 约 1～3 分钟；收发两边都要新版（旧版收件方只收到正文，发件方会标失败提示升级）；收件方未完成的暂存是明文（0600，24 小时没进展删除）；发件方 `outbox-files` 里的副本送达后不自动删；中转能看到「这两台设备在传多大的东西」（条数和每条大小）。跨网直传（iroh）和 R2 临时加密存储记在 ADR-038，暂不做。
- **自动更新**（ADR-039）：只防「站点被攻破」，不防发版机被攻破（能读钥匙串就能签）、npm 依赖投毒（依赖仍从注册表解析）、冻结（一直给旧清单，客户端停在当前版本，但不会降级）；新版启动就崩不会自动回滚（服务管理器会一直重启，要手动重跑 install.sh）；ADR-039 之前装的电脑要手动升级最后一次。换钥（ADR-041）只在当前私钥没泄露时可靠：当前私钥被盗后小偷也能签换钥声明，客户端先到先得，只能让所有人手动重装；当前私钥丢失则换不了钥；没有不给继任者的「吊销」。
- **速率桶在内存里**：DO 被回收后重新计数。
- **元数据可见**：relay 能看到谁在什么时间给谁发了多大的信封（日志里只有设备 ID 前 7 位和字节数）；看不到内容。
- **无前向保密的长期加密密钥**、**信任靠本机文件权限**：同第一版。因为 relay 不再存密文，泄露长期密钥能解开的只有被抓包的流量。
- `relay-cf` 的 Worker 侧只有本机 `wrangler dev` 验证，线上账号、域名、费用口径以部署时为准。

## 6. 下一步建议

1. **部署**：按 DEPLOY-CLOUDFLARE.md 上线 `relay.morse.im`，写入三个人的 handle。
2. **打洞直连**：relay 现在只是转发，接 iroh / NAT 穿透后它自然退化成兜底。
3. **包名改 morse**：正式发布时把 npm 包名一起改掉，处理旧 `anytoany` 全局包的卸载。
4. **门铃**：在明确的 peer 策略下（只唤醒、不自动执行）接回原项目的门铃。
5. **密钥轮换与吊销**；**群组**（一个 handle 组）。附件分块已做（ADR-038）；跨网直传（iroh）、R2 临时加密存储见 ADR-038「暂不做」。
