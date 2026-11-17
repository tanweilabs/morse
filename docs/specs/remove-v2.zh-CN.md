# 删掉 v2（身份 v3 第 4 期）：清单与分期计划

> 创建：2026-11-16 · 最后更新：2026-11-16

> 状态：第 0 期（本文 + ADR-091）已写；**第 1、2 期已实现**（分支上，实现时定下的见 ADR-091 末尾两节）。分支 `feat/remove-v2`。第 1、2 期在同一条分支上做，做完停下等主人发版；第 3 期另开分支，等主人确认中转上已经没有 v2 登录。
> 接 [identity-v3 设计稿](identity-v3.zh-CN.md) §12.4、§12.5 的 P4 一行、§16；ADR-077 末尾和 ADR-081 末尾的「删 v2 之前还差什么」。

## 0. 为什么现在做、前提是什么

主人 2026-11-16 定：**现在就删 v2**（「我们都升级了」）。用户只有三个人（主人、饶同事、同事），几台电脑；主人已经让大家升到 20261116042458 或更新的版本，并告诉大家 `morse.im/mei` 这类旧名字以后不能用了。

这一版（20261116042458）的客户端都有：v3 连接、按地址收发（`addr1`，ADR-081）、每个本机地址各有联系人（ADR-083）。所以**每个还在用的对方都能按地址收信**，删 v2 时不需要等谁。

产品里只有两个名词：**地址**（我的）和**联系人**（别人的，包括我在别处的 Morse）。「Agent」不是产品里的东西。**权限按联系人给、由用户自己定**（主人定）。

## 1. v2 是什么（以代码为准）

| 部分 | 在哪里 | 第 1 期 | 第 2 期 | 第 3 期 |
|---|---|---|---|---|
| 按 handle 的身份：`morse.im/<handle>[/<agent>]`，8 位随机 handle、管理员邀请的可读名字 | `src/cluster/morse.ts` 的 `parseMorseAddress`、`target`、`pairHandle`；`src/commands/messaging.ts` 的 `resolveSendTarget` | 有地址的联系人一律按地址发，不再查 handle | 输入旧名字报一行错；不再查 handle | 删 |
| 中转的 handle 目录、白名单、邀请、注册、配对码、昵称、`AgentBook`（`/v1/register`、`/v1/join`、`/v1/pair-code`、`/v1/profile`、`/v1/agents`、`/admin/*`，WS 的 `handle` / `agent` / `bundle` 帧） | `relay-cf/src/register.ts`、`invites.ts`、`invite-book.ts`、`allowlist.ts`、`agents.ts`、`agent-book.ts`、`worker.ts`；客户端 `src/cluster/join.ts`、`agents.ts`（`agentRequest`） | 新装不注册 handle；`address add/remove` 不调 `/v1/agents` | 客户端一条都不调 | 中转删掉（`/v3/alias` 一起，见待定 Q5） |
| v2 连接 `/v1/ws/<设备 ID>`、`DeviceHub` | `src/cluster/relay-client.ts`（无 `v3` 选项时）、`relay-cf/src/hub.ts` | 只在已经有 `relay.handle` 的电脑上还开着（收没升级的人用 v1 信封发来的信）；v3 连接不再等它 | 不开 | 删 `DeviceHub`（迁移标签 `deleted_classes`） |
| 设备证书和信任档：`device_id`、`trusted-devices.json`、`peer-keys.json`，owner / peer 按设备 | `src/cluster/trust.ts`、`effective-trust.ts`、`identity.ts`（证书）、morse.ts 的 `recipientKey`、`trustHandleDevices`、`syncOwnDevices`、`autoPair` | 不再决定任何事：来信一律按签名的地址、一律 peer | 不读 | 删文件读写（文件本身留着不删，见第 4 节） |
| v1 信封（`seal` / `open`，设备证书签名、按设备 X25519 加密） | `src/cluster/e2e.ts` | 收：照收，按证书算出的地址归联系人；发：只发给还没有地址的联系人 | 不发；v2 连接没了，也就收不到 | 删 |
| v3 信封里的过渡字段 `cert`（P1 的「身份桥」） | `src/identity/envelope.ts`、morse.ts `deviceOfCert` | 收：带不带都按地址处理；回给带 `cert`、不带 `addr:1` 的旧式来信时仍带 `cert`（旧客户端只认这种回执） | 同第 1 期（这是「还收没升级的人的信」） | 删 |
| 局域网：mDNS `_anytoany._tcp` 广告设备名和设备 ID，双向 TLS 按信任名单，`/api/peer/morse`（明文）、`/api/peer/morse3`、`/api/peer/messages`、`/api/peer/sessions` | `src/cluster/lan.ts`、`peers.ts`、`peer-api.ts`、`secure-transport.ts` | **换成按地址的局域网**（第 3 节）；旧的这一套关掉 | 删旧代码 | — |
| WebRTC 直连按设备 ID、信令走 v2 连接、v1 信封封信令 | `src/cluster/direct.ts`、morse.ts 的 `startDirect` | **换成按地址**（信令走 v3 连接的 `signal` 帧，用 v3 原生信封封） | — | 中转删 v2 的 `signal` |
| `self` 分组：用旧办法配对的自己的电脑（`origin = own-device`，owner 档） | `src/mailbox/contacts.ts`（`ensureOwnDevice`、`isLowered`、`demoted:`）、`src/cluster/contact-split.ts` | **迁移成普通联系人，分组 `mine`，没有任何特殊权限**（第 2 节） | — | 删 `own-device` 相关代码 |
| 冻结的旧别名表、`alias` 查询、联系人拆分（联网段） | `relay-cf/src/aliases.ts`、`src/cluster/contact-split.ts` | 照旧（只用来给没地址的旧联系人补地址） | 客户端不再问 | 中转删 |
| 隐藏命令 `join`、`invite`、`pair`、`peers`、`device`、`relay`、`name`、`agent` | `src/cli.ts` 1210–1831 | `join` 不带参数 = 新建地址、不注册；其余照旧 | 删（`agent` 只剩被调用的话保留：见 ADR-091 第 11 条） | — |
| 消息行按 handle / Agent 记：`from_device` / `to_device` 里的 `lin/claude`、`me/air`，`claude → macmini` 的显示 | `src/mailbox/mailbox.ts`、cli.ts 的 `printMessage` | 迁移把还没发出的信改成写给地址；历史不改 | 显示时按联系人换成备注或地址，不再显示 `agent → agent` | — |

配置和文件：

| 东西 | 谁读写 | 第 1 期 | 第 2 期 | 第 3 期 |
|---|---|---|---|---|
| `config.json` 的 `relay.handle` | join.ts 写；cli、home-context、pair-commands 读 | 新装不写；有的照旧 | 不读（`morse address` 不再显示 old name） | — |
| `relay.agent` / `relay.agents` | agents.ts 写；`localAgents`、`agent-addresses.ts` 读 | 只当本机地址的目录名用（ADR-088 起它就只是内部名） | 同左 | 改名或留着（不影响用户） |
| `relay.url` | `relay set`、join 写 | 新装由 `morse address` 写成默认中转 | 同左 | — |
| `trusted-devices.json`、`peer-keys.json`、`morse-blocked.json` | 见上 | 迁移读进新表，文件不改 | 不读 | 删掉读写代码；文件留在磁盘上不删（备份里有） |
| `device-name` | device.ts | 局域网不再用 | 不读 | 删 |
| `identity/key.pem`、`cert.pem` | identity.ts | key 照旧是第一个地址的钥匙；cert 只给旧式回执用 | 同左 | cert 不再生成 |
| `identity/enc-key.pem` | e2e.ts | 只为收 v1 信封 | 不用 | 删 |

## 2. 迁移：`user_version` 4 → 5

纪律照 ADR-077 / ADR-083：一个 IMMEDIATE 事务，事务里再查一次版本；迁移的那个进程在事务里做**一份小备份**（只备份会改写的）；幂等；被 SIGKILL 就整体回滚、下次重来；同时打开的进程在锁上等，等到后发现已是 5、什么都不做；还在跑的旧进程对着新库要么照常、要么安全失败；备份写不成就一行报错、不迁移。

| 迁移前 | 迁移后 | 依据 |
|---|---|---|
| 有旧 handle、**已知地址**的联系人（`c:<handle>`、`c:<handle>/<agent>`，`address` 有值） | 按地址的联系人：`handle` 清空，旧写法记进新列 `old_name`（只显示、只给按旧名字写的权限设置当键）；ID、备注、分组、状态、历史都不变 | `address` 是 P2 联网段核对过的（证书算出来的） |
| 有旧 handle、`address` 为空，但地址能从本机验证过的东西推出来：`contact_addresses` 里记过的、按地址给我写过信的、或者信任名单里这个 handle 下的设备的证书已经钉在 `peer-keys.json`（设备钥匙算出的地址就是那台电脑的第一个地址） | 同上，地址写上 | 设计稿 §12.2 |
| 有旧 handle、地址推不出来 | **原样留着**，标成「需要他的新地址」（`morse contact` 里那一行写 `needs their new address`）；不删 | 主人要求 |
| `self` 分组里的联系人（迁移来的自己的电脑 `own-device`，以及手动放进 `self` 的） | 分组 `mine`，`origin` 清空；**没有任何特殊权限**：它们的信是普通联系人的信，权限用 `morse contact set` 给 | 主人定 |
| 按 handle 的拉黑（`morse-blocked.json` 里的 handle） | 这个 handle 已知的每个地址都在第一个地址上拉黑（`address_blocks`）；文件不改 | ADR-083 R2 的做法 |
| 按 handle、从设备来的好友请求（`to_address` 为空） | 地址能从 `device_id` 钉住的证书算出来的，改成按地址的请求（键是地址、`to_address` 是第一个地址）；算不出来的原样留着，能拒绝，同意时说「需要他的新地址」 | |
| 墓碑 `removed:<地址>`、`removed:c:<handle>` | 不变 | |
| 还没发出去的外发信，`to_device` 是 `handle[/agent]` | 改成那个联系人的地址（原值进备份）；历史行不改 | |
| `messages.agent` / `peer_agent`、`from_device` | 不改；显示时按联系人换（第 2 期） | |
| `config.json`（attendant 的分组 / 单人权限） | 不改。按旧 handle 或备注写的单人设置照样找得到（`old_name` 是查找键之一）；原来给 `self` 分组写的设置不存在（`self` 是保留分组），所以自己的电脑从「主人档」变成「`mine` 分组的设置，或者默认的只对话」 | |

备份：`~/.morse/backups/remove-v2-<UTC 时间戳>/tables.sqlite`（`contacts`、`contact_addresses`、`morse_requests`、`address_blocks`、`migration_marks` 整表 + 被改的外发信的 `(id, to_device)`）和 `MANIFEST.json`；写不了就退到 `mailbox.db.v4-contacts.bak`。手动恢复步骤写进 [docs/guides/restore-contacts-backup.zh-CN.md](../guides/restore-contacts-backup.zh-CN.md)。

## 3. 按地址的局域网和直连

**局域网**（替换 ADR-034 的那一套）：

- mDNS 服务类型 `_morse._tcp`（不是旧的 `_anytoany._tcp`，旧客户端看不见、也不会把它当设备），实例名每次启动随机，TXT 里是 `v=3` 和这台电脑托管的地址（`a0`、`a1`…，一个键一个地址）。不广告设备名、设备 ID。
- 端口照旧是控制台端口 + 1。只有一个路由：`POST /v3/envelope`，正文 `{blob}` 是**和中转上一模一样的 v3 信封**。收到后照中转来信一样处理（同一个 `receive`），回 202。
- **认证全靠信封**：信封由发信地址签名、封给收信地址；回执等应答也是收信地址签的信封，经对方的局域网端点（看得到它的话）或中转回去。所以不需要设备证书、信任名单和双向 TLS；陌生人的电脑也能在局域网直送（照样进好友请求）。通道本身是明文 HTTP（信封已经端到端加密；局域网里看得到的是收件地址和大小，见待定 Q1）。
- 发信顺序不变：本机 → 局域网 → 直连 → 中转。局域网送出去以后照样等端到端回执，等不到就走中转（对方按（发信地址、消息 ID）去重）。
- 旧客户端在局域网上看不见新客户端，走中转来（v3 连接上带证书的信封），能收到。

**直连（WebRTC）**：一条链路属于一对地址（对方的地址，我的地址）。信令走 v3 连接的 `signal` 帧（中转按地址转，ADR-073 起就有），每条信令是我的地址签名、封给对方地址的 v3 原生信封；DTLS 指纹在签名的 SDP 里，和以前一样核对。只和联系人（任一本机地址的）建链路，不和陌生人建。

## 4. 第 1 期做什么（客户端完全不需要 v2）

1. v3 连接启动就开，不等 v2 登录。v2 连接只在已经有 `relay.handle` 的电脑上还开（收 v1 信封）。
2. 新装（`morse address` 第一次、安装脚本）只在本机生成钥匙和地址、写 `relay.url`，**不注册 handle**。`morse address add` / `remove` 只改本机，不调 `/v1/agents`。
3. 发信：联系人有地址就按地址发（不管它有没有旧 handle、是不是以前配对的设备）。没有地址的旧联系人第 1 期还走 v2（第 2 期报错）。
4. 收信：所有 v3 信封按签名的地址处理；v2 连接上的 v1 信封按证书算出的地址处理；**一律 peer 档**。回给旧式来信（带证书、不带 `addr:1`）的应答仍带证书。
5. 局域网、直连按地址（第 3 节）；旧的局域网和直连关掉。
6. 迁移到 `user_version` 5（第 2 节）。`morse contact` 里还要地址的联系人标出来。
7. 「电脑 / 设备」这类只为 v2 留着的说法改掉。

## 5. 第 2 期做什么（客户端不再发任何 v2 的东西）

1. 不开 v2 连接，不发 v1 信封，不查 handle、Agent、钥匙包、别名。
2. 仍然收：v3 连接上带证书的旧式信封（没升级的人发来的）照收，按地址归到对的联系人，应答带证书。
3. 输入旧名字（`morse.im/<handle>`、`<handle>/<agent>`、`me/<agent>`）：一行错误 `old names no longer work — ask for their 26-character address (morse address shows it)`。没有地址的旧联系人发不出去，同一句。
4. 删掉隐藏命令 `join`、`invite`、`pair`、`peers`、`device`、`relay`、`name`；`agent` 见 ADR-091 第 11 条；`help --all` 跟着改。会话目标 `@<设备>/<agent>:<会话>`（别的电脑上的会话）删掉，本机的 `@<agent>:<会话>` 照旧。
5. 消息行显示按联系人（备注或地址），不再显示 `agent → agent`。JSON 字段只加不删。
6. `skills/` 改完重新生成；`site/agent.md`、安装脚本、QUICKSTART、README、docs 跟着改。

## 6. 第 3 期（以后，另一条分支）

主人确认中转上连续一段时间没有 v2 登录以后：中转删 `DeviceHub`、`/v1/*`、白名单、邀请、注册、配对码、别名表、`InviteBook` 里 v2 用的部分（每 IP 新地址计数要先挪到别处）、KV 里的 v2 记录；客户端删收旧式信封（`cert`）的那一半、`e2e.ts`、`trust.ts`、`effective-trust.ts`、`contact-split.ts`、`own-device`、`morse-blocked.json` / `trusted-devices.json` / `peer-keys.json` 的读写、`enc-key.pem`、设备证书的生成（第一个地址的钥匙仍是 `identity/key.pem`）。

## 7. 测试计划

- 迁移：用**已发布的代码**（`origin/main`）建的家目录做夹具（照 `test/fixtures/p3-home` 的做法：夹具里不放钥匙，测试时生成并替换）：几台用旧办法配对的自己的电脑（`self`）、有地址和没地址的旧 handle 联系人、拆出来的联系人、按 handle 的拉黑和请求、历史、给单个联系人设的 attendant 权限、还没发出的信。幂等、事务中途失败回滚、真进程 SIGKILL、六个进程同时打开、旧进程还在跑、备份内容、备份不成不迁移。
- 互通：两个跑已发布代码的对方和一个第 2 期的客户端，在内存假中转上双向收发（含线程回信、回执）。
- 局域网：两个临时家目录在这台 Mac 上按地址走局域网（隔离端口）；真 mDNS 隔离不了的部分用测试接缝，照实写。
- 连续 3 次全量测试全绿。
