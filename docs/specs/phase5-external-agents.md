# 外部 agent：桌面 App 里的助手怎么接进来

> 创建：2026-09-17 · 最后更新：2026-11-17（按现状重写；调用本机接口要带 App 自己的口令，ADR-087）
> 相关决策：ADR-024（来由和闪电说源码里的证据）、ADR-087（本机接口的凭据）
> 第一个接入的是闪电说桌面版，agent 名 `sds`；给用户的上手说明见 [guides/shandianshuo.zh-CN.md](../guides/shandianshuo.zh-CN.md)。

## 问题

Claude、Codex、Kimi、ZCode 都能从外面用命令行续接一个会话，Morse 靠这个投递。桌面 App 里的助手不行：它的会话不是我们该去写的东西，它的 shell 往往受沙箱和极简 PATH 限制跑不了 `morse`，而且它不会自己醒来。

所以给这类 agent 一条通用的路：**自己报到（注册），自己来取（拉取）**。Morse 只负责让它成为一个能被寻址、能收到回信的目标。

## 注册

- 文件：`~/.morse/registered/<agent>-<会话 id>.json`，一个会话一个文件；文件名里不属于 `[A-Za-z0-9._-]` 的字符换成 `_`。
- 内容：`agent`、`sessionId`（原样）、`title`（用于 `@` 目标匹配，缺省是 agent 名）、`cwd`、`registeredAt`（第一次注册时间，以后不变）、`lastSeenAt`（每次注册刷新）。
- agent 名要符合 `^[a-z][a-z0-9-]{1,31}$`，而且不能是 `user`、`claude`、`codex`、`kimi`、`zcode`（前一个是给人的收件箱，后四个有自己的投递通道，重名会让目录混乱）。
- 7 天没再报到的记录不出现在目录里，但文件留着，再报到一次就回来。注册是长期身份，不是心跳；但卸载了的 App 不该一直占着地址。
- 外部会话一律算本机的，没有设备字段。

代码：`src/registry/external.ts`（读写注册）、`src/adapters/registered.ts`（把注册记录并进会话目录；它只列会话，**没有投递**）。

## 拉取型投递

dispatch 插件跳过三类本机目标、把消息留在 `pending`：正在 `morse read --wait` 的会话、开着的活会话、注册的外部会话。所以发给外部 agent 的信一直是 `pending`、尝试次数 0，直到它自己来取；判断时只看会话 id，不看是否过期——过期的也不该被 headless 续接。

外部 agent 不会自己醒，信到了也没有「已送达」事件，所以 daemon 另外每 5 秒看一次注册会话有没有新的 `pending`，有就发一条系统通知（`src/daemon/external-notify.ts`）。启动时先把已有的积压记为通知过，重启不会重复弹。没有注册会话时什么都不查。

## 本机接口

| 接口 | 作用 |
|---|---|
| `POST /api/inbox` `{agent, sessionId, register?, title?, cwd?}` | `register: true` 时先注册或续期，再取信；返回 `{count, text, messages}`，`text` 是排好版可以直接念的内容。取信和 prompt hook 用同一段逻辑，死信补投（ADR-022）也一起带上 |
| `POST /api/register` | 只注册；agent 名不合法回 400 |
| `GET /api/sessions?q=&agent=&limit=` | 列会话。`q` 按标题或目录不分大小写匹配，`limit` 最多 200；不带参数时和以前完全一样（控制台在用） |
| `POST /api/send` | 发信，`from` 写 `{agent, sessionId}` |

每次调用都要带这个 App 自己的口令（ADR-087），不带就是 401。口令由 `morse connect sds --apply` 生成，写在 `~/.morse/api-tokens/sds.header`，curl 用 `-H @<文件>` 整行读进去，所以口令既不出现在命令行上，也不出现在写给 App 的说明里。凭这个口令只能以 `sds` 的身份、用它绑定的会话注册和收信、发纯文本、列会话（只给 agent 名和标题）；读别的会话的信、带附件、调别的接口都不行。

## 闪电说（`sds`）

`morse connect sds` 默认只预览，`--apply` 才写，`--uninstall` 撤掉，`--app-home` 可以指定 App 数据目录。它往 App 自己的数据目录写三处，其余一概不动：

| 位置 | 写什么 |
|---|---|
| `<workspace>/library/skills/anytoany/SKILL.md` | 技能本身（目录名就是技能名，为了认出旧安装保留旧名） |
| `<APP_HOME>/skills/skills-state.json` | 只加或改 `voice_assistant/anytoany` 这一个键：手放进去的技能默认是关的 |
| `<workspace>/AGENTS.md` | 只替换 `<!-- anytoany:begin -->` 和 `<!-- anytoany:end -->` 之间的内容；文件不存在就新建。它每轮都进上下文，比技能可靠 |

`APP_HOME` 是 `~/Library/Application Support/Shandianshuo`；workspace 读 `APP_HOME/migrations/workspace-location-v1.json` 的 `workspacePath`，没有就是 `APP_HOME/workspace`。App 不在时报错退出，什么都不写。重复执行结果一样。

助手那边最终跑的是 curl（`/usr/bin/curl` 在最小 PATH 里一定有，网络也不归它的沙箱管）：

```bash
SID="${DSH_SESSION_ID:-${SHANDIANSHUO_DSH_SESSION_ID:-main}}"
AUTH="@$HOME/.morse/api-tokens/sds.header"

# 取信（顺带注册 / 续期）
curl -s -m 10 -X POST http://127.0.0.1:7433/api/inbox -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"agent\":\"sds\",\"sessionId\":\"$SID\",\"register\":true,\"title\":\"闪电说助手\"}"

# 发一条
curl -s -m 30 -X POST http://127.0.0.1:7433/api/send -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"target\":\"@codex:<会话>\",\"from\":{\"agent\":\"sds\",\"sessionId\":\"$SID\"},\"text\":\"...\"}"
```

会话 id 先取 `DSH_SESSION_ID`，再取 `SHANDIANSHUO_DSH_SESSION_ID`，都没有就用 `main`（助手只有一个固定会话，退化也能用）。

## 不做的

- 不去扫闪电说自己的会话存储，也不往运行中的助手推消息（ADR-024 里逐条查过，没有正当的入口）。
- 不承诺秒级收信：发是即时的，收发生在助手下一回合。
