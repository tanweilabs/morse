# 调研：Skill 今天怎么分发、怎么装（Agent Skills 标准、`npx skills`、各家 Agent 的发现目录）

> 创建：2026-11-15 · 最后更新：2026-11-15
> 为 ADR-086 做的事实核对。只记一手来源里查得到的；每条给出 URL 和所依据的原句。查不到、没法验证的单列在最后一节，不写成事实。
> 取材方式：2026-11-15 用抓取工具读各页面（工具会把页面转成 Markdown 再摘录，引号里的英文是工具返回的原文片段；合并前建议对着页面再点一遍）。Morse 自己的事实取自本仓库 `main`（009b78f）和当天对 morse.im 的请求。

## 1. Agent Skills 开放标准（SKILL.md）

来源：<https://agentskills.io/specification>

- **一个 skill 就是一个目录，至少有一个 `SKILL.md`**：“A skill is a directory containing, at minimum, a `SKILL.md` file”。可选子目录 `scripts/`（“Contains executable code that agents can run.”）、`references/`、`assets/`。
- **frontmatter 字段**（规范的表）：
  - `name` 必填：“Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen.”，并且 “Must match the parent directory name”，不能有连续两个连字符。
  - `description` 必填：“Max 1024 characters. Non-empty. Describes what the skill does and when to use it.”
  - `license` 可选；`compatibility` 可选（“Max 500 characters. Indicates environment requirements (intended product, system packages, network access, etc.)”）；`metadata` 可选（字符串到字符串的映射）；`allowed-tools` 可选、实验性。
- **渐进加载**：启动时只加载 `name` 和 `description`（约 100 token）；选中后才加载整个 `SKILL.md`（“< 5000 tokens recommended”）；其余文件用到才读。“Keep your main `SKILL.md` under 500 lines.”
- 校验工具：`skills-ref validate ./my-skill`（agentskills/agentskills 仓库里的参考实现）。

## 2. `npx skills add`（vercel-labs/skills）

来源：<https://github.com/vercel-labs/skills>（README）、同仓库 `docs/commands.md`、`docs/agents.md`、`docs/creating-skills.md`、`docs/troubleshooting.md`、`src/providers/wellknown.ts`

- **要求**：“Requires Node.js 22.20 or later.”（Morse 客户端只要求 22：Node 22.0–22.19 上 `npx skills` 用不了，要走别的装法。）
- **来源写法**（`docs/commands.md`）：GitHub 简写 `owner/repo`、完整 GitHub URL、仓库里某个 skill 的路径、GitLab、Azure Repos、“Any git URL”、“Local path”，以及 “Install from a direct SKILL.md or archive download URL”；“Direct download URLs are tried after well-known discovery.”
- **对仓库的要求**（`docs/creating-skills.md`）：在这些位置找 skill——“Root directory (if it contains `SKILL.md`)”、“`skills/`”、“`.agents/skills/`”、“`.claude/skills/`” 等一长串；都没有时 “a recursive search is performed”。每个 `SKILL.md` 要有 `name` 和 `description`（`docs/troubleshooting.md`：“Ensure the repository contains valid `SKILL.md` files with both `name` and `description` in the frontmatter.”）。所以**公开仓库用 `skills/<名字>/SKILL.md` 这个布局就够了**。
- **选项**：`-g, --global`（“Install to user directory instead of project”；默认装进当前项目：“Skills are installed to the current project by default; add `-g` to make them available across projects.”）、`-a, --agent <agents...>`、`-s, --skill <skills...>`、`-l, --list`、`-y, --yes`、`--copy`、`--all`。不交互的例子：`npx skills add vercel-labs/agent-skills --skill frontend-design -g -a claude-code -y`。
- **装到哪**（`docs/agents.md` 的表）：“The CLI automatically detects which coding agents you have installed.”

  | Agent | `--agent` | 项目级 | 用户级（`-g`） |
  | --- | --- | --- | --- |
  | Claude Code | `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
  | Codex、Kimi Code CLI、Zed 等 | `codex`、`kimi-code-cli`、`zed` | `.agents/skills/` | `~/.agents/skills/` |
  | ZCode | `zcode` | `.zcode/skills/` | `~/.zcode/skills/` |
  | Cursor | `cursor` | `.agents/skills/` | `~/.cursor/skills/` |
  | Gemini CLI | `gemini-cli` | `.agents/skills/` | `~/.gemini/skills/` |

- **软链还是拷贝**：默认软链（“Creates symlinks from each agent to a canonical copy.”），`--copy` 是 “Creates independent copies for each agent. Use when symlinks aren't supported.”
- **遥测**：“This CLI collects anonymous usage data to help improve the tool.”；关掉：“Set `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1`”。
- **从网站装（well-known）**：`src/providers/wellknown.ts` 依次试 `/.well-known/agent-skills/index.json`、`/.well-known/skills/index.json`；索引带 `$schema: https://schemas.agentskills.io/discovery/0.2.0/schema.json` 时每项要有 `name`、`description`、`type`（`skill-md` 或 `archive`）、`url`、`digest`（`sha256:` + 64 位小写十六进制），下载后核对摘要，不符就报错、不降级。也就是 `npx skills add https://morse.im` 这种写法在工具里有对应实现。

## 3. 从网站发现 skill 的草案（Agent Skills Discovery RFC）

来源：<https://github.com/cloudflare/agent-skills-discovery-rfc>

- 状态是**草案**：“Status: Draft · Version: 0.2.0”（2026-01-17 发布，2026-03-12 更新）；0.2.0 把路径从 `/.well-known/skills/` 改成 `/.well-known/agent-skills/`。
- 索引在 `/.well-known/agent-skills/index.json`；`skill-md` 类型的 `url` 惯例是 `/.well-known/agent-skills/{name}/SKILL.md`；带脚本等附件的 skill 用 `archive`（`.tar.gz` 或 `.zip`，`SKILL.md` 在包的根上）。
- 草案对客户端的要求（工具返回的是转述，不是原句）：不得默认执行 `scripts/` 下的文件；只从受信任的来源加载；下载后先核对摘要。

## 4. Claude Code

来源：<https://code.claude.com/docs/en/skills>、<https://claude.com/docs/skills/how-to.md>

- **个人级目录**：`~/.claude/skills/<skill-name>/SKILL.md`；项目级 `.claude/skills/<skill-name>/SKILL.md`；另有企业级、插件里的 `skills/`。优先级：“Enterprise over personal, and personal over project.”
- **怎么加载**：“In a regular session, skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked.”
- **会话中途新装的 skill**：“Claude Code watches skill directories for file changes… When you add, edit, or remove a skill under `~/.claude/skills/`… Claude Code picks up the change within the current session, without a restart.” 例外是会话开始后才新建的顶层 skills 目录，要 `/reload-skills`。
- **描述的长度**：每个 skill 的描述合计最多 1,536 个字符；全部 skill 的清单预算是上下文窗口的 1%，超了先砍最少用的 skill 的描述。描述里的 `<`、`>` 会显示成 `&lt;`、`&gt;`。
- **脚本不会自己跑**：脚本是 “Code that Claude runs while following the skill”；“In Claude Code, running a script is a Bash tool call, so it needs your permission.”（唯一会自动执行的是 `` !`命令` `` 这种写法，在 skill 被加载时执行——Morse 的 skill 不用它。）
- claude.ai 账号里的 skill 会同步下来：“Claude Code downloads your account's skills into `~/.claude/skills/synced/`.”
- Windows：文档只提到 `` !`命令` `` 用哪种 shell（`shell: powershell`；没有 Git Bash 时默认用 PowerShell 工具）。

## 5. Claude 桌面应用和 claude.ai（聊天）

来源：<https://claude.com/docs/skills/how-to.md>

- **怎么装**：上传 ZIP——“You upload a skill to Claude as a ZIP file. The ZIP must contain the skill directory itself as its top level”；然后 “Go to **Customize > Skills** in claude.ai or the desktop app and turn the skill on.”
- **代码跑在哪**：“in Claude Code that's whatever is installed on your machine, and in chat on claude.ai it's what the code-execution environment provides”；“In chat on claude.ai, the skill's whole folder, scripts included, is copied into the code execution sandbox”。
- **由此得出的结论（推断）**：聊天里的 skill 跑在沙箱里，够不着用户的电脑，**装不了 Morse**（Morse 要在用户自己的电脑上有常驻的后台服务）。聊天里的 Agent 收到那句话，只能回答「请把这句话发给跑在你电脑上的 Agent」。

## 6. Codex（CLI、IDE 插件、桌面应用）

来源：<https://developers.openai.com/codex/skills>（当天 308 跳转到 <https://learn.chatgpt.com/docs/build-skills>）

- **目录**：仓库级是从当前目录到仓库根每一层的 `.agents/skills`；用户级 `$HOME/.agents/skills`；管理员级 `/etc/codex/skills`；另有随产品带的系统级 skill。会跟随软链的 skill 目录。
- **怎么调用**：显式（CLI 和 IDE 插件里 `/skills` 或输入 `$`）；隐式（任务和 `description` 对得上时自己选用，可用 `allow_implicit_invocation: false` 关掉）。先只加载名字和描述，选中才读 `SKILL.md`。
- **装 skill**：`$skill-installer`；“Codex usually detects new skills automatically; if one doesn't appear, restart Codex.”（工具摘录）
- **哪些形态支持**：页面写的是独立 skill 可用于 “the ChatGPT desktop app, Codex CLI, and IDE extension”（工具摘录；页面把桌面应用叫作 ChatGPT desktop app）。
- 可选的 `agents/openai.yaml`：桌面应用里的显示信息、调用策略、工具依赖。

## 7. `/llms.txt`

来源：<https://llmstxt.org/>

- 是**提议**，不是正式标准：“A proposal to standardise on using an /llms.txt file to provide information to help agents use a website.”
- 位置：网站根（也可以放在某个路径下）。格式：一个 H1（唯一必填）、一段引用块摘要、若干 H2 小节，各是链接列表（每行一个 Markdown 链接，后面可以跟冒号和一句说明），名为 `Optional` 的小节放次要链接。
- 另一条提议：页面在同一地址后加 `.md` 提供干净的 Markdown 版本。

## 8. Morse 自己现在的样子

- `morse setup`（安装脚本第 3 步会跑）把仓库里的 `skills/morse/SKILL.md`、`skills/reload/SKILL.md` 拷进 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills`（`src/setup.ts:53`），只拷 `SKILL.md` 一个文件。自动更新装完也会再跑一次。
- `https://morse.im/install.sh` 在线（200）；`https://morse.im/install.ps1`、`/llms.txt`、`/agent.md`、`/.well-known/agent-skills/index.json` 都是 404（2026-11-15）。Windows 安装脚本和 `--text-file` 在分支 `feat/windows-native` 上，没有合并。
- `install.sh --agent <名字>`：给第一个地址起名（默认按电脑名：mini / air / pro …）；已经加入过的电脑上则是再加一个这个名字的地址。
- 站点构建（`scripts/build-site.mjs`）只拷固定的几个文件（`index.html`、`og.png`、`_headers`、`install.sh` 等）：新加的页面要改构建脚本才会上线。

## 9. 没能验证的（不要当事实用）

1. **`npx skills` 在 Windows 上行不行**：文档没有提 Windows，也没有写软链失败时是否自动改拷贝（只有 `--copy` 选项）。没有在 Windows 上试。
2. **`npx skills add` 没有实际跑过**：本次会话不允许下载并执行这个包，所以 `skill-repo/` 的布局、`agent.md` 里那条 `npx` 命令（含 `--skill morse reload` 一次带两个名字）、从 `https://morse.im` 走 well-known 安装，都只对照了文档和源码，没有端到端试过。
3. **Codex 是否还读 `~/.codex/skills`**：官方页面只列了 `$HOME/.agents/skills`；「旧目录为了兼容还在读」只在二手资料里看到。`morse setup` 现在两处都写，暂时不用改。
4. **Windows 上的用户级目录**：Claude Code 和 Codex 的文档都没写 Windows 路径；`%USERPROFILE%\.claude\skills`、`%USERPROFILE%\.agents\skills` 是按 `~` 推的。
5. **Claude 桌面应用里的 Cowork / Code 标签页**能不能在用户电脑上跑安装脚本：文档只说 Cowork 会替换 `${CLAUDE_SKILL_DIR}`，没说它的命令跑在哪。
6. **Kimi、Z Code 实际读哪个目录**：只有 `npx skills` 的表（Kimi Code CLI 是 `~/.agents/skills/`，ZCode 是 `~/.zcode/skills/`），没有去读两家自己的文档。`morse setup` 现在不写 `~/.zcode/skills/`——如果那张表是对的，Z Code 可能读不到 Morse 的 skill，要另查。
7. **Codex 页面关于脚本**：没有说会不会自动执行脚本；「不会自动跑」对 Codex 是按 Agent Skills 的通行做法推的。
8. **Discovery RFC 的归属**：仓库在 cloudflare 名下，schema 地址在 agentskills.io 下；它是否已被 Agent Skills 项目正式采纳，没有查到说法。

## 10. 2026-11-15 补记（P-A 实现时）

- 第 3 节的索引格式后来不经抓取工具、直接读了原文核对：草案 README（raw.githubusercontent.com/cloudflare/agent-skills-discovery-rfc/main/README.md）和参考实现的源码（raw.githubusercontent.com/vercel-labs/skills/main/src/providers/wellknown.ts）。字段和第 2、3 节写的一致；另外两点：`description` 超过 1024 个字符的条目参考实现会丢掉；草案要求 `SKILL.md` 用 `text/markdown` 或 `text/plain`、`index.json` 用 `application/json`。`https://schemas.agentskills.io/discovery/0.2.0/schema.json` 当天连不上（草案说这个地址只是标识，不必能访问）。
- 第 8 节里「`install.ps1`、`--text-file` 没合并，morse.im/install.ps1 是 404」已经过时：Windows 版（预览）已合并上线。
- 第 9 节第 1、2 条仍然没有验证（`npx skills` 没实跑）。
