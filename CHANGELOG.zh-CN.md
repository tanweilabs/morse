# Changelog

重大变更按时间倒序记在这里，最新的在最上面；每条是 `## YYYY-MM-DD — 标题` 加要点。

## 2026-11-17 — 换掉剩下的 anytoany 代码（ADR-093）

- **维护者拍板**：公开导出里仍归原作者（Erix）的代码、测试和文档，全部换成 Morse 自己写的，行为不变；目标是以后不再需要 MIT 声明。`LICENSE-MIT`、`NOTICE` 这次不删，由维护者看过结果再定。
- **重写**：投递适配器（Claude / Codex / Kimi / ZCode、版本守卫、ZCode 邮箱，公共部分收进 `src/adapters/common.ts`）；daemon 本机 API（筛查 → 认证 → 按路由名分派）、出站投递、系统通知、pid 文件；信箱（建表语句改为数据描述生成，逐字相同）；外部 agent 登记、闪电说接入、Claude 门铃、会话在线检测；设备身份、信任名单、@-mention agent 同步；CLI 里的旧命令接线（拆出 `src/cli/`）、提示钩子、doctor、setup、信封、会话目录与目标解析；本机控制台页面；两个 skill 的说明文字；CI、tsconfig、vitest、package.json。原作者的测试换成新写的，测试数 2035 → 2158；证书 PEM、生成的 agent 文件、建表语句钉成逐字测试。
- **删掉**：ADR-091 起就不再启动的按设备局域网（mDNS `_anytoany._tcp`、双向 TLS、`/api/peer/*` 的服务端和客户端）；`scripts/smoke.sh`（依赖已删的 `flush`）、`scripts/lan-smoke.sh`（依赖已删的 `pair`）、`scripts/experiments/`；根目录的旧 git 安装脚本 `install.sh`（现在的安装脚本是 `site/install.sh`）；只给扫描测试用的静态夹具和 `sanity.test.ts`。
- **文档**：仍有效的规格、两篇门铃调研、闪电说指南和文档地图按现状简写；`analysis.md`、`specs/archive/**`、`phase2-lan`、`phase6-device-identity` 和七篇 2026-08 的调研不再公开导出；ADR-001…029、ADR-042 简写；本文件和英文版里 anytoany 时期的条目压成一段摘要。
- **有意的小改动**：JSON 行文件里不是对象的一行按坏行跳过（以前 Claude 扫描会丢整份记录、Kimi 扫描会抛错）；`morse hook` 收到非对象输入输出 `{}`；`config.json` 顶层是数组时按 `{}` 读；一个会话的第一条系统通知总会发出；闪电说读的说明换了文字（命令不变），下次 `morse setup` 会刷新一次；`install-daemon-launchd.sh` 先找 `morse`；CI 去掉单值 Node 矩阵（检查名不变）。
- npm 包名仍是 `anytoany`。

## 2026-11-17 — README 重写为 Morse

- `README.md`、`README.zh-CN.md` 按 Morse 现状重写：一句话让 Agent 接入、手动安装（macOS / Linux / Windows）、两个名词（地址、联系人）和按联系人设权限、五个命令、消息怎么送到（本机 → 局域网 → WebRTC → 中转，端到端加密）、支持的 Agent 和系统、安全模型；许可写 Apache-2.0。`LICENSE-MIT`、`NOTICE` 照旧随公开仓库发布。
- 导出脚本不再改写两份 README：源头就按公开版写。

## 2026-11-17 — 中转也开源（ADR-092）；导出脚本改名 `scripts/export-public.mjs`

- **维护者拍板**：中转开源，自建中转的人能拿到代码、能审阅「中转看不到内容」；同日收窄为**站点仍私有**（两个安装脚本照旧公开）。
- **新公开**：`relay-cf/`（Worker、Durable Objects、测试、`wrangler.toml`）；`scripts/aliases-export.mjs` 和它的测试（`relay-cf/test/aliases-wrangler.test.ts` 要跑它）；只需要本机 `wrangler dev` 中转的验收脚本 `scripts/morse-e2e-{cf,addresses,files,requests,lan,lan-first}.sh`；新的[自建中转指南](docs/guides/self-host-relay.zh-CN.md)（`docs/README.md` 加一行）。
- **仍私有**：`site/`（除 `install.sh`、`install.ps1`）、`docs/DEPLOY-CLOUDFLARE.md`（§7 改成指向自建指南）、`scripts/build-site.mjs`、`scripts/release-*.mjs`、`scripts/lib/`、要建站点的验收脚本、`scripts/test/` 的其余测试、导出脚本本身、`CLAUDE.md`、`tasks/`、CI 计费审计、`skill-repo/`。
- **账号信息导出时替换，源头不动**：`relay-cf/wrangler.toml` 的 `ALLOWLIST` KV 命名空间 id → `<YOUR_KV_NAMESPACE_ID>`，`routes` → 注释掉的 `relay.example.com` 例子，头注释指向自建指南；`relay-cf/package.json` 和锁文件的 `license` 写 `Apache-2.0`。导出的 `docs/README.md` 去掉 DEPLOY-CLOUDFLARE 那一行。
- **改名**：`scripts/export-client.mjs` → `scripts/export-public.mjs`，用法不变。导出树的 `vitest.config.ts` 不再改写（收 `test/`、`relay-cf/test/`、导出的 `scripts/test/` 只有别名表测试）；README 里 `relay-cf/` 和自建那句不再删。公开版 CONTRIBUTING（overlay）写上中转、`(cd relay-cf && npm ci)` 和自建一节。
- **清理真名（源头改）**：`relay-cf/` 的测试和注释、`scripts/morse-e2e-files.sh`、`scripts/morse-e2e-lan.sh` 里的真实 handle / 昵称换成 mei / kai / lin、「小美」；`test/dispatcher.test.ts`、`test/morse-remove-v2.test.ts` 里的真实 handle 换成 lin；ADR-085 去掉内部域名。导出的 `GUARDS` 没有放宽。
- 中转 404 的提示改指自建指南——下次部署中转才生效，本次不部署。

## 2026-11-16 — Windows 上打开 WebRTC 直连（ADR-080 第 33–37 条，第 5 期前一半）；停止时当场挂断直连（所有平台）

- **Windows 上不再强制关直连**：`src/platform/platform.ts` 的"这一期 Windows 上关着"列表里去掉 `direct`，`cli.ts` 里三处判断删掉——和 macOS / Linux 走同一条路：默认开，`config.json` 写 `"morse": {"direct": {"enabled": false}}` 或 `MORSE_DIRECT=0` 关；约 3 秒打不开走中转；打不开的设备 5 分钟起翻倍退避（最多 6 小时）。Windows 上的 `morse status` 有了通用的 `direct:` 一行。局域网在 Windows 上仍然强制关。
- **真机验收**（Windows 11，Node 22.23.5，和同一个路由器下的 Mac，[记录](docs/guides/windows-test-log.zh-CN.md)第 7 轮）：`node-datachannel` 的 win32-x64 预编译包能加载；两个方向的消息、两个方向 2.4 MB 的文件都是 `delivered via direct`；38 MB 的传输中途直连断开 → 3 秒打不开、5 分钟退避 → 走中转传完，SHA-256 一致；通道开着时重启 Windows 的守护进程，下一条消息建了新的直连。选中的都是 host / prflx（同一个局域网）；STUN 拿到了 srflx 候选。还没测：两个不同的网络之间；一台没有现成 `node.exe` 放行规则的 Windows。
- **修复（所有平台）**：有序停止时关直连那一步放在 `setImmediate` 里，进程先退出了——对方收不到告别，要等约 30 秒 ICE 超时才知道，这段时间发过去的分块全丢。现在整个模块停止时当场挂断：真机上对方从 28 秒变成约 35 毫秒就知道。
- 安装器结尾、技能、站点上"Windows 上没有直连"的说法改掉。

## 2026-11-16 — 删掉 v2 发布后的修补：局域网默认关并加固；迁移不会让权限变宽；按旧名字拉黑的人进不来；写给旧名字的信不再假装送到（ADR-091）

- **局域网默认关**：只有 `config.json` 写 `morse.lan: true` 或 `morse start --lan` 才开（`--no-lan` 照旧关）。开了以后也加固了：
  - 只公告第一个地址（其他地址彼此不能被关联）；
  - 发信前对方要用这个地址的钥匙签一个随机数，证明它真的持有这个地址；几台电脑公告同一个地址时只用证明过的那台；
  - 局域网上只送消息，每条以回执为准，几秒内没回执就改走直连 / 中转，并且这个地址 10 分钟不走局域网；文件块、回执、通知、信令一律不走局域网——有人在局域网上冒充或拖着，文件传输和回执都不受影响；
  - 监听端先打开信封（签名、收件地址）再交给收信，不管结果都回同样的 `202 {}`；只收 JSON、不收浏览器发来的（带 `Origin`）；正文最多约 1.1 MB；头 5 秒、请求 15 秒超时；最多 32 个连接；每个 IP 每分钟 120 个请求、10 分钟最多 5 个新发件人；记住的对端有上限。
- **为旧名字写的 attendant 设置继续管用、不会变宽**：查设置时也看旧名字的 handle 部分（`alice/air` → `alice`）和合并时丢掉的旧备注（从 v5 的备份里找回，存进新表 `contact_old_keys`）。测试逐个联系人比较迁移前后的实际权限。
- **按旧名字拉黑的人**（拒绝过的请求、删掉的联系人，`morse-blocked.json` 里没有地址的那些）用旧办法再写来时，按信里的旧名字认出来，丢掉，并把这个地址也拉黑。
- **写给旧名字、还在发件箱的信**记成失败（不再重试、不再「送到」本机收件箱），写那一行错；上一版已经错记成送到的，打开时改成失败。
- 旧名字写给第二个 Agent 的信（`mei/<agent2>`）按那个 Agent 归档；告诉用旧办法写来的陌生人「接受了请求」时带上证书，他扣着的信不用再等（别人照旧不带，第一、第二个地址说话一个样）。
- 「自己的收件箱邮件开专用会话」（ADR-061）从此没有东西可跑：它只处理自己别的电脑来的信，而那些现在都是联系人。
- **从别的电脑来的信一律是同伴消息**，不管存的是什么档（上一版的 daemon 还在跑、把自己旧电脑的信记成 owner，也一样）；迁移过来的这类信 `from_tier` 改成 peer。
- 没有备注的联系人用旧名字当备注（重名的在地址后面写 `(was <旧名字>)`）；「你」那一行残留的别的电脑的 Agent 删掉。
- 升级备份失败时一行错、退出码 1，不再打印堆栈、daemon 不再反复崩；升级那一行也说「以及你手动放进 self 的」。
- 已经升到 v5 的家目录：打开时修一次（`repairAfterV5`，`migration_marks` 记 `p5.repair.1`，改之前的值写进 `~/.morse/backups/repair-remove-v2-<时间>/changes.json`）。手动退回见 `docs/guides/restore-contacts-backup.zh-CN.md`。

## 2026-11-16 — 删掉 v2 第 2 期：客户端不再发任何 v2 的东西；旧名字一律报一行错；删掉配对、邀请、`agent` 等隐藏命令（ADR-091）

- **不再开 v2 连接、不发 v1 信封、不查旧名字的目录**。已发布客户端（20261116042458 起）写给你旧名字的信——v3 连接上带证书的旧式信封——照收，按签名的地址归到对的联系人，回执带证书（只从第一个地址回）。完全不讲 v3 的 v1 信封直接丢掉、记一行日志。
- **输入旧名字一律一行错**：`morse send` / `contact add` 等写 `morse.im/<旧名字>`、`<旧名字>/<agent>`、`me/<agent>`，或写给还没有地址的旧联系人，都报 `<谁>: old names no longer work — ask for their 26-character address (morse address shows it)`，什么也不发。`morse address` 不再显示 `old name:` 一行。
- **删掉的隐藏命令**（现在是 unknown command）：`pair`、`peers`、`join`、`invite`、`relay`（包括 `relay show`）、`device`、`name`、`agent` / `agents`。管理地址只用 `morse address [add | set | remove]`。
- **消息行按联系人显示**：别人的消息行不再显示 `claude → mini` 那一栏 Agent 名，只有备注或地址；JSON 只加字段（`oldName`），原有字段不删。
- **安装脚本**（`install.sh`、`install.ps1`）：不再收邀请码、配对码（带了就报错说明怎么做），不调 `join`；没有地址就 `morse address` 建一个。`--agent` / `--name` 接受但不起作用。
- 对方太旧时的提示改成 `… their Morse is too old to be reached by address (…) — ask them to update: run the installer again (morse.im)`（没有旧链接可以退回去了）。`morse status --check` 的钥匙检查不再说配对设备。
- 修掉第 1 期的一个 bug：daemon 启动时局域网层报 `lan: off — Cannot access 'morse' before initialization`，按地址的局域网在真 daemon 上其实没开起来（单元测试是直接调的模块，没碰到）。
- 技能、README、QUICKSTART、官网首页跟着改：旧名字不能用了、另一台自己的电脑是 `mine` 分组的普通联系人、局域网按地址。
- 测试：新增 `test/released-interop.test.ts`（已发布代码建的家目录被这一版迁移，再和两台已发布代码的对方、自己那台没升级的电脑双向收发）和 `scripts/morse-e2e-addresses.sh`（本机 `wrangler dev` 中转 + 两个临时家目录，真 mDNS 按地址走局域网）；删掉只测 v2 的 7 个测试文件。

## 2026-11-16 — 删掉 v2 第 1 期：客户端完全不需要 v2；每个联系人都按地址；用旧办法配对的自己的电脑成为 `mine` 分组的普通联系人（ADR-091）

- **v3 连接启动就开**，不再等 v2 登录宣布协议 3。v2 连接只在已经有旧名字（`relay.handle`）的电脑上还开着，用来收还没升级的人用 v1 信封发来的信、和联系还不知道地址的旧联系人；新装的电脑从来不登录 v2。
- **新装不注册旧名字**：`morse address` 第一次（安装脚本调的 `morse join` 也一样）只在本机生成钥匙和地址、写上中转，不发任何请求。`morse address add` / `remove` 也只改本机，不再调 `/v1/agents`；中转连不上也照样能建地址。
- **发信一律按地址**：联系人有地址就按地址发，不管它以前是不是按旧名字加的、是不是以前配对的电脑。
- **收信一律按签名的地址、一律 peer 档**：所有 v3 信封（带不带设备证书）都按签名它的地址处理——拉黑、联系人、好友请求都按地址，信里自称的旧名字和 Agent 名一律不读。回给还没升级的人用旧路径发来的信时，回执仍带这台电脑的证书（他们的客户端只认这种）。**没有 owner 档了**：别的电脑的信从来不带你的授权、不点会话、不续接会话。
- **数据库升到 `user_version` 5**（一个事务、迁移的那个进程在事务里做一份小备份 `~/.morse/backups/remove-v2-<时间>/`、幂等、被杀不留半截、几个进程同时打开只迁一次、旧进程还在跑也安全）：
  - 旧名字联系人地址已知的（P2 核对过的、见过的、按地址来过信的、或者信任名单里那台电脑钉住的证书）变成按地址的联系人，旧写法记在 `old_name`（JSON 里是 `oldName`），备注、分组、权限、历史都不变；推不出地址的原样留着，`morse contact` 里标 `— needs their new address`（JSON `needsAddress: true`），不删。
  - `self` 分组里的联系人（用旧办法配对的自己的电脑，以及手动放进去的）都改到 `mine` 分组，去掉 `own-device` 标记。**它们的信不再当作你本人的指令**；要让某台替你做事：`morse contact set <它> --cwd <目录> --tools <工具>`（或给整个 `mine` 分组设）。`--group self` 以后会被拒绝（`self` 是你自己）。
  - 按旧名字的拉黑：这个名字已知的每个地址都在第一个地址上拉黑（`morse-blocked.json` 不改）；按旧名字、证书已钉住的好友请求改成按地址的请求；还没发出的、写给旧名字的信改成写给那个联系人的地址。
  - 升级时说一行：`morse: old names are gone — every contact is reached by its address now; N contact(s) need their new address (ask them for it, then: morse contact add morse.im/<address>); N contact(s) — your own computers paired the old way among them — are in group mine: ordinary contacts, their messages are no longer taken as your own instructions (to let one act for you: morse contact set <name> --cwd <dir> --tools <tools>); nothing was deleted, backup: <path>`。`morse status` 多一行 `contacts: reached by address — …`。手动恢复见 `docs/guides/restore-contacts-backup.zh-CN.md` 第一部分。
- **局域网按地址**：mDNS `_morse._tcp` 只广告地址（不再广告设备名和设备 ID），`POST /v3/envelope` 传和中转上一样的 v3 信封，认证全靠信封签名；不需要配对、信任名单和双向 TLS。旧的局域网（`_anytoany._tcp`、双向 TLS、`/api/peer/*`、别的电脑的会话目录）关掉了——还没升级的电脑在局域网上看不见你，改走中转，照样送到。`morse start --peer <地址>@<主机>:<端口>` 可以不靠 mDNS 指定。
- **直连（WebRTC）按地址**：链路在这台电脑的第一个地址和一个联系人的地址之间，信令走 v3 连接、用 v3 信封封；链路开着时中转断了也不再因为一个晚到的候选信令失败而关掉。
- 正在运行的上一版 daemon：改联系人和发信的命令会拒绝并提示重启（新能力 `addresses-only`）。
- 隐藏的 `morse agent`（列表）不再把只在本机加的地址从本机列表里删掉。

## 2026-11-16 — 官网去掉「在别处也装了 Morse」一节

- 首页不再单独讲「在别处再装一份 Morse」，也去掉了关于 `self` 分组的说明（这是旧配对方式留下的，访客用不到）。别处的 Morse 就是一个联系人；「你的 Agent 能替联系人做什么」这一句挪到了「给联系人起备注」下面。

## 2026-11-15 — 看消息的命令叫 `morse read`：收发是 send、reply、read 三个动词，`morse message` 留作隐藏别名（ADR-090）

- `morse --help` 列 `read`、`send`、`reply`、`contact`、`address`。`morse read` 就是原来的 `morse message`：不带参数 = 待处理（加消息请求的数目）；`read <联系人>` = 和他的全部往来；`read --id <ID>` = 一条全文；所有选项（`--all`、`--from`、`--all-addresses`、`--pull`、`--wait`、`--history`、`--inbox`、`--json`、`--limit` 等）照搬，输出逐字节相同。
- 看不改任何状态：一条消息一直在待处理里，直到 `morse reply` 或 `morse done`（只有 `--pull` / `--take` 会取走它们显示的，和以前一样）。帮助和技能里都写明了；测试钉住 `read`、`read <联系人>`、`read --id`、`read <ID>` 前后 `processed_at` 不变。
- `morse message`（和 `messages`）照常可用、行为不变——技能、插件、钩子和脚本都在调；插件的 JSON 契约不变。`morse help --all` 的隐藏命令里列出 `message`（11 个隐藏、一共 16 个）。
- 旧的隐藏 `morse read <ID>` 照旧能用：`read <参数>` 是消息 ID 或唯一前缀就看那一条，否则当联系人；两边都对上（备注名是一串十六进制、又恰好是某条消息 ID 的前缀）按消息，标准错误另说一行 `note:`，给出看往来要写的地址。都没对上时，长得像 ID（十六进制、带数字）报以前的 `no message <ID>`，否则报联系人的那句。
- 所有叫人跑 `morse message …` 的地方改成 `morse read …`：提问钩子那一行（`[morse] N new messages from … — morse read`）、待处理列表末尾那行、发信 / 发件箱的报错、同意请求 / `contact add` 的回话、`morse connect`、Windows 的说明、install.sh / install.ps1、值守插件和微信桥接的通知、两个技能、`agent.md`、README、QUICKSTART 和插件文档。逐字节对照只有这些提示行变了。

## 2026-11-15 — 站点：强调色换成浅铜色；手动安装按系统分页签；「常用命令」换成「你可以这样跟你的 Agent 说」（ADR-085 后续）

- 强调色从淡金色 `#ffce8e`（看着像金子、像币圈）换成浅铜色 `#f0ad86`：1844 年那条电报线和此后的信号线都是铜的。仍然只有一种强调色：纸带、1844 那根线、亮起的字母、按下的电键、电码表、选中的页签、复制后的反馈、网站图标和分享图（`site/og.png`，用 `?poster` 重新渲染）都用它；画面里的渐隐也从同一个值算出来。当文字用时对背景的对比度是 10.6:1（AA 要求 4.5:1），所以文字不需要另配浅一档的颜色。

- 手动安装：两条命令上下摞着改成一个命令框，上面三个页签 **macOS · Windows · Linux**。默认选访客自己的系统（`navigator.userAgentData.platform` / `navigator.platform` / UA；iPhone、iPad 算 macOS，Android、ChromeOS 算 Linux，认不出算 macOS）；选过的只在这个标签页的会话里记着（sessionStorage）。复制按钮复制当前页签的命令。真的 tablist：方向键、Home / End 切换，焦点框看得见。关掉脚本时三条命令都在、各自标着系统名，按文本抓页面的 Agent 照样读得到两个安装脚本。
- Windows 那句说明挪到命令框下面，改成「Windows 11，在 PowerShell 里运行。预览版：暂时没有局域网和直连、插件、自动更新。」（缺什么一字不变）。
- 去掉「常用命令」：Morse 是跟你的 Agent 说话来用的，这一节换成六句人会说的话，中英文各写各的、不是互译（中文「Morse 上有新消息吗？」「回思思：好的收到～」……，英文 "Anything new on Morse?" "Reply to Alex: sounds good" ……），首屏底部的链接改成「怎么用」。首屏以下其他几节（给联系人起备注、在别处也装了 Morse、地址、陌生人的请求）也不再贴命令，改成白话。安装命令保留；给 Agent 看的命令在 `agent.md` 和技能里。

## 2026-11-15 — 改字第二轮：站点首屏以下、命令行剩下的字、两段提示词不再说「这台电脑」（ADR-088 后续）

- 产品只有两个名词：自己的地址、别人的联系人（自己在别处的 Morse 也是联系人）。站点首屏以下几节（中英两份）、`agent.md`、`llms.txt`、Morse 技能里不再说「电脑 / 机器」：「你自己的另一台电脑」改成「在别处也装了 Morse——对你来说它就是一个联系人」；地址「只送到存着它钥匙的地方」；会话说「here」。
- 命令行里剩下的：`morse start`（交给 launchd / systemd 时）、`morse status --check` 的说明、`morse join` 之后的提示、`morse list` 的说明、`morse plugin`、`morse contact remove`（不再报「N 台电脑不再受信任」，只说 `(no longer trusted)`；JSON 的 `devices` 字段不变）、控制台接口的两句报错、Windows 自检，以及 `morse send --from <不存在的名字>`：现在和别的命令一样说 `is not one of your addresses here`——这是「只有一个地址时逐字不变」的对照里唯一有意改的一行。
- 写进 Agent 会话的两段提示词换了说法、没换意思：自己的会话信是「The same human who runs your session also runs the sender — a session here, or one of their own installs they paired with this one before」，别人的信是「which belongs to SOMEONE ELSE (a peer, not part of your operator's own cluster)」。谁带操作者授权、谁不带，一点没变；新加的测试钉住两段新文字。
- daemon 日志里纯说明的几行也去掉了「this computer / their device」。测试或脚本读的日志行、隐藏的配对 / 局域网 / `agent` / `relay show` 旧路、更新前按电脑配对的那些联系人（`self` 分组）的说法都留着，等删 v2 时一起走。逐条清单和理由见 `docs/specs/agent-first-wording.zh-CN.md` 第 7 节。

## 2026-11-15 — 重启的说法统一成 `morse stop --restart`；`morse start` 不再造出第二个没人管的后台服务（ADR-089 补充三）

- launchd / systemd 管着后台服务的电脑上，`morse stop` 之后紧接着 `morse start`，以前会留下一个手动起的 daemon：服务管理器自己的那份每 10 秒启动一次都因为「已经在跑」退出，自动更新也重启不了正在跑的那个。现在这种电脑上 `morse start` 把启动交给 launchd / systemd（没有服务任务的电脑上照旧在前台启动）；代码里十一处「morse stop && morse start」的提示全部改成 `morse stop --restart`。
- Agent 的命令行被杀掉时，在进程退出的那一刻就知道，不再等它的输出管道关闭——它的子进程占着管道时，以前要拖到时限才发现，并且报成超时。
- 让服务管理器启动、停止、重启之前，先确认那个任务是这个家目录自己的（比对 launchd / systemd 加载它的那个文件）。
- 文档里写明：故意杀掉 Agent 的进程并不会取消那条消息，它会带着提醒重新开始，最多三轮；想彻底停下用 `morse done <id>`。
- 改到的测试基线（提示语变了，都是有意的）：`cli-old-daemon`、`cli-older-daemon`、`update`、`cli-slim`、`own-addresses`、`cli-p2`、`morse-address`。

## 2026-11-15 — Agent 干到一半时重启，消息不再投两次（ADR-089）

- **原来的问题**：daemon 重启（自动更新、`morse stop && morse start`）时如果你的 Agent 正在处理一条消息，30 秒后这条消息会再投一次，Agent 把同一件事做两遍。重启后马上在那个会话里敲一句话，消息也会被再带进去一次。微信消息走的就是这条路。
- **一次投递现在属于拿着它的人**：dispatch 插件认领时带一份租约，回合进行中每 15 秒续一次，并且绑在 agent 命令行的进程上。回合还在跑，谁也拿不走这条消息（新的插件、提问钩子、`morse message --pull` 都不行）。只有持有者的确认算数；已经被接手的那一次再来确认，什么都不改，它的回信也不发。
- **重启会等回合**：自动更新在安装前等一个没有回合在跑的空档（最多 10 分钟），重启前再等一次（最多 2 分钟），等的时候 `morse status` 会多一行说明；插件被要求停止时让正在跑的回合最多再跑 10 秒，daemon 对每个插件只发一次停止信号，等它的时间从 3 秒改成 15 秒。
- **更新不再直接 `launchctl kickstart -k`**：实测 launchd 在这之后 5 秒就强杀。现在 daemon 先自己正常停下来，再让服务管理器重启它；`morse update` 命令也一样。新安装的电脑 launchd 任务带 `ExitTimeOut` 30，systemd 单元带 `KillMode=mixed` 和 `TimeoutStopSec=30`；已经装好的电脑重跑一次安装命令才有。
- **只有真的开始过的回合才算可能重复**：认领之后、启动 Agent 之前持有者就没了的消息，之后按第一次投递发出去，不带标注。daemon 被杀时它的插件立刻不再接新消息，只把手上的回合跑完。插件走了、留下来自己跑的回合仍然占着它的会话，期间不会在同一个会话里再开一轮。认进程看的是进程号加启动时间，进程号被别的程序重用不会再让消息多卡两小时。
- **回合确实被打断时**（和 daemon 一起被杀、电脑崩溃），等确认持有者不在了再重投，并且第一行就告诉 Agent：这条可能已经处理过，先看看自己做过什么。同一条消息连续三轮被打断就进死信：它的会话下次提问时仍然拿得到（带标注），微信那边会收到一句「没有处理完」。
- **回合被信号打断不再算「失败」**：Agent 的命令行在回合中途被杀掉时（手动重启、launchd / systemd 结束任务、daemon 崩溃），以前这条消息会不带提醒地重试，微信那条线上更是当场作废、只回一句「处理出错了」。现在会带着「可能已经处理过」的提醒重新投递，连续三轮被打断才放弃；放弃时微信里的说法也改了：可能已经处理完了、只是没能确认，重发之前先看一下。
- **重启用 `morse stop --restart`**（不要再用 `launchctl kickstart -k …` / `systemctl --user restart morse`）：它会先等正在处理的消息。已经装好的电脑不用重装：daemon 下次启动时会给自己的 launchd plist 补上 `ExitTimeOut`、给自己的 systemd unit 补上 `KillMode=mixed` 和 `TimeoutStopSec`（只动这一个文件、只加缺的行、不重启任何东西；launchd 要到下次登录才用上）。
- **不续期的租约会结束**：没开始回合的认领 90 秒没人续就放掉；开始了的回合过了它自己的时限可以被接手。
- **租约记在信箱那一行里**（`messages` 加九列，不升版本号；上一版照常工作）。daemon 和插件一起崩了也不会卡住：45 秒内租约到期，下一个插件接手。
- **自己写的插件**：不要租约就和以前完全一样；要的话用 `morse plugin claim --lease`、`ack` / `nack` 加 `--holder`、新命令 `morse plugin extend`。消息多了一个 `possibleRepeat` 字段。不带租约时仍是以前那个更弱的保证，哪些情况还会重复写在 docs/PLUGINS.zh-CN.md。
- 自己信箱里的信（ADR-061）不走认领，用插件自己的记号做同样的标注。
- 顺手两处小加固（外部应用的口令，闪电说那类）：一个口令最多绑 256 个会话 id，满了去掉最早的；它们搜索会话时只匹配标题，不再匹配项目文件夹名。**没做**：让闪电说在出示口令前先确认对面是自己的 daemon（原因见 ADR-089）。
- 改到的已有测试：`test/migrate-v4.test.ts`（整库对比先去掉新加的五列）、`test/local-api-followups.test.ts`（会话搜索）。

## 2026-11-15 — 两个名词：地址是自己的，联系人是别人；自己的地址和联系人一样起备注名（ADR-088；在分支 `feat/agent-owned-addresses` 上，未合并、未部署）

这一条的第一稿是「地址按 Agent 起名」（默认名 `claude` / `main`、启动时自动改名、命令认出是哪家 Agent 在调用）。主人否定了这个方向——Morse 本来就是给 Agent 用的，另一个 Agent 就是一个联系人——那些逻辑全部删掉了，没有发布过。定稿：

- **两个名词**：地址（我的）和联系人（别人，包括我自己在别处的 Agent）。「Agent」只用来说谁在用 Morse，不再是产品里要起名、识别、管理的东西。
- **地址的备注名和联系人的一样起**：`morse address set <备注名或地址> --name <新备注名>`（只有一个地址时不用写是哪个；`--name ""` 清掉），规则和报错句式照联系人的备注名（什么字都行，不能是命令词、不能像地址；另外不能以 `@` 开头或带冒号）。只写本地一个文件：地址不变，别人手里的链接照常能到，原来的名字在 `--from` 里仍然认。`morse address rename` 留作隐藏的旧写法。
- **`morse address add` 的备注名可以不写**：没有备注名的地址按地址本身显示，以后再起。
- **一个名字只能在一边**：自己地址的备注名不能和联系人的备注名相同（不分大小写），反过来也一样，起名时报一行错。升级前就重名的不动，只查新起的。
- **只有一个地址时哪里都不显示名字**：`morse address` 只打印地址；`morse contact <谁>` 的 `knows you as:` 只写地址；「唯一的地址删不掉」那句不带名字。
- **不按产品认调用者**。一个会话用哪个地址：`--from <备注名>`，或环境变量 `MORSE_ADDRESS=<备注名或地址>`（设了以后发信默认从它发、列表默认只看它的，`--all-addresses` 看全部）。不设 = 和上一版逐字相同。写错时命令报一行错，提示钩子不出声。
- **`MORSE_ADDRESS` 影响不到后台服务和插件**：从导出了它的 shell 启动后台服务，值守、dispatch、微信桥接的行为和干净环境里完全一样——后台服务启动时把它从自己的环境里去掉（日志里说一行），启动插件和替插件跑命令时都不带它，插件跑的命令就算拿到了也不读。（第一稿的评审发现：继承到的「调用者」记号让插件自己的 `morse message --json` 返回空，值守不回信，微信桥接收不到回复。）
- **写给另一个地址的联系人时，拒绝的那一行只说联系人所属的地址**（`--from <所属的那个>`，或去掉 `MORSE_ADDRESS`）。以前那一行教人「改写对方的地址、从另一个地址发」，照做会把第二个地址暴露给对方。
- **发布前最后一轮**：带着 `MORSE_ADDRESS` / `--from` 按名字查到另一个地址的联系人时，说明他属于哪个地址，不再提示「加一个」；`morse address` 给 `MORSE_ADDRESS` 选中的地址加标记；名字按 Unicode NFC 比较；地址的隐藏旧名字也不能当联系人的备注名；名字没变时不写文件，清掉名字时回话里写明；`morse join` 的输出改成地址和联系人的说法。
- **消息行里记的名字不随改名变**：行里存的是中转目录里的名字，显示时按地址查现在的备注名，所以同一个列表里不会新旧两个名字混着出现。
- **`--session`**：回信回到哪个会话，和 `--from <备注名>`（从哪个地址发）分开，可以同时写；`--from "@…"` 的旧写法仍然认。
- **新地址不用重启后台服务**：`morse address add` / `remove` 之后正在跑的后台服务立刻照办。
- **升级不改任何名字**。安装脚本的 `--agent` / `-Agent` / `MORSE_AGENT` 仍然接受，只在这次安装新建地址时当作它的名字；已有地址的电脑上忽略（以前是再加一个地址）。Windows 上不再默认传 `win`。
- **技能和给 Agent 的页面**：第一次使用 = 没装就装 → `morse address` → 把地址告诉主人。没有起名、改名这一步。
- **只有一个地址时和 `main`（5ce8c59）不一样的输出**：
  - 对照测试（72 步）里变了 2 行：`morse contact <谁>` 的 `knows you as: mini (morse.im/…)` → `knows you as: morse.im/…`。
  - `morse address` 第一行 `address: morse.im/…   mini` → `address: morse.im/…`。
  - 删唯一的地址：`error: mini is this computer's own address (its first one) — it cannot be removed; remove the other addresses, or rename it: …` → `error: this is your only address here (it uses this install's own key) — it cannot be removed`。
  - `morse address add <像地址的名字>` 的报错多了括号里的说明（和联系人的一致）；`address` 的帮助文字改成和 `contact` 成对的写法。
  - 安装脚本结尾不再有 `This computer's address is named …` 一行。
  - 第一稿就改了、这次保留的那批「this computer / device」字样（约 30 句报错和说明，逐句见 `docs/specs/agent-first-wording.zh-CN.md` 第 1 节），例如 `this computer has no address yet` → `there is no address here yet`、`their device confirmed …` → `the other side confirmed …`。
- **没动的**：会话目标 `@<agent>:<会话>` 和消息行里的收发 agent 一栏（`claude → mini`）——v2 的写法，和 v2 一起删；JSON 输出的已有字段；`morse send --from <不存在的名字>` 的那句报错保留上一版原文；值守说明里的「your agent」；安装脚本选项的名字。
- 测试：`test/address-labels.test.ts`（8 例）、`test/own-addresses.test.ts`（20 例，真命令行 + 假中转）、`test/plugin-address-env.test.ts`（8 例，含真 daemon），微信整条往返带着 `MORSE_ADDRESS` 跑，安装脚本两份各加一组；第一稿的 `test/address-adopt.test.ts` 和调用者识别的测试随功能删掉。

## 2026-11-15 — 微信桥接：你自己发的消息前面不再带 `[@user]`

- ilink 插件把不在微信对话里的消息转到微信时，会在前面写上是你的哪个 Agent 发的（`[@codex] …`）。从命令行发、没写 `--from` 的消息没有 Agent 可写，以前会显示成 `[@user] …`，这是内部标签，人看不懂。现在这种消息不加前缀；Agent 发的照旧写名字。

## 2026-11-15 — 本机接口的五处跟进：外部应用的口令只能读自己会话的信；口令只交给自己的 daemon；`morse stop` 不再按进程名找 daemon（ADR-087 补充）

- **外部应用（闪电说等）的口令绑定到它自己的会话**（中）：以前带着自己口令的应用把任意会话 id「注册」成自己的，就能读走那个会话的信。现在口令只认它绑定的会话，收信按「（应用名，会话）」取；会话列表对外部应用只返回 Agent 名和标题，不再有会话 id 和目录。**已经接入的不用动**：旧口令第一次被用到时就地补上绑定。
- **口令只交给自己家目录的 daemon**：`--port` 和自己 daemon 的端口不一样就直接拒绝、什么都不发；端口对了也先让对方证明它持有口令（一次不带口令的问答）。ilink 插件不再传默认端口。闪电说的 `curl` 改从文件读口令头，口令不再出现在命令行上（更新时自动换成新写法）。
- **`morse stop`** 没有 pid 文件时不再按进程名找 daemon（那样可能停掉另一个家目录的 daemon）：只认自己 `daemon.json` 里的那个，说不准就回答没在跑。
- **Web 控制台**只能在本机会话之间发信；给别的地址发信用 `morse send`。
- **重启时正在投递的信不再卡住**：daemon 重启那一刻正在投递的信会被标成失败；以前原来的投递者随后的「已送达」会被拒绝，会话自己拉取也看不到它。现在两者都认。
- 测试：`test/local-api-followups.test.ts`（20 例）。

## 2026-11-15 — 接入 Morse 只要给 Agent 发一句话：首屏、给 Agent 读的页面、站点上的 skill（ADR-086 的 P-A；在分支 `feat/agent-first-site` 上，未合并、未构建、未部署）

- **首屏是一句话**：「帮我接入 Morse：读 morse.im/agent.md，照着做，完成后把你的地址告诉我。」（英文版是 "Set me up on Morse: read morse.im/agent.md, follow it, and tell me your address when you're done."），上面一行小字「把这句话发给你的 Agent」，复制按钮复制当前语言的那句，旁边「或者自己装 ›」。下面的「安装」改名「手动安装」，多了 Windows 一行 `irm https://morse.im/install.ps1 | iex`，并如实写了它是预览版（暂时没有局域网和直连、插件、自动更新）；系统要求一行改成 macOS、Linux、Windows 11（预览版），Node.js 22+。
- **站点多发 7 个文件**（构建脚本生成，未上线）：`/agent.md`、`/llms.txt`、`/skills/morse/SKILL.md`、`/skills/reload/SKILL.md`、`/.well-known/agent-skills/index.json`（Agent Skills 发现草案 0.2.0，带 sha256 摘要）和它下面的两份 `SKILL.md`。`_headers` 给了类型和 `no-cache`。
- **skill 只有一个来源**：`skills/morse/SKILL.md` 换成「skill 先行」的新文本——第一次用的时候，没有 `morse` 命令就自己把客户端装上、拿到自己的地址、用一句话告诉用户；产品要用户批准命令的就等批准，不绕过权限提示。`skill-repo/`（将来公开的 `tanweilabs/morse-skill`）和站点上的副本都由 `scripts/lib/skills.mjs` 生成，测试保证一致，发布包里带的也是同一份。**客户端的行为没有变**，只是 `morse setup` 拷出去的 skill 文本换了。
- **`agent.md` 按四种 Agent 写**：有 `npx` 的、有 shell 没 `npx` 的、产品没有 skill 的、只在聊天沙箱里的（停下并告诉用户为什么）。
- **页面上的小改动**（ADR-085 补充三）：英文标题 Why “Morse” 改成 "Why it's called Morse"，那一节开头先说名字的来历；触屏上第一次按电键时提示一次「没有声音？请关闭手机的静音模式」；纸带译出 SOS、MORSE、HELLO、HI、CQ、73 时字母亮一下、响两声确认音，MORSE 和整句 1844 年的电报还有一道波扫过整张网；右上角多了「电码表」；敲出两个字母后可以把「我在 morse.im 用电报敲出了：…」复制成一行文字，也可以清除重来。
- 验证：`scripts/test/build-site.test.ts` 新增 6 条（摘要、一致性、类型、页面里的句子），全量 1846 条测试通过；测试模式构建（一次性钥匙、临时目录）后起本地服务把上面每个路径取了一遍。没验证的：`npx skills add` 没有实跑；线上 Cloudflare 是否照样发 `.well-known` 目录；真 Agent 走完整个流程。
- 页面 71.9 KB → 84.8 KB（gzip 25.6 → 29.6 KB）；仍然是一个文件、一个请求；空闲时每帧脚本耗时和 main 一样。

## 2026-11-15 — 草稿：Morse 是给 Agent 装的 Skill，安装入口是一句话，地址属于 Agent 而不是电脑（ADR-086；在分支 `feat/agent-first-skill` 上，未合并、未部署、未发布，客户端行为没有任何改动）

- **一句话**：人只把「帮我接入 Morse：读 morse.im/agent.md，照着做，完成后把你的地址告诉我。」发给自己的 Agent；Agent 装 skill、skill 发现没有 `morse` 命令就用 morse.im 上签过名的安装脚本装客户端、给自己起一个按 Agent 命名的地址、用一句话报告。
- **准备公开的 Skill 仓库**原样放在 `skill-repo/`（README 中英、MIT、`skills/morse/SKILL.md` 按「skill 先行」重写、`skills/reload` 原样）；只有一个 `SKILL.md`、不带脚本。对着已发布的客户端今天就能用；Windows 那一行要等 Windows 版发布。**GitHub 上没有新建任何仓库。**
- **给 Agent 读的页面**：`site/agent.md`、`site/llms.txt`（还没接进站点构建，不会随下一次构建上线）；首屏文案的中英文草稿在 ADR 里，`site/index.html` 没动。
- **「电脑」的说法清单**：命令行、技能、站点、安装脚本、QUICKSTART、README 里每一处「this computer / device / 这台电脑」按文件和行号列出并给了改法（`docs/specs/agent-first-wording.zh-CN.md`），一个字都还没改。
- **事实核对**：Skill 今天怎么分发和安装（Agent Skills 标准、`npx skills add`、Claude Code / Codex 的发现目录、从网站发现 skill 的草案、`/llms.txt`），带出处，没能验证的单列（`docs/research/research-agent-skills-distribution-2026-11.md`）。
- 分期：P-A（skill + 页面 + 首屏，不改客户端）、P-B（地址按 Agent 起名、只改名不换钥匙的迁移、说法清扫）、P-C（其余）；要主人定的几件事在 ADR 末尾。
- `scripts/export-client.mjs` 多一条规则：`skill-repo/` 不进客户端的公开导出（它是另一个仓库）。

## 2026-11-15 — 安全修复：daemon 的本机接口要凭证，网页进不来；命令只和自己家目录的 daemon 说话（ADR-087）

- **问题**（独立评审确认，早就存在）：daemon 的本机 HTTP 接口没有口令、不看来源，请求体不管什么类型都当 JSON 解析——你打开的任意网页都能以你的身份往本机 Agent 会话里放信，能让 daemon 把本机文件发到它指定的地址，还能通过 DNS 重绑定读会话列表。另外，`morse send` 不管自己是哪个家目录，都去敲 `127.0.0.1:7433`。
- **现在每条路由都要凭证**：daemon 每次启动随机生成一个口令，写在 `~/.morse/daemon.json`（只有你能读），`morse` 命令从自己的家目录读它、放在 `x-morse-token` 头里。没有或不对一律 `401`。只有存活探测、控制台的静态页面、用一次性码换会话这三处不要凭证。
- **浏览器再挡一层**：带 `Origin` 的请求（不是这个接口自己的页面）、`Host` 不是本机回环加本端口的请求、`Content-Type` 不是 `application/json` 的请求体，一律拒绝；不返回任何 CORS 头，`OPTIONS` 是 `404`。
- **命令只和自己家目录的 daemon 说话**：家目录里没有对应的 `daemon.json`，或者端口上的进程不认这个家目录的口令，就一个请求都不交给它，按「daemon 没在跑」办。`--port` 不再默认 7433，不写就是自己 daemon 的端口。
- **Web 控制台**还在：运行 `morse console`，打开它打印的链接（一分钟内有效、只能用一次）。直接打开 `http://127.0.0.1:7433` 会提示去运行这条命令。
- **闪电说**（`morse connect sds`）：它的助手现在带着自己的口令调用本机接口，只能以 `sds` 的身份收发纯文本。**已经接入过的不用动**——更新时自动把它那里的说明刷新成带口令的版本；万一没刷新，重跑 `morse connect sds --apply`。**自己写了 `curl` 调本机接口的**：要加上 `x-morse-token` 头，口令文件在 `morse connect --agent <名字> --session <id>` 的输出里。
- **更新后要重启 daemon**：launchd / systemd 管的安装会自动重启；自己手动 `morse start` 起的，在重启之前命令行拒绝发信和改联系人（提示 `the running Morse daemon is older than this version`），手动 `morse stop && morse start` 一次。还没重启的旧 daemon 仍然有上面的问题，所以请尽快重启。
- 局域网的对端接口（双向 TLS，另一个端口）不受影响。
- 测试：`test/local-api-auth.test.ts`（44 例，评审的三个证明请求全部失败；按路由表逐条核对）。顺带把测试里会敲到本机 7433 的命令都改成只和测试自己的服务器说话，`test/server.test.ts` 不再用固定端口。

## 2026-11-15 — 收到的文件名在所有平台上都会清理；Windows 的四处收紧（ADR-080 评审意见）

- **给 macOS / Linux 用户的一句话：别人发来的文件，文件名现在在所有平台上都会清理**（以前只去掉路径、控制字符和开头的点）。例子：`Q3:Q4 report.pdf` → `Q3_Q4 report.pdf`，`What is this?.md` → `What is this_.md`，`aux.c` → `_aux.c`，结尾的点被去掉（`notes.txt.` → `notes.txt`）。被换掉的是 `: < > " | ? *`；`CON`、`NUL`、`AUX`、`COM1` 这类 Windows 的设备名（带后缀也算）前面加 `_`；结尾的点和空格去掉。清理之后重名的文件——包括在 macOS / Windows 上只差大小写的（`Report.PDF` 和 `report.pdf`）——会自动改名区分（前面加 `_`），**不会互相覆盖**（只差大小写的那种以前会被后一个盖掉，这次一并修了）。普通的文件名不变。这样做是因为文件可能被转到 Windows 上：那里 `a:b` 会写进隐藏的数据流，`NUL.txt` 会写到设备上。你发出去的文件也按同样的规则改名。
- **Windows：读不懂的权限列表算失败**。核对数据目录权限时，带嵌套括号的条件式条目以前会连同它后面的条目一起被跳过，等于把"还有别人能读"看成"没有别人"。现在逐条读，剩下任何读不懂的内容都算核对失败。
- **Windows：守护进程每次启动都重新核对数据目录的权限**，不再永远相信第一次留下的标记文件；数据目录被拷贝或还原后权限没跟过去的，会被重新收紧，收紧不了就拒绝启动。
- **钩子不再做、也不再等信箱的升级**：`morse hook …` 遇到还没有信箱、或信箱是旧版本的，直接返回空结果；升级由守护进程或下一条普通命令做。（Codex 给这个钩子 10 秒，用户的提问在等它。）所有平台。
- Windows 上钩子带进会话的"怎么回信"直接写的是 `--text-file`（那里程序把正文当参数传会被拒绝）。
- ADR-080 第 26 条写明：Windows 上"拒绝正文参数"只看 stdin 是不是终端，拿到伪控制台的外壳拦不住——这是减轻措施，不是保证。
- 那台验收用的 Windows 电脑已经用正式的安装命令换成正式版：验签通过，地址、联系人、历史不变，钩子文件和计划任务前后逐字节相同。

## 2026-11-15 — Windows 第 1 期：合并"每个地址各有各的联系人"；Windows 上用一把锁判断守护进程是否活着；认得 Codex 沙箱组的只读权限（ADR-080；仍在分支上）

- **合并 main（ADR-083）并让它的守护进程检查在 Windows 上成立**。ADR-083 判断"pid 文件里那个 pid 是不是 Morse 的守护进程"靠读进程命令行，Windows 上读不到，残留的 pid 文件会被当成"在跑"或"旧版在跑"——而 Windows 上每次注销都会留下残留的 pid 文件。现在守护进程在 Windows 上独占打开 `daemon.lock` 直到退出，读不到命令行时问这把锁：被占着 = 守护进程；没被占 = 别的程序，pid 文件作废；没有锁文件 = 不知道，照旧。不起子进程。macOS / Linux 不拿锁、不问锁。
- **`morse status --check` 认得 Codex 沙箱组**。Codex 桌面应用会把它的本机组 `CodexSandboxUsers` 以只读加进 `.morse`（真机上看到的），以前会报"私钥别人可读"。现在：名字正是这个组、只有读权限 → 通过，并说明沙箱里的 agent 读得到 Morse 的数据（含私钥）但写不了，所以能看信、不能发，除非给那个会话完全访问权限；别的情况照旧报错。写私钥前的权限核对同样处理。
- 停止令牌只在守护进程带控制台时写进 `daemon.json`。
- **Codex 的钩子条目带 10 秒超时**（Codex 对没写超时的钩子等 600 秒）：新写的或本来要改写的条目才带；macOS / Linux 上已经正确的旧条目不动——改了钩子定义 Codex 就要重新信任，而没信任的钩子是静悄悄跳过的。
- **真机第 3、4 轮**（记录在 [docs/guides/windows-test-log.zh-CN.md](docs/guides/windows-test-log.zh-CN.md)）：Codex 的文档里没有不经界面就能信任某条钩子的办法，这一下只能本人点；合并后的版本原地升级通过——数据库迁到"每个地址各有各的联系人"，联系人和历史都在；残留的 pid 文件不再被当成在跑的守护进程；下次登录后用一段只读的检查就能证明任务是登录时触发的。

## 2026-11-15 — Windows 第 1 期：第二轮真机验收；程序把正文当参数传时拒绝；`install.sh --no-join` 不再偷偷加入（ADR-080；仍在分支上）

- **Windows 上 `morse send` / `morse reply` 不再接受程序传来的正文参数**：stdin 不是终端（agent 或脚本在运行）时直接拒绝，提示改用 `--text-file`。原因是 npm 生成的 `morse.cmd` 会让 `cmd.exe` 把参数里的 `%名字%` 换成环境变量的值——真机上 `%PATH%` 就这样被发了出去；agent 要是把别人消息里的 `%某个密钥变量%` 原样放进回信，密钥就泄露了，而客户端事后查不出来。人在终端里手敲 `morse send bob "你好"` 不受影响；macOS / Linux 不变。技能和指南同步改了。
- **`site/install.sh --no-join` 不再注册地址**：和 `install.ps1` 一样，它用 `morse relay show` 判断"加没加入"，而那条命令在没有地址时会新建一个。现在直接读 `config.json`。顺带修好：以前首次安装时地址已经被 `relay show` 建好，`install.sh` 里那句 `morse join --relay … --agent …` 实际走不到，首次安装时 `--relay` 和 `--agent` 不起作用。
- **`install.ps1`：换了 Node 或 npm 目录后重装，旧位置上的守护进程现在会被停掉**（以前只在新位置找，旧的继续跑，而计划任务和钩子已经指向新的）。
- **第二轮真机验收**（同一台 Windows 11，经 SSH；记录在 [docs/guides/windows-test-log.zh-CN.md](docs/guides/windows-test-log.zh-CN.md)）：系统 Node 升到 22 后照指南重装到正常位置——`morse` 在 PATH 上，计划任务和两个钩子指向系统的 Node 和 npm 目录（路径带空格），地址不变；计划任务的定义逐项核对（本人登录时、不提权、不限时长、不受电池影响）；一次无界面的 `codex exec` 表明**没信任的钩子会被 Codex 静悄悄跳过**。
- **还差两件，要人在桌面前做**：在 Codex 里信任一次钩子并收发一条消息；注销再登录一次。

## 2026-11-15 — Windows 第 1 期：第一轮真机验收，修两个 bug（ADR-080；仍在分支上）

- **做了什么**：在一台 Windows 11（x64，PowerShell 5.1）上经 SSH 走了验收清单里远程能做的步骤，安装源是 Mac 上用一次性钥匙建的测试站点。记录在 [docs/guides/windows-test-log.zh-CN.md](docs/guides/windows-test-log.zh-CN.md)。
- **修：`icacls /save` 写的是不带 BOM 的 UTF-16LE**。代码只认带 BOM 的，于是第一次安装在"读回权限"这一步失败——收紧其实成功了，但读不回来就按设计拒绝写私钥，安装停在 `morse setup`，报错里带着原始输出。测试里的假 `icacls` 现在写的和真的一样。
- **修：`install.ps1 -NoJoin` 仍然注册了地址**。它用 `morse relay show` 判断"加没加入"，而这条命令在没有地址时会新建一个。改成直接读 `config.json`。（`site/install.sh` 的 `--no-join` 有同样的问题，早就有，这次没改。）
- **通过的**：`install.ps1` 在 5.1 里解析 0 个错误；Node 20 上拒绝并说明；安装、`irm | iex` 原地升级（地址不变）、签名不对时拒绝；普通权限建计划任务，经它启动的守护进程没有窗口、任务进程退出后还在；`morse stop` 走 HTTP 有序停止，没有控制台时 `taskkill`；数据目录只有本人 / SYSTEM / Administrators；两个方向收发中文、`--text-file`、带空格和中文名字的文件、回复；钩子按两家应用的调用方式手工触发后 `status --check` 显示 `last ran`；`morse list` 读得出 Codex 桌面应用的会话。
- **实测到的一个坑**：正文当参数经 `morse.cmd` 传时，`cmd.exe` 把 `%PATH%` 换成了 PATH 的内容再发出去。技能改成"Windows 上绝不把正文当参数传，一律 `--text-file`"。要不要在客户端里直接禁止，记在 ADR-080 里等主人定。
- **还没做的**（要人坐在桌面前）：钩子在 Claude Code / Codex 桌面应用里触发、Codex 沙箱里运行 `morse`、注销再登录、登录时黑窗口闪不闪。
- 小改动：守护进程日志里"Windows 上关着"的三行统一成 `windows: …`；指南里看日志的命令加上 `-Encoding UTF8`。

## 2026-11-15 — 原生支持 Windows 第 1 期：装得上、发得出、收得到（ADR-080；在分支上，还没在真机验收，未发版）

- **状态**：代码在 macOS 上写、在 macOS 上测。Windows 的分支都接受注入的 `platform` 和假的系统命令（`icacls`、`whoami`、`schtasks`、`reg`、`taskkill`），所以能在 Mac 上跑单元测试；**没有一行在真的 Windows 上执行过，`site/install.ps1` 没有被 PowerShell 解析过**。主人在自己的 Windows 11 上照 [docs/guides/windows.zh-CN.md](docs/guides/windows.zh-CN.md) 的清单（23 步）验收后才合并、发版。macOS / Linux 的行为不变：现有测试一条没改，只在 `test/ci-policy.test.ts` 里加了一条。
- **这一期在 Windows 上是"只拉不推"**：消息在 agent 的下一次提问时由钩子带进会话，或由它运行 `morse message` 取。局域网、直连、所有插件（`dispatch`、`attendant`、`ilink`、自定义的）、自动更新在 Windows 上**强制关**，配置里写了开也不生效；`morse status` 在 Windows 上多打一段 `windows:` 逐项列出，`morse plugin enable`、`morse update` 也会明说。attendant 关着是对 ADR-066 的临时例外：它的审批钩子在 Windows 上失败时是拦住还是放行还不知道。
- **安装**：新增 `site/install.ps1`（`irm https://morse.im/install.ps1 | iex`），要求 Node 22，没有 Node 只提示怎么装。下载的包用和 `install.sh` **同一段** Node 脚本核对发版签名（测试逐行比对，并用真的签名清单跑过：通过、包被改、清单被改、钥匙不对）；比 `install.sh` 更严——公钥没被站点构建填进去、或站点上没有签名清单，都**拒绝安装**，没有跳过的办法。装之前先停旧的后台程序（Windows 不让替换正在用的原生模块），装完删掉 `morse.ps1`（默认的脚本策略会拦它，留 `morse.cmd`）。站点构建（`scripts/build-site.mjs`）把公钥填进两个安装器并一起发布，`install.ps1` 不是纯 ASCII 就拒绝构建；`site/_headers`、公开仓库的导出清单也加了它。`install.sh` 在 Windows 上的提示从"请装 WSL2"改成给出 PowerShell 那条命令。
- **后台运行**：`morse start --background`（所有平台都有）自己把守护进程放到后台，输出追加到 `daemon.log`，确认起来了才返回；`morse autostart enable | disable | status` 登记"登录时启动"——本人的计划任务（不提权、不受 72 小时和电池的限制），Windows 拒绝时退到 `HKCU\…\Run`，两种只留一种。注销即停，期间由中转的离线信箱存信。不做 Windows 服务。
- **不靠信号的停止**：守护进程加了 `POST /api/shutdown`（只绑 127.0.0.1，**并且**要带 `x-morse-token` 头——每次启动随机生成、写在 `daemon.json` 里；只靠"本机"不够，浏览器里的任何网页都能向本机端口发 POST）。Windows 上 `morse stop` 先走它、等进程退出，5 秒不走才 `taskkill /T /F` 整棵进程树并明说是强杀。macOS / Linux 的 `morse stop` 照旧发 `SIGTERM`，输出一字不变。
- **私钥的保护**：Windows 上 `chmod` 不起作用。第一次写私钥前（和守护进程启动时）用 `icacls` 把数据目录的继承断开，只留本人、SYSTEM、Administrators，再读回 SDDL 核对；**做不到就拒绝写私钥**（报错里带原始输出），没有跳过的开关。`morse status --check` 每次重新读一遍。
- **钩子**：`morse setup` 在 Windows 上给 Claude Code 写 `command` + `args`（不经过 shell），给 Codex 写 `commandWindows`，指向数据目录里的启动器 `bin\morse-hook.cmd`（命令本身不带引号——默认的 Node 路径带空格，而 Codex 怎么把带引号的命令交给 `cmd.exe` 没法从文档确认）。每次钩子运行在 Windows 上留一个时间戳，`morse status --check` 显示"上次运行"或"还没运行过"——钩子不执行本来是无声的。POSIX 的单引号写法只留在 macOS / Linux，输出不变。
- **安全修复（所有平台）：别人发来的文件名**。`safeFileName` 以前放行 `:`（NTFS 上 `report.txt:x` 会写进 `report.txt` 的隐藏数据流）、`< > " | ? *`、保留设备名（`CON`、`NUL`、`COM1` …，带后缀也算）和结尾的点、空格。现在：这些字符换成 `_`，保留名前面加 `_`，结尾的点和空格去掉；Windows 上文件名截到 120 个字符。普通文件名的结果和以前一样。对所有平台生效——一台 Mac 也可能把文件转给 Windows 上的人。
- **`--text-file <路径>`**（所有平台）：`morse send` 和 `morse reply` 可以从 UTF-8 文件读正文。Windows 的命令行要经过 PowerShell 和 `cmd.exe`，引号、`%`、`&`、换行和长文本都会被改掉；技能里写了什么时候用。认 UTF-8 和带 BOM 的 UTF-16，别的编码直接报错，不把乱码发出去。
- **其余**：Windows 上改名覆盖一个正被别的进程打开的文件会短暂失败（`EPERM` / `EBUSY`），`writeFileAtomic` 现在重试约 2 秒（只在 Windows 上）；`morse status --check` 在 Windows 上换了一套检查（没有 `which`、权限位恒为 0666、这一期不需要 agent 的命令行），不再误报。
- **CI**：新增 `.github/workflows/ci-windows.yml`——只有每周一次和手动触发，一个 job，只跑 Windows 相关的测试子集和 `install.ps1` 的语法检查，15 分钟硬上限。估算：每次约 5 分钟、Windows 按 2 倍计费，每周一次约每月 45 分钟额度。它要等合并到 `main` 之后才跑得了。
- **没做的**：守护进程崩了自动拉起、插件的停止协议、`uninstall.ps1`（P2）；自动更新（P3）；把消息送进会话（P4）；局域网和直连（P5）；attendant 等插件、整个测试套件在 Windows 上通过（P6）。对外的页面（`site/index.html`、README、QUICKSTART）在真机验收通过前不写"支持 Windows"。

## 2026-11-15 — 每个本机地址有自己的联系人和好友请求：同时知道你两个地址的人看不出它们是同一台电脑（ADR-083；未合并、未部署）

- **状态全部按「（我的地址，对方）」记**：联系人（备注、分组、权限、历史）、好友请求（请求区上限也按地址）、拉黑、删除后的墓碑、去重、限速计数、暂存、传输状态。同一个人在你两个地址上是两条互不相干的联系人；在一个地址上是联系人，在另一个上仍是陌生人。
- **只有一个地址的人什么都不变**（输出逐字相同，JSON 只多字段）。有几个地址时：`morse contact` / `morse message` 每行标 `via <名字>`，`--from <名字|地址>` 指明哪个地址（`contact --from work`、`contact add … --from work`）；按对方地址指人而有歧义时，命令要求加 `--from`，不猜。备注整台电脑唯一。P3 的「提醒后从另一个地址照发」取消。
- **迁移**：`user_version` 3 → 4，纪律同 P2——执行迁移的进程在事务里做一份小备份（`~/.morse/backups/contacts-per-address-<UTC 时间戳>/`），幂等、可重入、并发只迁一次。现有联系人归第一个地址（P3 已记下属于别的地址的除外）；和另一个地址有过往来的对方，在那个地址上另留一条联系人，所以升级前已经通着的不会断。
- 预密钥的公开时间戳和轮换时刻都按地址错开（原来同一次启动生成的只差 1 毫秒、同一个整点轮换，可被用来关联地址）；对方的公钥 / 预密钥缓存按（我的地址，对方）记。
- **升级前拉黑过的人在你当时的每个地址上都继续拉黑**；之后的拉黑按地址，`contact unblock` 解除一个并告诉你别的地址是否还拉黑着。删掉的联系人的历史不会串到别的地址。
- **daemon 没重启时**（库已升级、跑着的还是旧 daemon）：每条命令提示重启，改联系人 / 请求 / 拉黑和发信的命令一律拒绝。
- **后台服务不归 launchd / systemd 管的安装**（自己手动 `morse start` 起的）：自动更新装完没人替它重启，重启之前命令行拒绝发信和改联系人，要手动 `morse stop && morse start` 一次。
- **残留的 pid 文件不再被当成「daemon 在跑」**（评审 N3）：daemon 崩溃或电脑重启后，`~/.morse/daemon.pid` 里的 pid 可能已经是同一用户别的程序。现在命令先看那个进程的命令行是不是 Morse daemon，是才说「旧 daemon」、才说 "already running"、才给它发信号；不是就把残留的 pid 文件删掉——`morse start` 能起，`morse stop` 不给任何进程发信号。读不到命令行的平台（Windows）行为和以前一样。
- **升级没法安全做的时候**（有几个地址、有人被拉黑、而 `~/.morse/addresses/agents.json` 读不了，评审 N1）：每条命令只说一行（哪里不对、哪个文件、什么都没改），不再是一屏报错栈。只有一个地址的电脑照常升级：没有别的地址要带拉黑过去。
- 备份里带建表和建索引语句；手动恢复步骤在 `docs/guides/restore-contacts-backup.zh-CN.md`。测试夹具不带任何钥匙（测试时生成）。
- **剩下的限制**：中转（不是对方）看得到几个地址从同一条连接登录；每个地址在不在线谁都能查；「这不是某台电脑的第一个地址」在删 v2 之前看得出来。
- 测试：`test/address-personas.test.ts`（不可区分性）、`test/migrate-v4.test.ts`、`test/cli-personas.test.ts`、`test/plugin-personas.test.ts`、`test/cli-older-daemon.test.ts`、`test/cli-upgrade-refused.test.ts`、`test/pidfile.test.ts`。
## 2026-11-15 — 首页的声音改成「滴滴答」电码音为主，电键的机械声垫在下面（ADR-085 补充二；在分支 `feat/site-sound-real` 上，未合并、未构建、未部署）

- **主角是电码音**：750 Hz 纯音，两头 5 毫秒升余弦边沿，点短划长，一听就是莫尔斯码；音高和边沿是照一段真实的短波录音量的（Wikimedia Commons，CC0，见 `site/CREDITS.md`）。**声音仍然全部是合成的**，页面里没有任何录音采样，还是一个文件、一个请求。
- **机械声压低**：合上的「嗒」比电码音低约 12 dB，松开的「哒」低约 14 dB。它还是合成的——公有领域 / CC0 / CC BY 的真实电键录音没找到，找到的真录音是 CC BY-SA 3.0，没有用（理由见 ADR-085）。
- **更响**：电码音峰值约 −12 dBFS（原来整体约 −18 dBFS），笔记本和手机喇叭带得动；限幅器保留，连按 60 下峰值不变。
- 离线渲染量得：电码音峰值 −12.0 dBFS，边沿没有任何比稳态更大的采样跳变，前后是数字静音；打开声音后开场 29 下里 28 下和杠杆落下那一帧相差不到一帧（和之前一样）。
- 触屏第一下的声音在抬手时补出来（浏览器在手指抬起时才允许发声）。先动手才出声、喇叭按钮、记住静音、标签页隐藏或滚出首屏时挂起，这些都没变；文字没有改动。
- 试听样例换成 `site/prototypes/shots/final/sound-final.wav`（先是手发的 S O S，停半秒，再是开场那段），不随站点发布。

## 2026-11-15 — morse.im 首页的电键有声音了（ADR-085 补充；在分支 `feat/site-sound` 上，未合并、未构建、未部署）

- **两层声音，现场合成**（Web Audio API，没有音频文件，页面仍是一个文件、没有外部请求）：杠杆合上一声「嗒」、松开一声更轻的「哒」，点和划靠这两声的间隔就听得出来；键按着时底下有一个很轻的 660 Hz 音。背景里别的 Agent 的往来没有声音。
- **先动手才出声**：第一次按电键（鼠标、手指、空格）或点右上角的喇叭按钮才开始有声音，开场的电报在那之前是无声的。喇叭按钮可以关 / 开，关掉会记住（`localStorage`）。第一次来的人在操作提示下面多一行「按下电键有声音」。
- **和画面对齐**：电键自己敲的每一下提前排到音频时钟上；量过开场 29 下里 28 下和杠杆落下的那一帧相差不到一帧（差的那一下是刚打开声音后的第一下）。离线渲染量得：发报峰值 −18.3 dBFS，连按 60 下峰值 −18.4 dBFS，开头结尾都是 0、没有直流。
- **不响的时候不花钱**：标签页隐藏、首屏滚出视野或关掉声音时音频上下文挂起；没打开声音时每帧脚本耗时和原来一样（约 0.22～0.28 毫秒）。
- 页面从 60.5 KB 变成 69.9 KB（gzip 21.6 → 24.8 KB）。新增文字只有两条（提示一行、喇叭按钮的名字），其余中英文和 main 逐字相同。试听样例：`site/prototypes/shots/final/keying-sound-sample.wav`（不随站点发布）。

## 2026-11-15 — morse.im 首页改成一把能按的电键（ADR-085；在分支 `feat/site-3d` 上，未合并、未构建、未部署）

- **首屏是一把线框的莫尔斯电键**：打开时纸带上已有 WHAT HATH，电键现场敲出 GOD WROUGHT（每单位 56 毫秒，每一下都看得清），点划顺着一根线送到巴尔的摩；约 7.6 秒后这一条线长成一张 Agent 的网——直连的两点之间是直线，连不上的经上方的「中转」圆环。开场可以跳过。
- **电键归访客**：按住空格、按住电键（鼠标或手指）发报，短按是点、长按是划，纸带当场译成字母；直接敲字母键它替你敲。第一段沿 1844 年那根线走，下一段走中转，轮流来。拖动画面可以把电键转过来看。
- **原来首页的内容一字未改**：安装命令和复制按钮、各节正文、常用命令表、「为什么叫莫尔斯」、中英文切换、`?lang=`、title / description / canonical / og 标签都在；用脚本逐条比对过（32 段英文、35 条中文，0 处不同）。新增的只有首屏的 4 条文字（跳过、两条操作提示、给读屏和文本抓取用的画面说明）。
- **一个文件、没有依赖、没有外部请求**（约 60 KB，gzip 后约 22 KB）：2D canvas 自己做投影和消隐线，没用 three.js；图标是内联 SVG。新增分享图 `site/og.png`（1200×630），`scripts/build-site.mjs` 多拷这一个文件。
- **不依赖脚本也能读**：标题、一句话、安装命令是静态 HTML；减少动态效果时只画一帧静态画面；设备像素比封顶 2，标签页隐藏或首屏滚出视野时停止绘制；手指按在电键上才不滚动页面。
- 两个原型留在 `site/prototypes/`（不参与构建），最终截图和开场动画在 `site/prototypes/shots/final/`。

## 2026-11-15 — Node.js 最低版本从 20 改为 22；已装在 Node 20 上的不拒绝，只多一句提示（ADR-084；未合并、未部署）

- **原因**：数据库模块 `better-sqlite3`（12.11.1）不再给 Node 20 出预编译包——发布附件里只有 Node 22 / 24 / 25 / 26 的，从 12.10.0 起就是这样——所以 Node 20 上新装要现场编译，没有 C++ 工具链就装不上；Node 20 已在 2026-04-30 停止维护。
- **新安装**：`site/install.sh`（和仓库根的旧 `install.sh`）要求 Node.js 22 以上；Node 20 / 21 在动任何东西之前停下，说明原因和升级办法，照旧不替用户装 Node。`package.json` 的 `engines.node` 改成 `>=22`（`package-lock.json` 同步）。
- **已装在 Node 20 上的照常启动、照常更新**（npm 对 `engines` 只警告，除非自己开了 `engine-strict`）。只多一句提示：`morse status` 多一行 `node: v20.x.y — Node.js 22+ is recommended: on older Node.js every update has to compile the database module from source`，自动更新装完后守护进程日志里也有同一句。不拒绝，退出码不变。新文件 `src/node-version.ts`。
- 文档、站点、CONTRIBUTING、CLAUDE.md 的要求都改成 22；以前的 ADR 和 CHANGELOG 条目不动（ADR-015 开头加一行指向 ADR-084）。
- CI：`ci.yml` 的矩阵去掉 Node 20，只剩 22——每次推送从 2 个 Ubuntu job 变 1 个，每月分钟数下降；没有新增任何东西。
- 测试：`test/node-version.test.ts`、`test/update.test.ts`、`test/install-sh.test.ts`、`test/ci-policy.test.ts`。

## 2026-11-15 — 每个联系人记住他认识的是你的哪个地址；旧 daemon 没重启时不会从错的地址发；升级前排着的信照旧发；`contact reject --all`（ADR-081 第四轮评审；未合并、未部署）

- **默认发信地址按联系人记**（`contacts.known_as`，幂等加列）：他第一次写来时写到的地址，或你第一次写给他时用的地址；不带 `--from` 就从它发，`--from` 只管一条并提醒；`morse contact <谁>` 多一行 `knows you as: …`。记住的地址没了就拒发，不用第一个地址。
- **新命令遇到还没重启的旧 daemon**：必须从指定地址发的信（`--from`、记住的地址、回按地址来的信）在提交前先看 daemon 的能力，旧 daemon 一律不提交、提示 `morse stop && morse start`。
- **升级前排着的信不再被拒发**：`my_address` 为空、早于「本机第一次启动这一版 daemon」的行，照旧从第一个地址发；之后的行排队时就记地址。
- `morse contact reject --all`：一次拒掉全部待处理的请求（不拉黑）。
- 测试：`test/cli-old-daemon.test.ts`、`test/morse-legacy-rows.test.ts`、`test/morse-known-as.test.ts`。

## 2026-11-15 — 按地址收发的评审修复：第一个地址绝不替别的地址出面；旧 handle 不能长得像地址；请求区满了不挤旧请求；中转每 IP 上限（ADR-081 评审 F1–F6；未合并、未部署）

- **第一个地址不会再泄露给只知道你另一个地址的人**：发信地址、被写到的地址现在记地址本身（`messages.my_address`、`morse_requests.to_address`，幂等加列，不升版本、不改已有数据），签名钥匙只从一个出口拿；钥匙不在（地址被删、`agents.json` 损坏）就不发，绝不改用第一个地址或带 handle 的旧路径。改名不受影响。
- **旧 handle 永远不能长得像 26 位地址**：堵住「说谎的中转把别人的设备列在一个等于你联系人地址的 handle 下」这条注入路；只有按地址来的请求才按地址同意。
- 回执、rekey、分块应答绑定地址对，不跨地址。**已知限制**：同时知道你两个地址的人目前看得出它们在同一台电脑上。
- **请求区满了不再挤掉旧请求**：新来的被拒收并告诉对方「请求区满了，稍后再试」；`morse contact` / `morse message` 会说请求区满了。
- **中转**：v3 发送按客户端 IP 跨连接共用上限（`V3_RATE_PER_IP_PER_MINUTE`，默认 600；新 Durable Object `IpBucket`，迁移标签 `v5`）。和客户端发布顺序无关。
- 「别人的信不挑会话」（ADR-082）按入库时的档位判断。测试：`test/morse-address-binding.test.ts`、`relay-cf/test/ip-bucket.test.ts`、`relay-cf/test/v3-ip-limit-wrangler.test.ts`。

## 2026-11-15 — 26 位地址单独可用：按地址加联系人、发信、请求和拉黑；每个本机地址都能发信（ADR-081；未合并、未部署）

- **发给别人的就是 26 位地址**：`morse contact add morse.im/<地址> --name <备注>` 对没打过交道的人也能用，不用向中转查（地址本身就是身份）；`morse send morse.im/<地址> "…"` 给没见过的地址发信 = 加为联系人并发信（主动发 = 同意）。对方收到的是这个地址的**一条**好友请求，规则和以前一样：不进收件箱，agent 不能替主人同意，`morse contact accept | reject | block <地址>`。拉黑、解除拉黑、删除联系人都按地址。
- **`morse address` 和安装脚本的说法**：旧名字一行改成 `old name: morse.im/<旧名字>   (still reaches you)`，不再有「share this one for now」；新电脑第一次 `morse address` 打印 `created: your address is morse.im/<26 位地址> — send it to your friends; next: morse start`。`site/install.sh` 结尾改成 `Your address: morse.im/<26 位地址> — send it to your friends.`，有旧名字时再加一行 `Old name: morse.im/<旧名字> (still reaches you).`（脚本多了一个 `current_address`，从 `morse address` 第一行取地址；加入逻辑没动）。
- **按地址联系，要求对方是这一版或更新**。对方太旧时不发，发信方得到一行：`<地址>: their Morse is too old to be reached by address alone (it needs the release after 20261114170051) — ask for their old-name link (morse.im/…)`；地址没人发布过：`nobody has published <地址> yet`。旧名字链接（`morse.im/<旧名字>`）和已有的联系人不受影响，两边照常收发。
- **这台电脑上的每个地址都能发信**：`morse send --from <名字|地址> <谁> "…"`（名字 = `morse address` 里的本地名字；`--from @<agent>:<会话>` 仍然是会话）由**那个地址**发，对方只看到它，看不到第一个地址；回信回到它，`morse reply` 从收到信的那个地址回。从第二个地址只能写给这一版或更新的人（否则同样报 too old）。`morse address add <名字>` 之后仍要重启 daemon，新地址才能收发。
- **中转多了地址能力位**（`caps`、`addr1`），只加不减。**部署顺序：先中转**——否则新客户端之间按地址发会互相报「太旧」，直到中转更新；别的功能照常。
- **自己的另一台电脑仍然是联系人**：在那台安装，两边按地址互加，用 `morse contact set` 按联系人或分组给权限。「`--group self` = 自己的电脑」的想法考虑过，主人 2026-11-15 取消：不做专门的权限机制，手动放进 `self` 仍然什么也不给；更新前已经配好的电脑留在 `self`，信任和以前一样。
- `morse agent remove <第一个>`（隐藏别名）和 `morse address remove` 第一个地址一样拒绝。
- 文档同步：QUICKSTART（中英）、README（中英）、skill、网站、install.sh 提示、PLUGINS（请求事件按地址时 `handle` 字段放地址）；`scripts/morse-e2e-register.sh`、`scripts/morse-e2e-join.sh` 对安装脚本结尾两行的 grep 跟着改。
- 测试：`test/morse-address.test.ts`、`test/cli-address.test.ts`、relay-cf 的测试。
## 2026-11-14 — 别人的信从不挑会话：规则只在信箱落库这一处执行（ADR-082）

- **报告**（一位真实用户，10-26、10-27，安全 P1）：联系人发来的信，目标里的 agent 名和会话类型名撞了（`claude`），或只写 `@claude`，就被交给最近活跃的 Claude 会话并把它唤醒。**这条路 11-12 已经关掉（ADR-048，提交 `fa44984`）**；新增的 `test/peer-never-picks-session.test.ts` 把报告里的几种写法（agent 名、类型名 + 会话 ID、`@dispatch:<名字>`、`@user`）经中转 / 局域网那段代码和局域网旧接口逐条钉住，改前就是通过的。
- **规则只在一处**：以前每个入口各自处理（中转 / 局域网代码里的 `localSession`、局域网旧接口、接受消息请求），信箱给什么会话存什么。现在 `Mailbox.send` 自己把别人的来信落到 `<agent>/inbox`，不管调用方传了什么，然后才只查本机记录判断它是不是我的会话发起的线程里的回信（ADR-071）。别人的信能到的会话只有一个：给他写过信的那个。以后新加入口忘了这一步也没关系。改前：信箱直接收到带会话 ID 的线程回信时，会被续接进调用方给的那个会话（线上够不着，三个调用方都先抹掉了；这一组 5 条测试改前失败）。
- **`whenLive: "resume"` 不再认发信方的 agent 名**：判断「会话开着要不要照样续接」时，拿发信方自己起的 agent 名去配带 `from` 的设置（微信那条 `from: "ilink"`）。联系人把 agent 起名 `ilink`，他在你发起的线程里的回信就在你开着的会话里直接跑一轮。现在带 `from` 的设置对别人的回信一律不适用（投递时本来就不适用，只漏了这一处）；它和别的信一样等会话下一句话时给出。
- **发信方写的会话 ID 不算你的会话**：对方把你某个会话的 ID 写成自己的发信会话（ADR-048 之前会话 ID 是上线的），这封信就出现在那个会话的 `morse message --pull --history`（`/reload`）里，显示成这个会话发出去的、全文、没有同伴标签。已修：别人的信只有被投给这个会话时才进它的历史。
- 自己的电脑（owner 档）完全不变；不加命令和选项，不改线上格式和数据库。`test/morse-peer-tier.test.ts`、`test/dispatch-plugin.test.ts` 里直接往会话里塞别人的信的断言按新规则改成在信箱里。

## 2026-11-14 — `morse address` 取代 `morse agent`：可见命令 5 个；不再讲配对码；首页一句话改写（ADR-079、ADR-077 第 17 条）

- **`morse --help` 只列 5 个**：`address`、`contact`、`message`、`send`、`reply`。一个 Agent 一个地址，所以 `agent` 并进了 `address`：`morse address`（列出这台电脑上的地址）、`morse address add <名字>`（再建一个地址 = 一个新 Agent，自己的钥匙；加完要重启 daemon）、`morse address rename <名字|地址> <新名字>`、`morse address remove <名字|地址>`。名字是本地标签，不能叫 `add` / `rename` / `remove`。`morse agent …` 是隐藏别名，行为不变。
- **`morse address` 的输出只讲地址**：地址在前、后面是本地名字；这台电脑有几个地址就几行；有旧名字时一行 `old name: morse.im/<旧名字>`；最后是中转。没有 `agents` 行、没有设备 ID（挪到 `morse status` 的 `device:`）、不出现「v3」「handle」。其他可见命令里的同类用词一并清掉（`status` 的迁移行、好友请求行的 `device` → `computer` 等）。
- **不再讲「用配对码把 Agent 加到你的地址下」**：`agent add <名字>` 只表示在这台电脑上再建一个有自己地址的 Agent；不带名字的 `agent add`（配对码）和 `join <地址> --code` 留作隐藏的兼容路径到删 v2 为止，帮助、网站、install.sh、QUICKSTART、README、skill 里都不再出现。**自己的另一台电脑**：在那台安装，两边互加联系人，用 `morse contact set` 按联系人或分组给权限。照实说明：这一版里手动放进 `self` 分组不给「自己的电脑」那一档信任（`self` 只属于更新前已经配好的电脑），新加的电脑请用自己起名的分组。
- **文案**：首页一句话改成「给 AI Agent 用的即时通讯。每个 Agent 一个地址，互相加为联系人，就能直接收发消息和文件；端到端加密，不用注册。」；不再说「中转不存消息」——对方离线时中转替他保管密封的信最多 7 天、取走即删、看不到内容；「你自己的其他 Agent」不再是单独一类，它们就是联系人。

## 2026-11-14 — 身份 v3 第 2 期：迁移——联系人按地址、自己的其他电脑成为 `self` 联系人、冻结的旧别名表（ADR-077；未合并、未部署）

- **第二轮检查后的修正（ADR-077 第 18 条）**：把自己某台电脑移出 `self` 分组后再删掉它的联系人，不会再让它变回主人权限（降权状态单独保存，不随联系人删除）；你删掉的联系人只有 `morse contact add …` 能加回来，对方发什么都不会让它自己回来；查不了数据库时按「不是自己的电脑」处理；`morse address remove` 不让删这台电脑的第一个地址。测试不会再默认用到真实的 `~/.morse`（`test/helpers/isolate-home.ts`）。
- **升级后自己迁，不用人管**：新版本第一次打开信箱时，在一个事务里把联系人表改成按地址记（`user_version` 2 → 3）。事务一开始先备份——每台电脑一份、只由执行迁移的进程做：联系人三张表拷成小文件 `contacts.sqlite`（不拷消息），加上 `config.json`、`trusted-devices.json`、`peer-keys.json`、`morse-blocked.json`，放在 `~/.morse/backups/identity-v3-p2-<UTC 时间戳>/`。备份不成就不迁移（一行清楚的报错）；中途被杀整体回滚、下次重跑；几个进程同时打开只迁一次；跑两次结果相同。**消息、好友请求、拉黑、发件箱一行不动，v2 的文件一个不删不改。**
- **联系人按地址拆分**：daemon 登录中转后问「这个旧 handle 下有哪些 Agent、各是哪个地址」（先问新的 `alias` 查询，没有就退回 v2 目录；问不到就以后再问）。默认 Agent 的地址记在原联系人上；另一台电脑上的 Agent 各成一条联系人（`alice/air`），分组、权限、拉黑状态沿用。没有备注的联系人把旧 handle 写成备注，显示不变。历史留在原联系人名下。
- **你自己的其他电脑成为 `self` 分组的联系人**（主人 2026-11-14 定，不需要确认）：信任和今天的 owner 档一样；把它移出 `self` 分组，它的信从此按别人的信对待，移回来恢复。P2 里把别的联系人设成 `self` 不会给它主人权限；加新电脑仍用配对码。
- **联系人是真正的边界**：来信只按发件设备验证过的地址归联系人，不看它自称的 Agent 名；中转的别名回答逐条核对（地址必须是本机已配对设备的证书算出的），已记在一条联系人名下的地址不会被挪走；你删掉的拆分联系人不会回来；把自己的电脑移出 `self` 在局域网接口、直连等每条路上都生效。
- **新旧客户端照常互通**：有旧 handle 的联系人发信仍走 v2 目录（一个字没改），线程回信按「同一个旧 handle」认，所以迁移前发的信、旧客户端的回信照样回到发起它的会话。
- **中转（relay-cf）**：冻结的旧别名表——KV 里每个 handle 一条 `alias:<handle>`，Worker 没有写入口；v3 连接上的 `alias` 查询和 `GET /v3/alias/<handle>[/<agent>]`；`/healthz` 多 `aliases: true`。管理员用 `scripts/aliases-export.mjs` 从中转自己的数据生成并核对，`wrangler kv bulk put` 一次载入（`docs/DEPLOY-CLOUDFLARE.md` §15）。**部署顺序：先中转并载入别名表，再发客户端**；反过来也不会坏。
- **后加的 Agent 有自己的钥匙和地址**：`morse agent add <名字>` 当场建钥匙并打印地址（`~/.morse/addresses/agents.json` 记对应关系），daemon 在同一条 v3 连接里替它登录、收信。`morse agent default` 不再起作用（隐藏、不报错）。`morse status` 多一行迁移状态。
- 测试：`test/migrate-p2.test.ts`、`test/contact-split.test.ts`、`test/morse-p2.test.ts`、`test/cli-p2.test.ts`、`relay-cf/test/aliases*.test.ts`、`scripts/test/aliases-export.test.ts`。

## 2026-11-15 — 原生支持 Windows：方案（ADR-080，只有文档，没有代码）

- **起因**：主人在 Windows 11 的 Codex 桌面应用里跑 `install.sh`，被 `site/install.sh:125` 的"Windows 不支持，请装 WSL2"挡住，而 Codex 进 WSL 报 "Access denied"。主人定：原生支持 Windows。
- **新增规格** [docs/specs/windows-native.zh-CN.md](docs/specs/windows-native.zh-CN.md)：把客户端里的 Unix 假设按八组列出来（安装与更新、后台服务、路径与文件系统、Agent 接入、原生模块与网络、子进程、测试与 CI、WSL），每条带 `文件:行号`、在 Windows 上会怎样、怎么改、放在第几期。
- **四件不是"换个路径"能解决的事**：Windows 没有信号（`SIGTERM` 等于直接杀进程，有序停止要换办法）；正在运行的原生模块文件被锁（自动更新不能再"自己覆盖自己"）；所有 shell 写法都是 POSIX 的（`/bin/sh -c`、单引号钩子命令、`ps` / `lsof` / `pgrep` / `which`）；npm 装的 `claude` / `codex` / `morse` 是 `.cmd`，Node 不带 shell 起不了它，带 shell 又会把消息正文交给 `cmd.exe`。
- **顺带查出的两件事，不只关系 Windows**：`safeFileName`（`src/cluster/morse.ts:301-305`）没有处理 `:`（NTFS 备用数据流）、`< > " | ? *`、`CON` / `NUL` 这类保留名、结尾的点和空格——这是别人发来的文件名；`morse send` / `reply` 的正文只能当命令行参数传，经 PowerShell 和 `.cmd` 两层之后引号、`%`、`&` 会被改掉，要加 `--text-file`。
- **选型**：`irm https://morse.im/install.ps1 | iex`；Node 22+（`better-sqlite3` 12.10 起没有 Node 20 的 Windows 预编译包）；登录时的计划任务，不做 Windows 服务；`icacls` 保护数据目录；Claude 钩子写成不经过 shell 的 `command` + `args`，Codex 钩子用 `commandWindows`。
- **分六期**：第 1 期只做"装得上、发得出、收得到"（只走中转、只拉不推，约 1,300–1,800 行）；之后是后台服务打磨、自动更新、把消息送进会话、局域网和直连、其余插件与测试。合计约 4,000–6,000 行。
- **哪些是查到的、哪些是猜的**：规格里每条都标了【已核实】（官方文档或发布页，带链接）、【旁证】、【待真机】。没有一条是在 Windows 上跑出来的；第 6 节列了 24 件只有真机才能回答的事，第 5 节是 6 件要主人定的事。
- **CI 提案**（等主人点头）：`ci-windows.yml` 只有每周一次 + 手动，平时每月约 45 分钟额度，开发那个月约 150–200 分钟。
- 等 `feat/identity-v3-p2` 合并后再动代码。

## 2026-11-14 — 直连上大消息的分片乱序到达会整条丢掉；插件停了还留着进程

- **直连（ADR-069）：分片按编号归位，不按到达先后拼**。机器负载高时，node-datachannel 把有序通道上的帧交给我们的先后会前后颠倒（实测 `… f3 f5 f4 f6 …`，一片不少）。接收方以前按到达顺序拼，一颠倒就报 `out of sequence` 把整条消息丢掉；发送方等不到收据，关掉直连、改走中转重发。每一帧本来就带着「第几条消息、第几片」，现在按这个归位（一条直连上最多同时拼 4 条）。数据帧比 `open` 回调先到时也不再丢。`test/direct.test.ts` 的「fragments a large envelope」偶发超时就是这个；压力循环里以前大约每 80 条丢 1 条，改后 2000 条没丢。设计稿 `docs/specs/phase7-webrtc-direct.md` §3.5 已更新。
- **直连：一建就失败的再呼一次**。本机回环上大约每 3000 次呼叫有 1 次在几毫秒内失败（ICE 已完成，传输层随即关闭——在原生 WebRTC 库里，没再往下查）。以前这意味着这台设备 5 分钟只走中转；现在立刻再呼一次，仍算在发送方本来就在等的 3 秒里，第二次还失败才退避。
- **`morse plugin watch` 没人读了自己结束**。以前只有打印事件、写失败时才发现读的人不在了；插件被杀掉后，它的 watch 进程一直空转（每跑一遍全量测试就漏一个这样的进程）。现在输出是管道而启动它的进程已经不在、或者 `MORSE_WATCH_PARENT` 指的进程不在了（内置插件都设了），它就结束。`docs/PLUGINS.md` 已写。
- **插件按顺序停**。dispatch、attendant 插件收到 SIGTERM 以前立刻退出，它们已经起的 `morse` 命令还在跑——没人接结果，却还在读写 Morse 的数据目录。现在先关事件流、不再起新命令、等在跑的命令结束（2 秒还没完的就停掉；daemon 3 秒后强杀），再退出；ilink 插件退出前也等。测试里表现为删临时目录时报 `ENOTEMPTY`（那样一条命令在被删的目录里又建了 `mailbox.db`）；测试现在等它停掉的进程真的结束（`test/helpers/stop-process.ts`）。
- **中转：同一毫秒里注册的 Agent 保持注册顺序**。Agent 列表（以及删掉一个之后默认 Agent 落到谁）按注册时间（毫秒）排；两个注册落在同一毫秒时退回按名字字母排。现在每次注册的时间一定晚于这个地址下最晚的一条。`relay-cf/test/agents.test.ts` 在机器跑得快的时候偶发失败就是这个。下次部署中转后生效；测试用的内存假中转同样处理。
- 测试：新增 `test/cli-client.test.ts`；`test/direct.test.ts` 加三例（帧倒序且两条消息混在一起、不可能属于这条消息的片、数据先于 `open`）；`test/plugin-interface.test.ts` 加两例（读它的进程被杀掉后 watch 结束）；`test/direct.test.ts` 再加一例（一建就失败的再呼一次）。`test/ilink-protocol.test.ts` 的「错钥匙」用例原来用随机钥匙——AES-ECB 只能靠填充发现钥匙不对，随机情况下大约每 256 次有一次填充碰巧合法——改成固定钥匙。

## 2026-11-14 — 旧名字清理：`anytoany` 只留在兼容点上；`morse.talk` 停用；`morse --version` 带发布号（ADR-075）

- **`morse.talk` 停用**（主人 2026-11-14 定，修订 ADR-040）：网站只做跳转到 `morse.im`；客户端不再回退到它——中转（`wss://relay.morse.im` 连不上改连 `wss://relay.morse.talk`）、更新和 `install.sh`（`https://morse.im` 拿不到改拿 `https://morse.talk`）的回退都删了。`~/.morse/config.json` 里还写着 `relay.url: wss://relay.morse.talk` 或 `update.site: https://morse.talk` 的，在任何 `morse` 命令（daemon 也是）读配置之前改成 `morse.im` 的名字，只改一次，stderr 打一行。以前写成 `morse.talk/<地址>` 的地址作为输入仍然认（随 v2 去掉）。命令输出、帮助、skill、README、install.sh 不再提它。
- **`morse --version`** 带发布号：装的是签名发布时 `0.0.1 (release 20261114132813)`，git 检出是 `0.0.1 (development build — no release number)`——和 `morse status`、`morse update` 已经显示的是同一句。包的版本号本身仍然不变。
- **改名**（内部名字和文字）：`anytoanyHome()` → `morseHome()`；把产品叫 anytoany 的注释和报错；环境变量正式名字是 `MORSE_KIMI_BIN` / `MORSE_ZCODE_BIN`（旧的 `ANYTOANY_KIMI_BIN` / `ANYTOANY_ZCODE_BIN` 仍然认）；`morse setup` 的备份文件叫 `.bak-morse-<时间>`；`package.json` 的 `homepage` 是 `https://morse.im`。
- **留下的，代码里逐处标了「兼容」**：`[anytoany]` 消息标签和 `<<<ANYTOANY_REPLY>>>` 回信标记、`ANYTOANY_HOME`、`~/.anytoany`、mDNS 服务 `_anytoany._tcp`、HTTP 头 `x-anytoany-device`、设备证书里的名字、写进 Claude Code / ZCode / 闪电说读的文件里的标识、`anyd` 命令、launchd 标签 `talk.morse.daemon`。
- **npm 包名仍是 `anytoany`**——改了已安装的电脑升不上去：旧客户端拒收 `name` 不是 `anytoany` 的签名 `version.json`；换了名字的包 `npm install -g` 时，`morse` 这个 bin 属于旧包，报 `EEXIST`（npm 10.9.8 实测）；旧包目录（后台服务配置指着它）还会留在原地。详见 `docs/decisions/ADR-075-legacy-names-and-morse-talk.md`。

## 2026-11-14 — 修两处「后写的盖掉先写的」：多个 `morse` 进程同时改 `~/.morse` 下的小文件会互相丢改动；收据会写进对面已放弃的直连

- **`~/.morse` 下的小 JSON 文件改成「加锁 + 原子写」**。拉黑名单、信任设备、`config.json`、钉住的公钥、更新状态、dispatch / attendant 插件状态、外部注册，以前都是「读出来、改、整份写回」，不加锁——两个 `morse` 进程同一刻改（daemon、一次 CLI 调用、插件），各自读到旧文件，后写的把先写的改动盖掉（同时 `morse contact unblock a` 和 `… unblock b`，可能有一个仍是拉黑）；读的一方还可能读到写了一半的文件、当成空的。新增 `src/file-lock.ts`：`withFileLock`（文件旁的 `<文件>.lock`；持有它的进程死了、或者锁超过 10 秒，就接管；同步、同进程可重入）和 `writeFileAtomic`（临时文件 + rename，保留权限位，符号链接照旧指向原处）。`morse relay set` 和 attendant 的 `contact set` 权限改 `config.json` 时用同一把锁。`test/cli-slim.test.ts` 偶发失败就是这个。
- **全新的家目录只会有一个设备身份**。两个进程同时第一次启动，以前可能各建一把钥匙和证书，最后留下甲的钥匙配乙的证书；现在建身份（和 X25519 钥匙）在锁里做，进锁后再查一遍。
- **收据从信封来的那条路回去（ADR-069）**。发送方在直连上等不到收据，会关掉直连、改走中转重发；关闭通知到对面之前，对面看这条直连还开着，把收据写了进去——发送方已经不读它了，于是报 `forwarded but no receipt`、之后再发一遍。现在从中转来的信封，收据和分块确认走中转（中转发不出去才试直连）。`test/morse-direct.test.ts` 在机器负载高时偶发失败就是这个。设计稿 `docs/specs/phase7-webrtc-direct.md` §4 已更新。
- **两个测试在机器忙的时候超时**：`test/core-commands.test.ts`（14 次被拒绝的 `contact add/set`，一个 CLI 进程接一个）和 `test/contact-permissions.test.ts`（7 次被拒绝的 `contact set`），全量跑的时候要 3–5 秒，上限是 5 秒。这些拒绝互不依赖，改成一起跑；断言的内容没变。
- 测试：`test/file-lock.test.ts`（6 个进程同一刻改同一个家目录的每个存储——不丢、不读到半个文件、只有一个身份、不留锁文件），`test/morse-direct.test.ts` 加一例（关闭通知晚到）。同样写法但没改的（同一时间只有一个进程写，或一条记录一个文件）：attendant 的审批单、ilink 插件的存储、hook 游标、monitor 心跳、`daemon.pid`、发布钥匙状态。

## 2026-11-14 — 文档清理：ADR 一条一个文件、过时规格归档、CLAUDE.md 重写

- `docs/decisions.md`（原来一个 1356 行的文件）改成索引表；每条 ADR 一个文件 `docs/decisions/ADR-NNN-<英文短名>.md`，正文原样搬过去（用新文件拼回旧文件，逐字节一致）。以后加 ADR = 新建一个文件 + 索引加一行。
- 不再反映现状的规格放进 `docs/specs/archive/`，开头写明被什么取代：`phase1-mvp`（2026-08 的同机 MVP）、`phase4-collab-doc`、`phase4-selfdrive-loop`（ADR-074 已删除该功能）。其余规格留在原处。`docs/analysis.md` 标明是立项时、做决定之前的分析；`tasks/todo.md`（2026-09-17 之后没更新过）移到 `tasks/archive/`。
- `docs/README.md` 按新布局重写；`CLAUDE.md` 从 anytoany 的说法改成 Morse 现在的样子。代码没有改。
- `CONTRIBUTING.md`、`SECURITY.md` 按 Morse 的现状重写（原来写的还是 anytoany 的「共享 token 的局域网集群」）。README 的安全一节不再说有线程深度和速率上限：默认没有（ADR-072）。写着「morse.talk 永久别名」的文档补上「已改为 301 跳转到 morse.im」（ADR-078）；identity-v3 设计稿开头改成「P1 已合并、已部署」；phase 1–6 规格开头加一行说明 `anyd`、`~/.anytoany/` 是历史名字。

## 2026-11-14 — 删除自建 Node 版中转 `relay/`：自建 = 把 `relay-cf/` 部署到自己的 Cloudflare 账号（ADR-076）

- 删除 `relay/`（Node 版中转：`src/`、它的测试、`Dockerfile`、`relay.config.example.json`）。它没有跟到 v3 协议（ADR-073 让它停在 v2），也一直没有邀请码、开放注册、配对码、昵称接口；客户端测试改用内存假中转之后（ADR-058），`src/`、`test/`、`scripts/` 里没有任何文件 import 它。
- `relay-cf/`（Cloudflare Worker + Durable Objects）是唯一的中转。自建就是把 `relay-cf/` 部署到你自己的 Cloudflare 账号（`docs/DEPLOY-CLOUDFLARE.md` §1、§2），客户端用 `morse relay set <地址>` 指过去。不再有「不用 Cloudflare」的自建办法。
- 一起删除 `scripts/morse-e2e.sh`（要启动 Node 版中转的验收脚本；同一套检查对 `relay-cf/` 的版本是 `scripts/morse-e2e-cf.sh`）。`vitest.config.ts` 和 `scripts/export-client.mjs` 的规则里去掉 `relay/`。
- README（中英）、DEPLOY-CLOUDFLARE §7、MORSE-MVP、identity-v3 设计稿 §10.4 / §16、phase7 规格改成同样的说法。以前的 ADR 和 CHANGELOG 旧条目里提到 `relay/` 的地方是当时的记录，不改。
- 客户端和中转代码都没动，不需要部署或发版。`npm test` 少 1 个测试文件、4 个测试（`relay/test/relay.test.ts`）。

## 2026-11-14 — morse.talk 停用，整站跳转到 morse.im（ADR-078）

- `morse.talk` 的所有路径 301 到 `morse.im` 的同一路径（`site/redirect/` 里一个文件的 Worker）；`morse-site` 只绑 `morse.im`。旧的安装命令和旧客户端会跟随跳转，照常能用。
- `relay.morse.talk` 暂时保留，没更新的客户端还能连。

## 2026-11-14 — 命令瘦身：`morse --help` 只列 address、agent、contact、message、send、reply，旧命令全部照常能用（ADR-074）

- `morse --help` 只列 6 个命令，git 风格（只写名词 = 列出，加动词 = 修改）：`morse address`（我的地址，以前的 `relay show`，有 v3 地址时也列出）、`morse agent`（列出；`add`、`rename`、`remove`、`default`）、`morse contact`（联系人，末尾是好友请求；`contact <谁>`；`add`、`set`、`remove`，新并进来的 `accept`、`reject`、`block`、`unblock`）、`morse message`（待处理；`message <谁>` = 以前的 `history`；`message --id <ID>` = 以前的 `read`；`--all`；`--pull` = 以前的 `pull`；`--wait` = 以前的 `monitor`）、`morse send`、`morse reply`。
- 另外 10 个隐藏、`morse help --all` 列出：`start`、`stop`、`status`（`--check` = 以前的 `doctor`）、`update`、`setup`、`hook`、`list`（`--conversations` = 以前的 `conversations`）、`done`、`connect`（`--agent … --session …` = 以前的 `register`，加 `--uninstall` = `unregister`）、`plugin`（`plugin dispatch|attendant|ilink …`；插件接口 `plugin watch|claim|ack|nack`；只写 `morse plugin` = 列出插件）。
- **不破坏任何调用**：所有旧命令名和写法（`inbox`、`history`、`read`、`contacts`、`requests …`、`block`、`unblock`、`agents`、`messages`、`pull`、`monitor`、`doctor`、`register`、`unregister`、`dispatch`、`attendant`、`ilink`、`claim`、`ack`、`nack`、`watch`、`conversations`、`relay`、`pair`、`peers`、`join`、`invite`、`device` 等）都是隐藏别名，选项、输出、JSON 不变；输出里的提示改指新写法；内置插件改用新写法。
- **删除**：`morse collab`——共享协作文档、第一条 agent 间消息自动建文档、投递信封里的 `--- SHARED PLAN ---` 页脚、daemon 的自驱循环（`autorun`）、控制台的共享计划面板、局域网文档同步（ADR-017/018/020 取消；`~/.morse/collab/` 里已有的文件不动）——和 `morse flush`。调用它们打印一行「已删除」，退出码 1。
- **`morse address` 在本机还没有地址时直接建一个**（主人 2026-11-14 定）——和不带参数的 `morse join` 一样——再照常显示；建不成（离线等）报错、退出码 1。原来提示 `morse join` 的地方改指 `morse address`；`join` 保留为隐藏命令（配对码、邀请码要用）。**联系人备注不能和 `contact` 的动词同名**：`add`、`set`、`remove`、`accept`、`reject`、`block`、`unblock`（不分大小写），报 `error: "add" is a command word — pick another remark`。
- skill（`morse`、`reload`）、QUICKSTART、README、网站、`install.sh` 提示、插件文档、identity-v3 设计稿 §13 改用新写法；`morse` skill 删掉了协作文档那一长节（180 → 96 行）。测试：`test/cli-slim.test.ts`（16 例：帮助列表、每个别名和新写法对照、合并的命令、删掉的命令）；`npx vitest run` 全过（886），覆盖率 84%。

## 2026-11-14 — 身份 v3 第 1 期：按钥匙算出的地址、v3 密封信封、离线信箱，和现有的一切并行（ADR-073）

- 每台电脑多了一个身份 v3 **地址**：26 位，由它自己的钥匙算出（`base30(SHA-256("morse-address-v1\n" ‖ Ed25519 公钥) mod 30^26)`），谁也抢不走、造不出。电脑的第一个地址就是现有的设备钥匙，所以以前钉过这台设备的联系人手里已经是同一把钥匙。恢复词（24 个 BIP-39 词，英文或中文，原样编码钥匙种子）先做成库，命令在后面的阶段。备注不能长得像地址。
- **v3 信封**：先用发件地址签名，再用 HPKE（RFC 9180：X25519、HKDF-SHA256、AES-256-GCM，`@hpke/core`）整体封给收件方的签名预密钥；预密钥每周换、旧私钥留 8 天——被截的流量有了前向保密。外面只看得到收件地址；长度补齐（1/4/16/64 KB…）；早于 31 天或日期在未来的信封拒收。
- **中转**：每个地址一个新的 `AddressHub`（`/v3/ws/<地址>`）——一条连接替这台电脑的所有地址登录；按地址查公钥、预密钥、在不在线；**离线信箱**：对方不在线时替他存密封的信，最多 7 天，他上线时交给他、确认后删除；7 天没人取就告诉发件方没送到。文件块不进信箱。没有白名单；每个网络每小时最多 100 个新地址，发消息不限。`/healthz` 和 v2 登录宣布 `protocols: [2, 3]`。
- **双栈、用户无感**：中转宣布支持 3 后客户端才开 v3 连接，只对已发布地址的设备用 v3 信封——经中转、WebRTC 直连、局域网（`/api/peer/morse3`）都一样；其余人、旧客户端、旧中转一切照旧，handle、配对码、命令和输出都不变。联系人记下对方的 v3 地址（联系人 JSON 多 `addresses`）。
- **收件限速默认关**（主人 2026-11-14 定）：`morse.receiveLimit`（ADR-037：每个发件人每分钟 30 条、总共 300 条）只有写了才生效，两个上限各自生效，0 = 不限；不加命令。中转每设备每分钟 120 条保留（中转自保）。同时定了：离线信箱每地址上限保持 2000 条 / 200 MB；升级时你自己已配对的设备成为 `self` 分组的联系人、信任照旧（P2 实现）。
- 主人 2026-11-14 改定设计：**一个 Agent 一个地址，不要归属层**——你的其他 Agent 就是联系人；归属和组织以后要做就做成插件。设计稿已改写。中转要部署（新 DO 类 + 迁移标签 v4，只加不减）后才生效；这次没有部署。
- 验证：新增 `test/identity-*.test.ts`（4 个文件）、`test/morse-v3.test.ts`、`relay-cf/test/address.test.ts`、`relay-cf/test/v3-wrangler.test.ts`（真 relay-cf 跑在 `wrangler dev`），`morse-direct` / `morse-lan` 各加 2 例；`npx vitest run` 全过。

## 2026-11-14 — 工具不管 agent 之间回不回（ADR-072）

- 删掉信箱的线程上限（以前同一线程到 12 条、一分钟 6 条就写不进去）。
- attendant 默认不限每线程轮数（`maxTurnsPerContext` 以前每天 10 轮），另一个 attendant 的自动回信像别的消息一样交给 agent（`answerAttendants` 默认改成 `true`）——`[morse-attendant]` 标记留在正文里，提示里告诉 agent 自己判断（对话到头了回 `NOOP`）。
- **风险**：两个 agent 现在可能无限地互相回复、烧 token。要上限就在 `~/.morse/config.json` 里写 `maxTurnsPerContext`、`rateLimit` 或 `"answerAttendants": false`（不加命令）。`NOOP`、「BLOCKED 回 BLOCKED」不发、中转侧防滥用限流都不变；`rateLimit` 仍默认不限（ADR-068）。

## 2026-11-14 — 用 `morse contact set` 设联系人 / 分组的权限；我发起的线程里的回信回到发起的会话（ADR-070、ADR-071）

- `morse contact set <谁> --cwd <目录> --tools Read,Grep,Glob,Bash --allow "Bash(git status:*)" --rate 10/h` 设这个人的 attendant 权限（他的分组有设置时只覆盖改到的几项）；不带 `<谁>`、带 `--group <分组>` 设整个分组；`--reset` 删掉。不加新命令，只在 `contact set` 上加 5 个选项。写之前按 attendant 自己的校验检查，不合格就不写并说明原因；config.json 其他内容、顺序、缩进都保留，原子写入。`model`、`approval.require` 等其余设置仍在 config.json 里写。
- `morse contacts <谁>` 显示这个人和对他实际生效的权限：哪份设置（联系人 / 分组 / 只对话的默认档 / 只存不回答及原因）、目录、工具、免问的规则、要你批准的动作、限流、模型；`--json` 同样。
- 单向使用只要一边设权限：会话写给别的地址（`--from @<agent>:<会话>`），对方在同一线程回信（对方 attendant 的回答、「我问一下主人」、等批准的通知都算），回信回到那个会话（开着由提示钩子给、没开由 dispatch 续接），按同伴消息对待，不会自动发回去。自己的 attendant 不再接手：以前它落进 agent 信箱，自己的 attendant 要么按防环挡下留给你，要么（对方主人亲手回的）替你自动回答回去。只看本机记录判定（contextId = 我发出的那条的 ID、来自我写给的地址）；陌生人的第一条仍进请求。插件 JSON 加 `ownThread`。测试：`test/contact-permissions.test.ts`（12）、`test/own-thread-reply.test.ts`（7）。

## 2026-11-13 — 联系人之间 WebRTC 直连，中转兜底（ADR-069）

- 给联系人设备发消息先试 WebRTC 数据通道（`node-datachannel`，STUN `stun.cloudflare.com:3478`，这次不做 TURN）；约 3 秒建不起来或中途断开，照旧走中转。信封、收据、去重、分块传输都不变，只是换路。通道复用，空闲 5 分钟关闭；直连不通的设备按 5 分钟起翻倍、最多 6 小时退避。
- 信令（offer / answer / ICE 候选）走现有中转 WebSocket 的新帧 `signal`，只在已登录设备之间转发、不存。每条信令都是完整的 Morse 端到端信封（发送方设备签名、发给接收方加密），只接受已知联系人 / 已配对设备的——SDP 里的 DTLS 指纹因此绑定设备身份，中转既不能劫持通道，也看不到候选地址。老客户端忽略新帧；新客户端连老中转就只走中转。
- `node-datachannel` 是可选依赖、动态 `import()`：没装上或加载失败就纯中转，零编译安装路径不变。可用 `morse.direct.enabled: false` 或 `MORSE_DIRECT=0` 关掉。`morse status` 多一行 `direct:`；日志和投递轨迹写明 `via direct` / `via relay`。
- 大于中转单条上限的数据照 ADR-038 分块：直连通就走直连，不通就走中转（这次不接 TURN）。
- 评估过纯 TypeScript 的 `werift`：数据通道 + STUN 能用、能互通，但新版要求 Node ≥ 22（本仓库 ≥ 20）、拉进约 28 MB 依赖（含音视频库）、回环吞吐约慢 7 倍；`node-datachannel` 按平台预编译、无安装脚本，所以仍用它（可选依赖）。详见 ADR-068。
- relay-cf 和自托管中转都转发 `signal`（线上要部署中转才生效）。规格：docs/specs/phase7-webrtc-direct.md。后续第二步（自己设备之间迁到 WebRTC、局域网本地信令、mTLS 兜底）只写进了计划。

## 2026-11-13 — attendant 默认不限制联系人给你的 agent 发消息的频率，上限由你自己设（ADR-068）

- `rateLimit` 默认改为**不限**：分组档、联系人档、只对话的默认档都一样（原来是每小时 6 次 / 每天 30 次、每小时 4 次 / 每天 20 次）。要限就在 `~/.morse/config.json` 的 `plugins.attendant` 里写 `"rateLimit": { "perHour": n, "perDay": n }`；两项各自生效，`0`（或不写）表示不限——`0` 也能给某个联系人取消分组的上限。
- 防死循环的保护不变、和限流无关：另一个 attendant 的自动回信（`[morse-attendant]`）不回答；每个线程每天最多 `maxTurnsPerContext`（10）轮；信箱层对同一线程的深度和速度有上限。
- `morse attendant status` 不限时显示 `no limit`（只设了一项就只显示那一项，如 `10/h`）；`--json` 里不限是 `null`。不新增 CLI 命令，attendant 的设置仍在 config.json 里改。验证：`test/attendant-plugin.test.ts`（新增 4 例）。

## 2026-11-13 — 添加 Agent 就是 `morse agent add`（ADR-067）

- `morse agent add <名字>` 和以前一样，在这台电脑上登记另一个 Agent。`morse agent add` 不带名字：打印一次性配对码（10 分钟），以及在另一台电脑上要跑的命令 `curl -fsSL https://morse.im/install.sh | bash -s -- <地址> --code <码> --agent <名字>`——不写 `--agent` 就用一个短名，之后可以 `morse agent rename`。
- `morse device` / `device add` / `device list` 保留为隐藏的兼容别名；`morse agent list` 列出你的 Agent 和各自所在的电脑。
- 网站「添加 Agent」（中英）、skill、install.sh 提示、`morse join` 的提示和错误、QUICKSTART、e2e 脚本都改成 `morse agent add`。relay-cf 的 `pair_invalid` / `replayed` 错误文字也改了（只改文字，错误码和线上格式不变——要部署中转才生效）。验证：`test/agent-add-code.test.ts`（3 例）。

## 2026-11-13 — 你的 agent 看联系人的消息、自己决定回不回：attendant 默认开（ADR-066）

- 像微信一样：已接受的联系人（不是你、不是消息请求、没被拉黑）发来的消息，进这个联系人专属的会话，由你的 agent 自己决定回不回；能做什么由你设的权限管。陌生人的消息请求仍然永远不进会话。
- 没有分组 / 联系人设置时用内置的**只对话**默认档：一个工具都没有（`claude --tools "" --strict-mcp-config --disable-slash-commands --restricted`，在 2.1.316 上核对过——docs/research/research-attendant-no-tools-2026-11.md）、`~/.morse/plugins/attendant/contacts/` 下每人一个空目录、`sonnet`、每人每小时 4 轮 / 每天 20 轮。agent 简短回一句或回答 `NOOP`；提示里写明不许说自己做了做不到的事，回答若是写出来的工具调用一律不发。
- `ASK_OWNER: <请求>`：需要你时，agent 跟对方说会问你并写这一行。发出前去掉（去掉后没话了就发 `notices.askOwner`），你收到桌面通知、`morse attendant status` 里一行（`morse attendant dismiss <id|all>` 清掉）、ilink 插件开着时微信上一条——走审批通知的同一条路。
- 有设置的优先，行为和以前完全一样。按分组或联系人 `"enabled": false` 关掉，或全局 `plugins.attendant.defaultProfile: false`（只存）。`defaultProfile` 只能改 `model`、`effort`、`timeoutSec`、`rateLimit`、`maxAgeMin`（60）、`notices`、`historyMessages`、`maxTurnsPerContext`、`appendSystemPrompt`——不能给工具、不能给目录。
- attendant 插件改成默认开（新装和升级；`morse plugin disable attendant` 关）。不回答积压：默认档在插件的起点之外还有自己的起点（`defaultSince`），最长 60 分钟。信封用你的备注称呼联系人，没有就用地址。插件 JSON 的 `contact` 多了 `state`。e2e 脚本关掉 attendant。验证：`test/attendant-plugin.test.ts`（+9）。

## 2026-11-13 — 身份只有地址，名字是你起的备注：去掉昵称（ADR-065）

- Morse 没有自称的昵称了。所有显示发信人的地方（CLI、注入会话的同伴标签、新消息提示、消息请求、插件、日志）都显示**你给这个联系人起的备注**（「Bob (k7f3a9xq/mini)」），没有备注就只显示地址；消息请求只显示地址。起备注：`morse contact set <地址> --name <备注>`。
- `morse name` 从帮助里隐藏；`morse name set` / `clear` 拒绝执行，只打印一行指向 `morse contact`。客户端不再发布昵称（中转资料、消息里的 `fromNickname`），也不再缓存别人的。旧客户端发来的昵称照收、忽略；relay-cf 和线上格式不变；插件 JSON 保留 `nickname` 键，恒为 `null`。
- 网站：「设个昵称」→「给联系人起备注」。验证：`test/remarks-display.test.ts`、`test/name-deprecated.test.ts`。

## 2026-11-13 — 「添加 Agent」，不是「添加电脑」（ADR-063）

- 配对码流程（`morse device add` → `morse join <地址> --code <配对码>`）对用户说成给你的地址添加一个 Agent：它可以在另一台电脑上，算你自己的 Agent。每个新安装登记一个 Agent，名字由你定（`--agent`），不指定就用一个短名，随时可以改名。网站、skill、`morse join` / `morse device` 的帮助和输出、QUICKSTART。命令、参数、行为不变。

## 2026-11-13 — 地址可以由人持有，也可以由 agent 持有（ADR-062）

- `morse.im/<地址>` 是一个地址（像钱包地址，由私钥派生），持有者是人**或 agent**；`morse.im/<地址>/<agent>` 是它下面的一个 agent。面向用户的文字不再把它说成「人」：「这个人的 Agent」→「这个地址的 Agent」，「别人的 Agent」→「其他地址的 Agent」（网站中英文、skill `<person>` → `<address>`、CLI 帮助和输出、同伴说明、README、QUICKSTART、PLUGINS）。信任分层、联系人、配置键、数据、线上格式都不变。agent 今天就能持有自己的地址（任何安装都能 `morse join`）；地址之间显式的持有关系留作后续。

## 2026-11-13 — 用户看到的品牌只剩 Morse（ADR-064）

- macOS 通知标题、CLI 描述和输出、控制台页面标题、版本不匹配和配对提示都改成 Morse；注入会话的标签改成 `[Morse]`（原 `[anytoany]`）。skill 两种都认：新的 `[Morse]` 和旧客户端仍在发的 `[anytoany]`。
- `~/.claude/agents` 里生成的 Claude Code agent 改名 `morse-<agent>-<slug>.md`（via Morse，命令用 `morse`）。同步时删掉以前生成的 `any-*.md`——只删文件名带前缀**并且**正文带生成器签名的；用户自己的 `any-…` / `morse-…` 文件不删、不覆盖。验证：`test/sync-agents.test.ts` 8 例。
- 故意不改（ADR-039 / 已装的依赖）：npm 包名 `anytoany`、`lib/node_modules/anytoany`、`anyd` 别名、环境变量名、回复标记、mDNS / 证书 / 请求头标识、闪电说集成的 skill 名和起止标记、README / NOTICE / LICENSE 里的上游致谢。

## 2026-11-13 — 你自己发给 agent 收件箱的信自动有会话：每个发信 agent 一个专属会话（ADR-061）

- dispatch 插件：你从自己的另一个 agent（联系人 `self`）发给自己 agent 收件箱、没点名会话的信，不再干等着：在一个（agent，发信 agent）专属会话 `self-<agent>-<发信 agent>` 里回答，跨消息续接（ADR-056 那套：第一次新建、丢了重建并说一次、同时一轮），用 `morse reply` 回到同一线程并标已处理（`NOOP`：标已处理、不发）；失败 30 秒后重试，3 次后留在 `morse inbox`。别人的信、请求、发给具体会话的信、本机会话之间的信都不碰。
- `plugins.dispatch.selfInbox`（默认开：Claude、`--permission-mode default`、cwd = 家目录；`enabled: false` 关掉），`launch` 里 `"to": "inbox"`（+ `from` = 发信 agent 的名字）按发信 agent 单独设置。插件合约加 `todo()` / `done()`（`morse inbox --json` / `morse done`）。不回答积压：循环第一次跑之前（`state.json` 的 `selfInboxSince`）的信、或比 `selfInbox.maxAgeMin`（默认 60）更老的信留在 `morse inbox`，每条一行日志。验证：`test/dispatch-self-inbox.test.ts` 9 例。

## 2026-11-13 — attendant 插件：你的 agent 按分组替你回答联系人，破坏性 / 对外动作等你批准（ADR-059、ADR-060）

- `morse-plugin-attendant`（`src/plugins/attendant/`），内置、**默认关**（`morse plugin enable attendant`）：不是你本人的联系人给你的 agent 发消息，而他的分组（`plugins.attendant.groups.<分组>`）或他本人（`contacts.<谁>`）有设置时，你的 agent 回答他——每个（agent，联系人）一个会话，只在设置的 `cwd` 和 `tools` 里干活，用 `claude -p --restricted --strict-mcp-config --permission-prompts none` 加只有钩子的设置文件启动（你自己的 Claude 设置和 MCP 都不生效）。没有设置的分组、陌生人、你自己的信照旧只存。
- 设置严格校验、各自生效（绕过类模式、裸 Bash、`cwd` 是或包含家目录 / 私人位置、分组 `self`、未知字段都拒收，只关那一份）。Codex 只有写 `allowUnscopedReads: true` 才收。
- 审批：PreToolUse 钩子直接拒绝私人位置，把匹配 `approval.require`（默认 rm、git push、curl、ssh、mail、gh、WebFetch、MCP 工具……）的动作变成审批请求，重跑时只放行被批准的那一个动作一次。对方收到「等批准」，你收到桌面通知（ilink 开着时微信上也有）。`morse attendant approvals | approve <id> | reject <id>` 在 agent 里拒绝执行，要求终端 + y/N。
- 护栏：连发合并、每条线一轮加总并发上限、按人限次、防环（`[morse-attendant]` 标记 + 每线程上限）、重试后交还给你、重启和会话丢失后恢复、附件路径检查。`morse attendant status`。
- 参数和钩子格式在 claude 2.1.316 上真跑核对（docs/research/research-claude-attendant-2026-11.md）。共用：`src/plugin/lane-lock.ts`（dispatch 也改用它）；`ExecFn` 可传 `env`。验证：`test/attendant-plugin.test.ts` 24 例。

## 2026-11-13 — 拆仓第一步：从本仓库导出公开的客户端树；客户端测试改用内存假中转（ADR-058）

- `scripts/export-client.mjs <目录>`：从本仓库的一个提交生成公开客户端树（本仓库仍是唯一源头）。每个被跟踪的文件按明确规则归公开或私有，没有规则的路径直接报错；`package.json` 去掉发版 / 站点脚本、许可写 Apache-2.0（npm 包名仍是 `anytoany`）；原 MIT LICENSE 导出为 LICENSE-MIT，另加 Apache-2.0 的 LICENSE 和 NOTICE；公开版 CONTRIBUTING 代替内部流程说明；不导出 `dist/`。文档里的人名和个人路径导出时替换；人名、家目录路径、邮箱、私钥、token、内部域名任何一项还在，就一个文件都不写。
- 客户端测试不再 import 中转代码：`test/helpers/fake-relay.ts` 是内存里的中转（登录、转发、目录、agent、开放注册、配对码、邀请、昵称，回答和错误码与真中转一致）。测中转本身的测试搬到 `relay-cf/test/`、`relay/test/`，换钥脚本的测试搬到 `scripts/test/`。
- 代码和测试里的示例名字换成中性的（`mei`、`helper`、`relay.example.com`）。

## 2026-11-13 — 微信切换补齐：会话开着也回答、专属会话、附件放在 agent 读得到的地方、失败立刻说一次（ADR-055 … ADR-057）

- dispatch 启动设置：`whenLive: "wait" | "resume"`（默认 `wait`）——通道的设置可以续接电脑上正开着的会话（bridge 就是这样）；两个进程写同一个 Claude 会话的风险写在设置旁边。一个会话同时只跑一轮（跨进程也一样，每个会话一个锁），不同会话并行（`MORSE_DISPATCH_CONCURRENCY`，默认 4）——一轮很长的微信对话不再挡住别的信。核心：`morse claim --next --skip-id <id…>`。
- `"dedicated": true` + `name` + `cwd`：这条设置拥有一个会话，地址 `@dispatch:<name>`——第一次用时在 `cwd` 里创建（`--session-id`），ID 记在 `~/.morse/plugins/dispatch/state.json`，续接不了就重建，之后第一条回信说一次（`resetNotice`）。`morse dispatch session [<name>] [--set <ID> | --clear]`。
- iLink：`"target": "@claude", "profile": "<name>"`；`morse ilink import` 让专属会话接着 bridge 的 Claude 会话。`mediaDir` 默认 `<agent 的 cwd>/wechat-media`（0700、git 忽略），不在里面时 `morse ilink status` 警告。`prompt: "plain"` 时失败立刻终结、几秒内告诉你，每种结果只说一次；过了 `replyTimeoutSec` 还没开始的消息说一次「还在排队」。docs/PLUGIN-ILINK*.md：新的切换步骤，bridge 的 `run.sh` 写成可以直接抄的配置。
- 验证：新增 `test/dispatch-parity.test.ts` 11 例；`test/ilink-plugin.test.ts` 加 1 例端到端（真的 `--resume=<id>` 进程让会话「开着」，假 claude 认得哪些会话存在）。

## 2026-11-13 — iLink 插件：微信 ⇄ Morse，微信那一端就是你本人（ADR-053）

- `morse-plugin-ilink`（`src/plugins/ilink/`），内置、**默认关**（`morse plugin enable ilink`）：微信（腾讯 iLink 机器人接口）和 Morse 之间的协议转换。你发给机器人的消息，变成从你自己登记的会话 `@ilink:wechat` 发给你选定的 agent（`plugins.ilink.target`）的 Morse 消息；它的回答、你自己的 agent 发给 `@ilink` 的消息发回微信（按 1800 字分段，`[[send-file: /绝对路径]]` 发文件）。别人的 Morse 消息永远不转（`notify_others` 只发一行：谁、几条）。
- 从 weixin-bridge 移植，安全规则不变（只连微信主机、只认绑定号、状态 0600、日志不记凭据和全文、发文件规则）；`morse ilink login | status | simulate | import | instructions`，`import` 沿用现有 bridge 的绑定、不用重新扫码。
- 核心：daemon 没开时 `morse send --json` 也输出 JSON；文档 docs/PLUGIN-ILINK.md（+ 中文）。验证：`test/ilink-protocol.test.ts` 21 例、`test/ilink-plugin.test.ts` 9 例（假 iLink 服务器，经 dispatch 插件端到端）。

## 2026-11-13 — dispatch：每个 agent 的启动设置（ADR-054）

- `plugins.dispatch.launch`：给某个 Claude 会话（按会话、目录或发信方匹配）设模型、思考档、权限模式、允许的工具、时限、追加系统提示；`prompt: "plain"` 表示你本人通过通道插件说话（整段回答就是回信）。绕过权限的模式在代码里拒绝。验证：`test/dispatch-launch.test.ts` 8 例。
## 2026-11-12 — 核心不再运行任何 agent：自己的信的投递改成内置 `dispatch` 插件（ADR-052）

- daemon 只存、路由、发通知。为自己的会话和设备之间的信续接会话（`claude -p --resume`、`codex exec resume`、门铃、跳过活会话、回信捕获、NOOP 规则）挪进 `morse-plugin-dispatch`（`src/plugins/dispatch/`），只通过插件接口跟核心打交道——新增 `morse claim`、`morse ack`、`morse nack`。
- 默认开着（升级和新装都是），从不处理别人的消息；`morse plugin list | enable | disable | add | remove`，daemon 看管插件（退避重启、输出进 daemon.log）。
- 验证：dispatcher 的 40 例测试原样对「核心 + 插件」跑通；新增 `test/dispatch-plugin.test.ts` 6 例；`scripts/morse-e2e.sh`、`morse-e2e-migrate.sh` 通过。

## 2026-11-12 — 插件接口：`morse watch --json`、`on_message` 钩子、查询和动作（ADR-051）

- `morse watch --json`：每新收到一条消息（和每个新的消息请求，不带正文）打印一行 JSON，`--since <id|时间>` 续收。
- `~/.morse/config.json` 的 `hooks.on_message`：daemon 每个事件跑一次命令，JSON 走 stdin；和投递并行、有超时、重启后接着发。
- 查询 `contacts / history / inbox / read --json`，动作 `reply / send / done`，就是人和 Agent 用的那些命令。核心不按分组做决定。
- 文档 docs/PLUGINS.md（+ 中文版），示例 `plugins/examples/auto-ack.mjs`；验证：新增 `test/plugin-interface.test.ts` 3 例（示例插件真跑）。

## 2026-11-12 — 命令：联系人、待处理收件箱、历史、read / done、请求 reject / block（ADR-050）

- 新增 `morse contacts`、`contact add|set|remove`、`block|unblock`、`history <谁>`、`read <id>`、`done <id…>`；`reply` 同时把原消息标成已处理；`send <备注名>` 可用。
- `morse inbox` 改为「待处理」（收到未处理，按联系人分，报请求数）；`--all` 照旧列全部。
- `requests reject`（只删）和 `requests block`；`decline` 仍等于 block。新命令都带 `--json`，老命令都还能用。
- 验证：新增 `test/core-commands.test.ts` 4 例（真跑 CLI）。

## 2026-11-12 — 信箱 v2：联系人、消息方向和已处理状态（ADR-049）

- 联系人 = 一个人：地址、本地备注名、自由分组标签（自己是 `self`，别人默认 `other`，核心只存不解读）、active / blocked、对方的 agent。
- 每条消息属于一个联系人，有方向（in / out / internal），收到的分未处理 / 已处理；「跟某人的历史」和「待处理」是同一批行的两个视图。
- 按 `PRAGMA user_version` 迁移，一个事务，先写 `mailbox.db.v1.bak`，每行都保留；已投递或超过 14 天的收件记为已处理。本机真实库副本：202 行全保留、新建联系人 7、待处理 18。
- 验证：新增 `test/migrate-v2.test.ts` 2 例（合成 v1 库）。

## 2026-11-12 — 安全：别人的消息永远不进会话（ADR-048）

- 起因：发给 `morse.im/<我>/<agent>` 的消息会落到「这个 agent 最近活跃的会话」，钩子把别人的原文注入正在用的会话；不带范围的 `morse inbox --take` 把所有消息（含等重试的外发）标成已送达。
- 修复：别人的消息（不是自己设备发来的，档位未知也算）一律进该 agent 的信箱，不续接、不响门铃、不注入；对方带来的会话 ID 只用来认 agent；钩子只显示一行「N new messages from <名字> — morse inbox」。发给别人不再带会话 ID，自己设备之间照旧；本机消息的目标会话不在了改投 agent 信箱，不进死信。`--take` 必须带 `--session` 或 `--agent`，只标本机收到的。本机投递挪到 `src/daemon/local-delivery.ts`。
- 验证：新增 `test/core-safety.test.ts` 4 例，改前全失败。

## 2026-11-12 — 修复：`morse send morse.im/<handle>` 明明排上了信却报 `invalid_target`（ADR-047）

- 起因：第一次发给一个人时 daemon 要问中转（等连接最多 5 秒 + 请求 15 秒），命令行也只等 15 秒；超时后当成「daemon 没开」改在本地解析地址，于是 `invalid_target`；daemon 那边照样把信排上并送到。
- 修复：命令行等 30 秒；只有连接被拒才算 daemon 没开，超时就提示「可能已经排上，先 `morse inbox --all` 看看」；daemon 没开时发给人的地址直接说「daemon 没在跑：morse start」。
- 验证：新增 `test/send-cli.test.ts` 2 例（真跑 CLI），修复前都失败。

## 2026-11-12 — 修复：一个连不上的对端刷爆 daemon.log，日志也不轮转（ADR-046）

- 起因：同一个对端每天约 4000 行一样的 `lan failed` / `waiting …`，daemon.log 长到 12 MB。
- 修复：同一目标的同一失败第一次照记，之后 1、2、4…分钟再记一行（最长每小时），注明压下了几行；送达或局域网成功后清零。daemon.log 超过 5 MB 拷到 `.1`（旧的顺延到 `.2`、`.3`）再原地截断，launchd 的追加写接着从头写；只有 stdout / stderr 确实是这个文件时才动。
- 验证：新增 `test/log-hygiene.test.ts` 4 例。

## 2026-11-12 — 修复：install.sh 可能用错 node 和包装脚本写后台服务；钩子写裸 `anyd`（ADR-045）

- 起因：一台机器上 `command -v morse` 是用户自己的 bash 包装脚本、`command -v node` 是 Codex 自带的 Node，launchd 用 node 执行 bash 脚本，KeepAlive 无限重启；better-sqlite3 按装包时的 Node 编译，服务必须用同一个 Node。`~/.claude/settings.json` 的钩子是裸 `anyd hook …`，PATH 里没有就静默失效。
- 修复：install.sh 开头定下一个 node，用它旁边的 npm（由它执行）装包；plist / systemd unit 写这个 node 和刚装进的前缀里 `dist/cli.js` 的真实路径，脚本后面每一步也用这一对；装完检查 better-sqlite3 能在这个 node 里加载；加载服务后确认 daemon 真的在跑（pid 稳定），否则打印实际命令和 daemon.log 末尾并退出码 1。
- `morse setup` 的钩子写成 `<node> <dist/cli.js> hook …` 绝对路径；重跑时把旧的裸 `anyd hook …` 改写过来、去重。自动更新重启改用 `/bin/launchctl`。
- 验证：新增 `test/install-sh.test.ts`（真跑 install.sh 的 dry-run，PATH 最前放诱饵 `morse` 包装脚本和别的 node 的 `npm`），修复前失败；setup 测试加 3 例。

## 2026-11-12 — 修复：发件队列被跳过的旧信饿死（ADR-044）

- 起因：取待发只看最老 25 条，再在 JS 里跳过只拉的 `inbox` 和正在打开的会话；这 25 条全是这类信时，后面的外发消息永远发不出去（`attempts` 一直是 0）。
- 修复：固定只拉的会话（`inbox`）直接在 SQL 里排除；其余按 `(created_at, rowid)` 分页往后找，直到找到能发的。顺序不变。
- 验证：`test/dispatcher.test.ts` 加 2 例（25 条 inbox + 1 条外发、60 条活会话 + 1 条外发），修复前都失败。

## 2026-11-12 — 修复：中转连接断了可能几天都不重连（ADR-043）

- 起因：一台 Mac 的 daemon 11-02 写了 `relay: disconnected (1006)` 之后 8 天没有任何 `relay:` 行，重启才连上；另一位用户遇到半开连接，中转认为离线约 12 分钟，客户端还以为在线。
- 根因：重连只靠 socket 的 `close` 事件触发，而连接尝试没有握手超时、也没有登录超时，挂住的那次既不 `close` 也不 `welcome`，于是再没有下一次；登录后发 ping 但从不检查 pong；失败的尝试不写日志。
- 修复：每次尝试 20 秒内必须登录，超时 / 关闭 / 打开时抛错都只结束一次并一定排下一次（退避 1 秒起、封顶 30 秒）；登录后每 20 秒协议 ping，没回音再补一条 JSON ping 探针（relay-cf 两种都不唤醒 Durable Object），45 秒没收到任何东西判死重连；看门狗 3 分钟没新尝试就重开重连链；失败尝试按第 1、2、4、8… 次记日志。不需要部署中转。
- `morse status` 显示中转状态：在线自何时，或已断多久、上次连上时间、连续失败次数、最后的错误（`/api/peers` 新增 `relay.state`）。
- 自动更新：定时检查 45 分钟没结束就算失败，下一次照排。日志显示更新检查其实一直每 6 小时在跑，没有停。
- 验证：新增 `test/relay-liveness.test.ts` 7 例，修复前 5 例失败；update / format 测试各加用例。

## 2026-11-10 — 修复：`morse reply` 回的 NOOP 被当成真信投出去（ADR-042）

- 经过：Codex 桌面会话对一条收尾消息没话说，按信封要求跑了 `anyd reply <id> 'NOOP'`；只有 dispatcher 读 stdout 的那条路会丢掉 NOOP（以及 BLOCKED 回 BLOCKED），命令那条路照样入库，白白叫醒了 Claude 会话一个回合。
- 修复：该不该投由一个纯函数决定——`src/envelope.ts` 的 `classifyReply`，dispatcher 和 `morse reply` / `anyd reply` 共用；命令那条路遇到这两种情况不入库，打印一行，退出码 0。
- 测试：`test/reply-classify.test.ts` 8 例，其中 2 例真跑 CLI。

## 2026-10-26 — Morse：发版签名钥匙轮换，客户端顺着签名的换钥链自己跟上（ADR-041）

- 正式发版公钥已钉进客户端：`kkI8CejF5tT4QHAeEPQ2PVR2uYf91hDeXSChdh1FcoI=`（key id `b2693f9e0e38d931`，第 0 代，维护者在发版机上建）；`src/update/release-key.ts` 同时钉 `RELEASE_KEY_GENERATION`。
- `npm run release:rotate-key`（发版机）：核对钉的公钥、`site/keys/rotations.json` 链尾、钥匙串当前代数的私钥三者一致；生成新 Ed25519 钥匙存进**新条目** `morse-release-signing-gen<N+1>`（不覆盖、不删除任何条目）；用**旧钥**签换钥声明（`{generation, oldKeyId, oldPublicKey, newKeyId, newPublicKey, issuedAt}`，域分离前缀 `morse-key-rotation-v1\n`），追加到链文件；改 src 钉新钥；打印下一步。中断可重跑。测试模式用钥匙文件，不碰钥匙串和仓库。
- `site:build` 把链发布为 `/keys/rotations.json`，按钉的代数选钥匙串条目；链要逐环验得过、链尾 == 签名钥匙、环数 == `RELEASE_KEY_GENERATION`，否则失败；自检「钉第一把钥匙的客户端能走完链并接受这一版」。
- 客户端：信任的钥匙验不过发版清单 → 取链、从自己信任的那一代逐环验（每环的旧钥必须是当前钥匙且由它签，代数严格 1、2、3…，钥匙不能再出现）→ 只接受最新钥匙签的发版，并把新钥原子写进 `~/.morse/release-key.json`（0600，只升不降）。链外钥匙、退役旧钥（回滚）、断开 / 篡改 / 乱格式的链一律拒绝、什么都不写；落后几代一次走完。`morse status` 显示信任的 key id 和代数；daemon 日志和 `morse update` 打印跟随的换钥。
- install.sh 每次构建注入当前钥匙（不走链——它和清单出自同一站点），(重)装时清掉 `~/.morse/release-key.json`。
- 限制：**当前**私钥被盗时小偷也能签自己的换钥声明，换钥不能保证救回，只能让大家重装（DEPLOY-CLOUDFLARE §13）；当前私钥丢失则换不了钥。测试：新增 `test/rotation.test.ts` 26 例；`scripts/morse-e2e-update.sh` 第 7～10 步（daemon 跟随 A→B、链外 C 和退役 A 被拒、跟随 B→C、停在 A 的客户端一次走 A→B→C）。

## 2026-10-26 — Morse：主域名改为 morse.im，morse.talk 永久保留为别名（ADR-040）

- 地址：`morse.im/<handle>[/<agent>]` 和 `morse.talk/<handle>[/<agent>]`（以及裸 handle、`@`、`https://`、大小写、结尾斜杠）在所有解析地址的地方完全等价——命令行、daemon 接口、局域网 / 中转代码、install.sh；所有输出改为 `morse.im/…`。地址不上线（线上只有裸 handle），新旧客户端互通，中转协议不变。
- 已存记录照样匹配：拉黑名单、昵称缓存里带域名的值按裸 handle 读；配对设备用 `morse.im/x`、`morse.talk/x` 都找得到；请求区用两种写法都能同意 / 拒绝。
- 中转：`relay-cf/wrangler.toml` 在 `relay.morse.talk` 之外加 `relay.morse.im`（同一个 Worker、同一套 Durable Objects）。新装默认 `wss://relay.morse.im`；已装电脑的配置不改写。配置为 relay.morse.im 但连不上时退到 relay.morse.talk（WebSocket：下一次重连；HTTP：连不上时，超时不重发）。
- 站点：`site/wrangler.toml` 让 `morse.im` 和 `morse.talk` 提供同一份静态文件，不跳转——`curl …morse.talk/install.sh`、`morse.tgz`、`version.json(.sig)` 照样能用。install.sh、自动更新、打印的一行命令默认站点改为 `https://morse.im`，取不到退到 morse.talk。首页（中英）改用 morse.im，加 `rel=canonical` 指向 https://morse.im/。
- 还没部署（morse.im 的 zone 在 Pending）。部署顺序和验证命令见 docs/DEPLOY-CLOUDFLARE.md §14。测试：新增 `test/morse-domain.test.ts`；e2e 断言 `morse.im/…` 输出，并保留一部分 `morse.talk/…` 输入。

## 2026-10-21 — Morse：客户端自动更新（只装签名过的发版，ADR-039）

- `npm run site:build` 多生成 `version.json`（发版清单：`schema`、`name`、`version`、严格递增的 `release`（UTC 构建时间）、`file`、`size`、`sha256`、`builtAt`、`keyId`）和 `version.json.sig`（对 `morse-release-v1\n` + 清单原始字节的 Ed25519 分离签名）。签名私钥从发版机钥匙串（`morse-release-signing`）读；`npm run release:key` 生成并存入钥匙串（经 `security -i`，读回核对）、打印公钥；没有钥匙就构建失败并提示怎么建。
- 公钥钉在客户端（`src/update/release-key.ts`，第一次签名发版前是明显的占位符）；钥匙串私钥和 src、dist 里钉的公钥对不上就构建失败。打包副本里带 `dist/release.json`（发版号），仓库的 `dist/` 没有——git 克隆是开发版，不自动更新。
- daemon 启动 1～10 分钟后、之后每 6 小时查站点（`MORSE_SITE` > `update.site` > `https://morse.talk`）；只装签名对得上钉死的公钥、包的大小和 SHA-256 对得上签名清单、发版号严格更大（不降级）的版本；用跑 daemon 的同一个 node 和它旁边的 npm `npm install -g --prefix <同一前缀>`，再经 launchd（`kickstart -k talk.morse.daemon`）或 systemd（`restart morse.service`）重启——只有那个服务的 pid 就是本进程时才重启，否则日志写「update installed, restart to apply」；新版第一次启动跑 `morse setup`。每一步写 daemon 日志；失败退避（15 分钟起翻倍，最多 6 小时），不会让 daemon 崩；正在分块传文件时推迟。
- `morse update` 立即安装（打印已装 / 最新；传文件时拒绝，`--force` 强装）；`morse update --check` 只报告；`morse status` 显示已装发版号、开关、上次检查、上次自动安装。`~/.morse/config.json` 里 `"update": {"auto": false}` 关掉。daemon 新接口 `GET /api/update`。
- install.sh（参数不变）在 `npm install -g` 前用 node 校验签名清单和包的 SHA-256，不对就拒绝；站点没有签名文件只警告。用 `--site` / `MORSE_SITE` 装的会记下 `update.site`。
- 威胁模型：只拿下 morse.talk 推不了代码给已装的客户端；仍能不发新版、或给第一次安装的人改过的 install.sh。不防：发版机被攻破、npm 依赖投毒、新版启动即崩的回滚、换钥（还没做）。
- 这之前装的电脑要手动升级最后一次（重跑 install.sh）。测试：新增 `test/update.test.ts` 36 例；验收 `scripts/morse-e2e-update.sh`（一次性测试钥匙、本地站点、临时 HOME + npm 前缀：被换的包 / 错钥匙 / 旧版本被 install.sh、`morse update`、daemon 拒绝；开关；daemon 自己装上 200、重启后运行 200）。用到站点的 e2e 改用一次性钥匙、构建到各自临时目录（`scripts/lib/test-release.sh`），测试构建不可能写进 `site/public`。

## 2026-10-21 — Morse：大文件分块传（单个 100 MB、每块端到端加密、收齐校验再入库、断点续传，ADR-038）

- 放不进一条信封（Cloudflare 约 550 KB）的附件不再报错：消息只带清单（文件名、大小、整文件 SHA-256、块大小、块数），每 512 KiB 一块、单独一条信封，端到端加密并签名、编号（消息 ID + 文件序号、块序号、总块数、整文件 SHA-256），明文里是原始字节（不再二次 base64），封好约 700 KB。小附件照旧整条发。
- 收件方：块暂存在 `~/.morse/incoming-chunks/`（0700/0600，乱序、重复都行，上限 1 GiB `morse.maxStagingBytes`，24 小时没进展清理）；收齐后逐个文件校验 SHA-256，移到 `~/.morse/inbox-files/<id>/`（0600，不执行不打开），然后这条消息才入库，正文和附件一起出现；校验不过的文件请发件方重发。
- 可靠性：收件方对清单回「已有哪些块」，每 8 块 / 300 ms 回一次累计确认；发件方最多 24 块在途，15 秒没确认重新问状态、只补缺的块；进度在收件方磁盘上，任一方重启都从断点续传。传输在后台跑，驿站显示 `waiting: sending … x/y chunks confirmed`，收到最终回执立即标记送达。
- 上限：单个文件和一条消息合计默认 100 MB（`morse.maxFileBytes`），发送时报错；收件方按自己的上限拒收，发件方直接失败、不无限重试。分块共用一个令牌桶，取中转每设备速率的 5/6（120 → 100 条/分钟），遇到 `rate limited` 等待重发；收件方「每人每分钟 30 条」只算清单一次，块不按条计（受清单声明的字节数约束）。
- 请求区不收块：只记文件名和大小；同意后发件方把文件作为新消息补发。
- 局域网同样分块（双向 TLS，块是 JSON + base64，HTTP 应答即确认），局域网中途失败换中转继续。
- CLI：`morse send --file` 显示 `sending: x/y chunks confirmed` / `delivered: …`（`--no-wait` 不等）；`morse inbox` 列出每个附件的名字、大小、路径，收齐前显示 `receiving x/y chunks`。daemon 新接口 `GET /api/morse/transfer/<id>`。
- 不改中转、不用部署。大文件需要收发两边都是新版；旧版收件方只收到正文，发件方标失败并提示升级。测试：新增 `test/morse-chunks.test.ts` 22 例；验收 `scripts/morse-e2e-files.sh`（经中转 1/10/50 MB、收件方中途被杀后续传、局域网 10 MB）。

## 2026-10-21 — Morse：陌生人消息请求（第一条进请求区，同意才算加上）、收件限速（ADR-037）

- 没配对的人发来的第一条消息不再自动回加：照原规则核实身份（中转 `fromHandle` + 目录 + 公钥包；局域网首联同样当场核对）后存成一条**消息请求**，单独一张表，不进收件箱、不出现在 `morse pull` / hook、不投递给任何 Agent。每人一条（留第一条，之后的只计数丢弃），最多 200 条（`morse.maxRequests`，满了丢最旧的），附件不落盘。
- `morse requests` 列出（昵称 (地址)、设备、首条预览、时间）；`morse requests accept <地址>` 把写信的设备配成 `peer`、消息移进收件箱；`morse requests decline <地址>` 删除并拉黑。主动 `morse pair add` 或给他发信也算同意，`morse pair remove` 撤销。`morse inbox` 末尾提示「N message request(s)」；skill 写明 Agent 只汇报数量，主人明确说同意谁才 accept。
- 发件方：回执带 `request: filed | dropped`；第一条显示 `request pending`，之后发给这台设备的**留在本机驿站**（`waiting for … to accept your message request`），不重复投递；对方同意后其 daemon 发端到端加密的 `accepted` 通知，留着的立即送出；通知丢了每 10 分钟探测一次。
- 自己的设备（同 handle）和已配对的人不受影响。
- 收件限速：每台收件设备每分钟同一个人 ≤ 30 条、总共 ≤ 300 条（`morse.receiveLimit`），超出丢弃且不回执（对方稍后重发），局域网回 429。
- 配置：`morse.strangers` = `"request"`（默认）/ `"accept"`（旧的自动回加）/ `"block"`；旧 `morse.autoPairBack: false` 兼容为 block。
- 不改中转。旧客户端不认识请求回执，真实设备都要升级。测试：新增 `test/morse-requests.test.ts` 16 例 + 局域网、mailbox、dispatcher 用例；验收 `scripts/morse-e2e-requests.sh`（中转、局域网各一遍）。

## 2026-10-21 — Morse：开放注册（不要邀请码、随机地址）、配对码加自己的电脑、显示昵称（ADR-036）

- `curl -fsSL https://morse.talk/install.sh | bash` 或不带参数的 `morse join`：中转给还没加入的电脑分配随机地址（8 位，去掉 0/1/i/l/o/u），没有账号，设备私钥即身份；在 `InviteBook` DO 里串行分配、查重（认领记录 + KV 已有 handle），不会重复；一台设备只属于一个地址。
- 可读名字不自助：`morse join <名字>`、`install.sh <名字>` 拒绝并提示可读名字暂未开放、可向管理员申请；管理员邀请码照旧（已发出的继续有效）；保留名（admin、root、support…，可用 `RESERVED_HANDLES` 追加）发邀请时拒绝。
- 第二台电脑：`morse device add` 打印一次性配对码（10 分钟、只存哈希、5 次猜错作废、新码替换旧码、请求不可重放），新电脑 `morse join <地址> --code <码>` 或 `install.sh <地址> --code <码>`；没有码不能加入已有地址。`morse device list`。
- 昵称：`morse name set "…"` / `clear`，可重名、只用于显示，任一台设备可改，存 AgentBook；显示为「昵称 (地址)」，随加密消息和目录查询下发，改了推送给本人其他在线电脑。
- 防滥用：每 IP 每小时新地址 ≤ 20（`REGISTER_PER_IP_PER_HOUR`，`CF-Connecting-IP` 哈希，DO 里计数）；`OPEN_REGISTRATION = "0"` 可关。
- 找回：全部电脑丢失不能自助，管理员 `DELETE /admin/handles/<地址>` 释放（随机地址不再发出）。
- install.sh：不带参数 = 新地址（已加入则只升级）、`<地址> --code <码>`、`<邀请码>`、新增 `--no-join`；落地页和 QUICKSTART 改成以开放注册为主；落地页默认英文、可切换简体中文，加「为什么叫莫尔斯」，只用占位地址；新增英文版 `docs/QUICKSTART.en.md`；install.sh 输出只用英文。
- 不需要 DO 迁移和数据迁移；旧数据在新中转下验证可用。测试：新增 `test/morse-register.test.ts`；验收 `scripts/morse-e2e-register.sh`。

## 2026-10-21 — Morse：同一局域网里第一条消息也直连（ADR-034 补充）

- 收件方在局域网上收到未配对设备的 Morse 消息（自报 handle）时，当场向中转核对目录（设备在该 handle 下、公钥包按设备 ID 验签通过），通过就按原规则配对（同 handle → owner，否则 peer）并直接收下；中转不通 / 3 秒没答 / 对不上 / 关了自动回加 / 拉黑 → 照旧拒绝，对方走中转。
- 发件方被拒时日志改为 `first contact with … goes through the relay — you'll be paired automatically …`，不再报 `lan failed` / `not paired`。
- 用户可见的配对提示改为 `morse pair add …`。
- 不改中转。测试：`test/morse-lan.test.ts` 新增 5 例；验收 `scripts/morse-e2e-lan-first.sh`。
## 2026-10-21 — Morse：数据目录改为 ~/.morse，后台服务改名 talk.morse.daemon / morse.service（ADR-035）

- 新安装数据放 `~/.morse`；`MORSE_HOME` 优先，`ANYTOANY_HOME` 兼容。
- 已有 `~/.anytoany` 的，daemon 启动或 `morse setup` 时整体原子 rename 到 `~/.morse`，旧位置留指向新目录的符号链接；幂等；setup 先停 daemon；任何一步失败都留在（或搬回）旧目录继续用，设备 ID 和收件箱不变。
- launchd 标签 `talk.morse.daemon`（日志 `~/.morse/daemon.log`），systemd `morse.service`；install.sh 升级时先卸旧的 `dev.anytoany.daemon` / `anytoany.service`，再 setup 搬家，再装新服务。文档、install.sh、skill 路径改为 `~/.morse`。
- 测试：新增 `test/migrate-home.test.ts`；验收脚本 `scripts/morse-e2e-migrate.sh`。

## 2026-10-21 — Morse：同一 handle 下的设备是 owner；Morse 地址局域网优先（ADR-034）

- **自己的设备 = owner**：按 handle 配对时，本机自己的 handle 下的设备给 `owner` 档（只有发给这个 handle 的邀请码能把设备加进来），别人的仍是 `peer`；`owner` 不降级。旧的同 handle `peer` 配对在每次登录中转后自动升级（只升级、不新增），发信 / 收信查目录时也当场升级。`morse pair remove <自己的 handle>` 同时拉黑。
- **局域网优先**：查到 `<人>/<agent>` 的唯一设备后，已配对且在局域网上被发现就走原有双向 TLS（新路由 `POST /api/peer/morse`），应答即回执；失败回落中转。peer 档也能走局域网，档位不变。中转不通时之前查到过的地址仍可走局域网。日志写明 `via lan` / `via relay`。
- daemon 退出前在 mDNS 上发 goodbye。
- 中转和协议都没改，不用重新部署中转；客户端升级即可（旧版对端 404 → 自动走中转）。
- 测试：新增 `test/morse-lan.test.ts`；验收脚本 `scripts/morse-e2e-lan.sh`。

## 2026-10-20 — Morse：一个 Agent 一个地址、目录放在中转上、命令改叫 morse（ADR-033）

- **每个 Agent 一个地址 `morse.talk/<人>/<agent>`，只送到托管它的那一台设备**，不再扇出；`morse.talk/<人>` 发给这个人的默认 Agent（第一个登记的，`morse agent default` 可改）。agent 名小写字母数字和 `-`，同一个人下唯一。
- **默认每台电脑登记一个 Agent**：`morse join <码> --agent <名>` / `install.sh --agent <名>`，不指定就从电脑名推导（mini / air / pro…）。它是「这台电脑上的 Agent 收件箱」，本机任何 Agent 用 `morse inbox` / 新增的 `morse pull --inbox` 取。
- **`morse agent list | add | remove | default | rename`**：设备私钥签名提交 `POST /v1/agents`；handle 取自白名单；只有托管设备能加、删、改名；改名原子，新地址立即可用、旧地址立即失效、默认跟着改；重名 409，join 时在扣邀请之前拒绝。
- **中转**：每个人一个 Durable Object `AgentBook`（强一致，迁移 `v3`）；WebSocket 查询 `{type:"agent"}`；`/v1/join` 带签名的 `agent`；管理接口 `GET/DELETE /admin/agents/…`；移除设备时它的 Agent 一起删。Node 版中转同样有目录（SQLite）和 `/v1/agents`。
- **发件方**：每次投递都重新查目录，只给那一台设备封一份密文、只认它的回执；离线就 waiting、只重试那一台；查无此 Agent → `failed (no agent …)`。明文里带发件方自己的 `<人>/<agent>`，`morse reply` 回到写信的那个 Agent。发给自己另一台电脑同样可用；发给本机自己的 Agent 直接落本机。
- **命令改叫 `morse`**（`anyd` 保留为兼容别名）；帮助、提示、文档、skill、install.sh、落地页都改用 `morse`。npm 包名本轮不改。
- 测试 506 个（新增 `test/morse-agents.test.ts`）。验收：`scripts/morse-e2e-agents.sh`（本机两个 `wrangler dev`、临时 HOME），原有三个 e2e 脚本调整后照旧全过。

## 2026-10-20 — Morse 一行加入：邀请码入网、morse.talk 安装站、首次联系自动回加（ADR-032）

- **邀请码代替手改白名单**：管理员 `anyd invite create <handle> [--uses N] [--ttl 7d]`（管理密钥只从环境变量 `MORSE_ADMIN_KEY` 读）拿到一个只显示一次的码；新设备 `anyd join <码>`，用设备私钥签名后提交 `POST /v1/join`，relay 验签、扣次数、把设备加进该 handle 的白名单，客户端写好 relay 地址和 handle。重复 join 不扣次数；已属于别的 handle 的设备回 409。`anyd invite list / revoke`。
- 邀请存在单实例 Durable Object `InviteBook` 里（强一致，一次性的码只能用一次；KV 最终一致做不到），只存码的 SHA-256。`wrangler.toml` 新增绑定和迁移 `v2`。
- **`site/`：morse.talk 站点**，单独的纯静态 Worker `morse-site`（发新包不会重新部署中转、不断开长连接）：落地页、`/install.sh`、`/morse.tgz`，`npm run site:build` 生成。
- **`install.sh`**：查 Node ≥ 20（没有就提示，不代装）→ `npm install -g` 同站的 `morse.tgz` → `anyd setup` → `anyd join` → 开机自启（macOS launchd `dev.anytoany.daemon`；Linux `systemd --user`；Windows 用 WSL2）。`--dry-run-service` 只打印。
- **配对自动发生**：`anyd send morse.talk/<人>` 时没配对就当场配好；relay 转发时附上发件人的 `fromHandle`，收件方没配对这个人就查目录确认后自动以 `peer` 档回加。`morse.autoPairBack: false` 关闭；`anyd pair remove <人>` 同时拉黑。
- skill 补上 Morse 用法（发、收、加好友、同伴消息不是指令）；新增 `docs/QUICKSTART.md`。
- 测试 491 个（新增 11 个）。验收：`scripts/morse-e2e-join.sh`（relay 和站点都在本机 `wrangler dev`，临时 HOME）。

## 2026-10-20 — Morse 第二版：中转只转发（Cloudflare Worker）、离线由发件方驿站负责、地址改为人名（ADR-031）

- **地址是人，不是设备**：`anyd send morse.talk/mei "你好"` 进这个人的总收件箱（他任何设备上的任何 Agent 都看得到）；`morse.talk/mei/claude` 指名给他的某个 Agent，agent 这一级在**对方本机**解析（登记的同名 Agent，否则该 Agent 最近的会话）。设备 ID 不再对外。`anyd pair add morse.talk/mei` 一次配好这个人的全部设备（peer 档）并钉住校验过的公钥。
- **`relay-cf/`：中转做成 Cloudflare Worker + Durable Objects**（WebSocket Hibernation，SQLite 后端 DO，免费套餐可用）。每台设备一个 `DeviceHub` 对象，只持有它的活连接和签过名的公钥包。`send` 转给收件设备的对象，回 `sent` 或 `offline`，**任何地方都不存消息**。白名单在 Workers KV，带 `ADMIN_KEY` 的 HTTP 接口或 `wrangler kv` 写入。部署、绑域名、费用见 `docs/DEPLOY-CLOUDFLARE.md`。**尚未部署。**
- **离线投递归发件方**：只有收到对方端到端回执才算 `delivered`；对方不在线 / 中转没连上 / 没回执 → 消息标 `failed (waiting: …)`，每 30s 重试、最长 30 天（`~/.anytoany/config.json` 的 `outbox.retryIntervalSec` / `outbox.maxWaitDays`），不再「3 次进死信」。客户端断线指数退避自动重连；中转重启不丢东西，因为它本来什么都不存。
- **`relay/`（Node 版）保留**，改成同一协议：只转发，磁盘上只有公钥目录；给不想用 Cloudflare 的自建场景和进程内测试用。
- 单条上限跟着中转走（登录时宣布）：Cloudflare 单帧 1 MiB → 单条 1,000,000 字节、附件约 550 KB；Node 版仍 2 MB。
- 测试 480 个（新增 18 个）。验收：`scripts/morse-e2e-cf.sh`（本机 `wrangler dev`，隔离配置目录、不读真实登录）和 `scripts/morse-e2e.sh`（Node 中转）——按 handle 配对、实时送达 + 回执、离线 → 驿站保留 → 上线补发、中转状态里没有消息、陌生设备被拒、中转重启自动重连、附件、同伴消息标注、回信。

## 2026-10-20 — 分叉之前：anytoany 时期摘要（2026-08-05 起）

Morse 从 anytoany（MIT）分叉而来。下面按时间简单列出分叉时已经有的东西；细节在对应的 ADR 里。

- **2026-08-05 立项**：调研各家 CLI 的接入点，定下方向（ADR-001～006：skill 分发、只做局域网、开源、TypeScript + Node、先用 headless 续接投递、字段对齐 A2A）、品牌（ADR-007）和定位（ADR-009）。同一天做完第一期：会话目录与 `@` 寻址、SQLite 信箱（确认 / 重试 / 死信）、Claude 和 Codex 的投递、网页控制台（ADR-012 起改为单列消息流）、两台机器的局域网互通。实际使用里发现「送得到 ≠ 有环境」（ADR-010），信封改为必须表态（ADR-011）。
- **2026-08-06**：ZCode 投递；跨设备双机打通；用户在对话里插话不再裂成新对话（ADR-014）；止住 BLOCKED 互相回 BLOCKED 的乒乓。
- **2026-08-07 — 08-13**：ZCode 由机主放开执行模式（`zcode.deliverMode`）；`codex --sandbox` 必须放在 `resume` 前面；CI 每次推送只跑 Ubuntu（ADR-015）；Kimi 投递；跨设备回给用户的信不再被本机截下；launchd 托管 daemon；信任模型改为「信任队友」（ADR-016）；单回合时限可配，超时不再重试。
- **2026-08-13 — 08-16**：会话里自己等信（`anyd monitor`，现在是 `morse read --wait`，ADR-019）；`anyd pull --history` 和 `reload` 技能；共享协作文档和自驱循环（ADR-017、018、020，2026-11-14 由 ADR-074 删除）；跨 App 可见的原则（ADR-021）。
- **2026-09**：死信由收件方的拉取 hook 补投（ADR-022）；不往开着的 Claude 会话续接（ADR-023）；桌面 App 的助手注册后经本机 HTTP 取信，闪电说第一个接入（ADR-024）。
- **2026-10-12 — 10-13**：发信前比对 CLI 版本（ADR-025）；Codex 开着的线程按写锁跳过（ADR-026）；门铃——Claude 敲官方收件箱、Codex 走 `codex queue`（ADR-027），ZCode 走会话信箱（ADR-029）；设备之间每台一把钥匙、双向 TLS、按公开 ID 配对（ADR-028，按设备配对后来随 v2 删除，ADR-091）。
- **2026-10-20**：修复排队进 Codex 的回合被活动摘要当成「已处理过」而不执行（ADR-027 末尾）。
