# 自建 Morse 中转（Cloudflare Workers）

> 创建：2026-11-17 · 最后更新：2026-11-17

Morse 的中转是一个 Cloudflare Worker + Durable Objects，代码在 [`relay-cf/`](../../relay-cf/)，是唯一维护的中转实现（ADR-076）。它**看不到消息内容**：两边都在线时实时转发密文；对方不在线时替他存密封的信封，最多 7 天，取走即删。自建 = 把 `relay-cf/` 部署到你自己的 Cloudflare 账号，客户端指过去，其余不用改。

本文只讲中转。`morse.im` 的官方中转照常可用；自建是可选的。

## 1. 准备

- 一个 Cloudflare 账号（免费套餐就够：Durable Objects 用 SQLite 存储，`wrangler.toml` 里已写好）。
- Node ≥ 22。
- 可选：一个 DNS 托管在 Cloudflare、状态为 Active 的域名（要绑自定义域名时）。

## 2. 要填的东西（`relay-cf/wrangler.toml`）

| 项 | 在哪 | 怎么填 |
|---|---|---|
| Worker 名 | `name` | 默认 `morse-relay`，决定 `<name>.<你的子域>.workers.dev` |
| KV 命名空间 id | `[[kv_namespaces]]` 里 `binding = "ALLOWLIST"` 的 `id` | 公开仓库里是占位符 `<YOUR_KV_NAMESPACE_ID>`；`wrangler kv namespace create ALLOWLIST` 后把返回的 id 填进去 |
| 自定义域名 | `routes` | 公开仓库里是注释掉的例子；要绑就取消注释、写你自己的域名（如 `relay.example.com`）。不绑就用 `workers_dev = true` 的 `*.workers.dev` 地址 |
| 管理密钥 | Worker secret `ADMIN_KEY` | `wrangler secret put ADMIN_KEY`；`/admin/*` 管理接口要用；不设则这些接口全关 |
| 限额 | `[vars]` | 信封大小上限、每设备 / 每 IP 限速等，每项旁边有注释 |

`wrangler dev`（本机）不需要真的 KV id，占位符就能跑。

## 3. 部署

```bash
cd relay-cf
npm ci
npx wrangler login                                  # 浏览器授权一次
npx wrangler kv namespace create ALLOWLIST          # 把 id 填进 wrangler.toml
npx wrangler secret put ADMIN_KEY                   # 可选，见上表
npx wrangler deploy                                 # 得到 https://morse-relay.<子域>.workers.dev
curl https://morse-relay.<子域>.workers.dev/healthz # {"ok":true,"limits":{…}}
```

`wrangler deploy` 会断开所有设备的长连接（客户端自动重连），升级时挑人少的时候。

## 4. 客户端指过去

客户端读 `~/.morse/config.json` 的 `relay.url`（没有就是官方的 `wss://relay.morse.im`）。改成你的中转：

```json
{ "relay": { "url": "wss://relay.example.com" } }
```

（或 `wss://morse-relay.<子域>.workers.dev`），然后重启 daemon。只试一次可以 `morse start --relay wss://relay.example.com`。地址是客户端按自己的钥匙算出来的（ADR-091），不需要在中转上登记；想互发消息的人要连同一个中转。

## 5. 本机验证（不碰 Cloudflare 账号）

```bash
(cd relay-cf && npm ci)
npm test                      # 含 relay-cf/test；起 wrangler dev 的那几个测试没装 relay-cf 依赖时自动跳过
scripts/morse-e2e-cf.sh       # 两台临时 HOME 的电脑经本机 wrangler dev 收发、离线、重连、附件
scripts/morse-e2e-addresses.sh
scripts/morse-e2e-files.sh
scripts/morse-e2e-requests.sh
```

这些都用 `wrangler dev`（本机 workerd，模拟 KV 和 Durable Objects），`XDG_CONFIG_HOME` 指到临时目录，不读你的 wrangler 登录、不部署任何东西；每台「电脑」是一个临时 HOME，不碰你真实的 `~/.morse`。

## 6. 运维

- 日志：`npx wrangler tail`，只有设备 ID、在线 / 离线 / 转发 / 拒绝，没有正文和密文。
- 改 `[vars]` 要重新 `deploy`；改白名单、发邀请不用。
- 费用：几个人、每天几百条消息落在免费额度内。注意 Durable Objects 单条 WebSocket 消息上限 1 MiB，所以 `MAX_BLOB_BYTES` 不要调到它以上；大文件由客户端分块（ADR-038）。部署前看一眼 Cloudflare 当前的 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/) 和 [Durable Objects 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
- 协议和存储细节见 [docs/specs/identity-v3.zh-CN.md](../specs/identity-v3.zh-CN.md) 和 `relay-cf/src/` 里每个文件开头的注释。
