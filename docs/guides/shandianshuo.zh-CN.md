# 闪电说上手：用它给 Claude Code、Codex 派活

> 创建：2026-09-17 · 最后更新：2026-11-17（重写，内容按当前版本核对）
> 写给闪电说用户，可以直接转发。为什么这样设计见 ADR-024。

## 能做什么

Morse 让你电脑上各个 AI 编程 agent 的会话互相发消息。接上以后，你对闪电说助手说一句话，它就把活交给 Claude Code、Codex、Kimi 或 Z Code 里某个具体的会话；那边干完回信，你再问一句，它把结果讲给你听。

比如：

> **你**：让 Codex 里 sunoprompt 那个会话查一下登录页的报错，改好告诉我
> **闪电说**：发过去了。
> ……过一阵……
> **你**：Codex 那边好了没？
> **闪电说**：Codex 回了：是 token 刷新的竞态，已经修好，测试跑过了。

每个模型留在它最顺手的工具里，你不用来回切窗口。

## 你需要

- 至少已经在用一个 AI 编程 agent：Claude Code、Codex、Kimi Code 或 Z Code。Morse 只负责把已有的会话连起来，本身不带 AI；一个都没有的话，闪电说没有可以派活的对象。
- macOS，Node.js 22 或更新。

## 接上：三步

**1. 装 Morse。** 打开「终端」，粘贴回车：

```bash
curl -fsSL https://morse.im/install.sh | bash
```

装好 `morse` 命令、给各个 agent 装上技能、启动后台服务。

**2. 接上闪电说。** 先预览：

```bash
morse connect sds
```

它只列出要改的地方，不写任何东西。确认后：

```bash
morse connect sds --apply
```

改的是闪电说自己数据目录里的三处：放一个技能文件；打开这个技能的开关（手动放进去的技能默认是关的）；在 `AGENTS.md` 里加一段前后带标记的说明。标记以外你自己写的内容不会动。

**3. 重启闪电说**，然后对它说「有我的消息吗」。它去查一下收件箱，回你「没有新消息」，就说明通了。

## 日常用法

- **派活**：「让 Claude Code 里 morse 项目那个会话把 README 的安装部分重写一下」。没说清发给谁，它会先问你。
- **问结果**：「那边回了吗？」
- **看能派给谁**：「我现在有哪些 agent 会话可以用？」

对面看不到你和闪电说聊了什么，只看到你让它转过去的那段话，所以派活时把事情说完整。

## 两个限制

- **回信不会主动推给你。** 闪电说没有后台任务，不会自己醒来；回信要等你下次开口时它去取。为此 Morse 在有新信时会弹一条 macOS 通知，看到了问一句就行。
- **闪电说关着时收不到，但信不会丢。** 信在本机排队，下次打开说句话，它一次取回。

## 出问题时

先跑：

```bash
morse status --check
```

里面有一行是闪电说：

- `闪电说 assistant (external agent)` 后面是 `connected — registers as @sds and pulls over HTTP`：正常。
- `skill present but DISABLED in 闪电说 …`：技能被关了，重跑 `morse connect sds --apply`。
- `run: morse connect sds --apply`：还没接上。

| 情况 | 原因 | 办法 |
|---|---|---|
| 闪电说说 Morse 服务没在跑 | 后台服务停了 | `morse status` 看一下，没跑就 `morse start` |
| 它找不到你说的会话 | 名字对不上 | 先问它有哪些会话，用它列出来的名字 |
| 它说口令不对、或提到 401 | Morse 更新后，它手上的说明还是旧的，调用时没带口令 | 终端里跑 `morse connect sds --apply`，再跟它说句话 |
| 重启后还是没反应 | 技能没加载上 | 看 `morse status --check` 那一行，必要时重跑 `morse connect sds --apply` 再重启 |

## 不用了

```bash
morse connect sds --uninstall --apply
```

只撤掉它加的那三处（技能文件、那个开关、`AGENTS.md` 里那段），别的不动。

## 隐私

- 闪电说和 Morse 之间只走本机回环地址 `127.0.0.1`，daemon 只接受本机连接；消息存在本机数据库里。
- 每次调用都带一个只属于闪电说的口令，口令存在你自己的 Morse 目录里，不出现在命令行上；凭它只能以闪电说的身份收发纯文本。
- 想让别的电脑上的 agent 也能收发，按[快速上手](../QUICKSTART.md)里「你的另一台机器」一节做；那条路是端到端加密的。

## 更多

- 主页：[morse.im](https://morse.im)
- 技术规格：[外部 agent](../specs/phase5-external-agents.md)
