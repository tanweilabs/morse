# Phase 7 技术规格 —— 联系人之间 WebRTC 直连，中转兜底

> 创建：2026-11-13 · 最后更新：2026-11-14
> 决策依据：ADR-069。前置：ADR-028（设备身份）、Morse 端到端加密（`src/cluster/e2e.ts`）、ADR-034（局域网优先）、ADR-038（大文件分块）。
> 状态：第一步（联系人直连）实施中；第二步（自己设备之间迁到 WebRTC）只是计划，见 §10。

## 0. 目标

跨人（联系人）消息今天全部经 Cloudflare Workers 中转。目标：**能直连就直连，不能就照旧走中转**，对用户透明：

- 给联系人设备发消息时，先试 WebRTC 数据通道；约 3 秒建不起来，或者建好后中途断了，自动走原来的中转。
- 消息仍是原来的端到端加密信封（`SealedEnvelope`），直连只是**换一条路**，信封格式、收据、去重、分块传输（ADR-038）一律不变。
- 原生依赖 `node-datachannel` 是 `optionalDependencies`：装不上、加载失败，就自动只走中转，零编译安装路径不受影响。

不在本阶段：TURN（以后大文件再接 Cloudflare TURN）、iroh、自己设备之间（mTLS 局域网，`lan.ts` / `peers.ts` / `secure-transport.ts`）——这些不动。

## 1. 组件

| 组件 | 位置 | 作用 |
|---|---|---|
| 信令转发 | `relay-cf/src/hub.ts`、`relay-cf/src/signal.ts`（纯函数，可单测）（自托管 Node 版 `relay/` 当时也实现了同一帧，已在 2026-11-14 删除，ADR-076） | 新帧类型 `signal`：只在已认证设备之间转发，不存、不看内容 |
| 中转客户端 | `src/cluster/relay-client.ts` | `signal(to, blob)` 发信令；收到 `signal` 帧交给 `onSignal` |
| 直连层 | `src/cluster/direct.ts`（新） | 建连、信令签名与校验、分片、空闲关闭、失败退避；**只依赖一个抽象的信令通道接口**（§3.1），不绑死 Cloudflare 中转 |
| 路由 | `src/cluster/morse.ts` | 直连优先、中转兜底；结果里 `via: 'direct' \| 'relay' \| 'lan' \| 'self'` |
| 状态 | `src/format.ts`、`morse status` | 多一行 `direct: …` |

依赖：`node-datachannel ~0.33.6`（libdatachannel 的 N-API 绑定，N-API 8，`engines.node >=18.20`）。它自己**没有安装脚本**，原生二进制在按平台拆分的子包里（`@node-datachannel/darwin-arm64`、`darwin-x64`、`linux-x64-gnu`、`linux-x64-musl`、`linux-arm64-gnu`、`win32-x64-msvc` 等，都是它的 optionalDependencies）。N-API 与 Node 版本无关，所以 Node 20 / 22 用同一个包。

## 2. 中转协议增量（向后兼容）

```
client → {type:"signal", rid, to, blob}     → {type:"signaled", rid}   对方有在线连接，已推过去
                                            → {type:"offline", rid}    对方不在线
                                            → {type:"error", rid, error}
relay  → {type:"signal", from, fromHandle?, blob, ts}
```

规则：

1. 只有**已登录**（挑战签名通过、在白名单上）且**非 passive** 的连接能发 `signal`；接收方必须在白名单上，且只推给它的非 passive 在线连接。
2. `blob` 为非空字符串，**最多 64 KiB**（`MAX_SIGNAL_BYTES`）；超了回 `error`。
3. 单独的令牌桶：每设备每分钟 **240** 条信令（不占消息的 120/分钟）。超了回 `error: rate limited`。
4. **不存**：和 `send` 一样只经 Durable Object 之间的 `/signal` 内部请求推到对方的在线 socket，不进 storage、不打日志内容（只记 `from → to signal (n bytes)`）。
5. 兼容：
   - **老客户端收到 `signal` 帧**：`relay-client.ts` 的 `switch` 对未知类型直接忽略（`default: return`），不会崩；只是不应答，新客户端 3 秒后退回中转。
   - **新客户端连老中转**：老中转对未知请求回 `{type:"error", error:"unknown request"}`；客户端据此判定「这个中转不支持信令」，1 小时内不再尝试直连（重连中转时重置）。
   - 现有帧类型、字段、关闭码全部不变。

## 3. 直连层（`src/cluster/direct.ts`）

### 3.1 与传输无关的接口

```ts
interface SignalChannel {             // 第一步：Cloudflare 中转；第二步可换成局域网本地信令
  send(to: string, blob: string): Promise<'sent' | 'offline'>;
}
// 入站：调用方把收到的信令交给 direct.onSignal(from, blob)
```

`direct.ts` 只认设备 ID、`SignalChannel`、`recipientKey(id)`（拿对方已校验的 X25519 公钥）和 `isPeer(id)`（是不是已知联系人 / 已配对设备）。它不知道中转 URL、handle、Durable Object。

### 3.2 信令内容与签名（防中转伪造）

每条信令都是一个**完整的 Morse 端到端信封**：`seal()`（发送方 Ed25519 签名 + 发给接收方 X25519 加密），明文为：

```json
{"t":"morse-direct-v1","type":"offer|answer|candidate","session":"<16 字节 hex>","ts":1731470000000,
 "sdp":"…"            // offer / answer
 "candidate":"…","mid":"0"   // candidate
}
```

接收方依次检查，任一不过就丢弃（只记日志，不应答）：

1. `open()` 通过：证书的 SHA-256 = 信封里的 `from`，Ed25519 签名有效，`to` 是本机。
2. 信封 `from` == 中转报告的发送方（中转登录时已认证）。
3. `isPeer(from)`：**只接受已知联系人 / 已配对设备**（trust 里有、且没被拉黑）；陌生人（消息请求阶段）一律不建直连。
4. `t` 正确、`|now − ts| ≤ 2 分钟`；信封 `nonce` 5 分钟内没见过（防重放）。

**DTLS 指纹绑定设备身份**：offer / answer 的 SDP 里有 `a=fingerprint:sha-256 …`，而整份 SDP 在发送方设备私钥签过名的信封里。libdatachannel 在 DTLS 握手时按远端 SDP 的指纹校验对方证书（不关闭 `disableFingerprintVerification`）；通道打开后我们再用 `pc.remoteFingerprint()` 和签名 SDP 里的指纹比一次，不一致立即关闭并退避。所以中转（或任何中间人）既不能伪造 offer / answer / candidate，也不能把通道劫持到自己那里。附带好处：SDP 和候选地址（含内网 IP）对中转是密文，中转看不到。

纵深防御：通道上传的仍是端到端信封，`receive()` 照旧验签，并要求信封 `from` == 直连对端的设备 ID。

### 3.3 建连流程

- **发起方**（有消息要发的一方）：`new PeerConnection`，STUN `stun:stun.cloudflare.com:3478`，建一个可靠有序的数据通道 `morse`；本地 offer、每个候选都签名加密后经 `SignalChannel` 发出（trickle ICE）。
- **应答方**：收到合格 offer → 新建 `PeerConnection`，设远端描述，自动生成 answer 发回；远端描述设好之前到的候选先排队。
- **同时发起（glare）**：双方都在发起时，设备 ID 字典序小的一方保留自己的 offer、忽略对方的；大的一方放弃自己的、应答对方的。等待中的发送不受影响（等的是「到这台设备的通道打开」，不是某一次会话）。
- 对方重启后发来新会话的 offer：替换旧连接。
- 应答方 15 秒内没打开就关闭（防半截会话占资源）。

### 3.4 时限、复用与退避

| 参数 | 默认 |
|---|---|
| 建连时限（发送方等通道打开） | 3 秒 |
| 空闲关闭（收发都没有） | 5 分钟 |
| 建连失败退避（该设备不再试直连） | 5 分钟起，每次翻倍，最多 6 小时；成功一次清零 |
| 中转不支持信令 | 1 小时内不试，中转重连时重置 |
| 直连发出后等收据 | `min(收据超时/2, 5 秒)`，没等到就关掉这条直连（退避 1 分钟）并改走中转重发 |

通道断开（`closed` / ICE `failed` / `disconnected`）立刻关闭并通知等待中的发送。

**一建就失败的再呼一次**（2026-11-14 加）：我们呼出的连接在开始后 1 秒内就报 `failed`（本机回环上实测约 3000 次里 1 次：ICE 已 `completed`，传输层随即关闭，原因在原生库里、没查到底），不记退避，立刻用新的会话再呼一次，仍算在发送方本来就在等的那 3 秒里；第二次还失败才按上表退避、改走中转。以前这样一次偶发失败就让这台设备 5 分钟只走中转，`test/direct.test.ts` 里也表现为首发偶发返回 `false`。

### 3.5 分片

数据通道单条消息上限由 SCTP 协商（libdatachannel 默认 256 KiB），中转信封最大约 1 MB。每个信封按 `min(maxMessageSize − 13, 64 KiB)` 切片，二进制帧：

```
[1B 类型=1][4B 消息序号 BE][4B 片序号 BE][4B 片总数 BE][负载]
```

通道可靠有序，但**接收方不依赖帧交到手里的先后**（2026-11-14 改）：机器负载高时 node-datachannel 的消息回调会前后颠倒（实测 `… f3 f5 f4 f6 …`，一片不少），以前按到达顺序拼接，一颠倒就整条丢弃（`out of sequence`）——发送方等不到收据、关掉直连改走中转，`test/direct.test.ts` 的大消息用例偶发超时就是这个。现在按帧头里的（消息序号，片序号）归位，一条消息的片到齐就交付；同一条直连上最多同时拼 4 条（多了丢最早没拼完的）。片序号 ≥ 总数、同一片来两次、总数变化、单条超过 4 MiB（`maxMessageBytes`）都丢弃该消息（发送方收不到收据，会照常重试）。同理，数据帧可能比 `open` 回调先到：这时先做 `open` 的检查（DTLS 指纹）再处理这一帧，不丢。

## 4. 路由（`morse.ts`）

```
send(to, message):
  本机 → self
  局域网可达 → lan（ADR-034，不变）
  直连可用 && 对方是 trust 里的设备 && 不在退避期：
      seal → direct.send(≤3 s 建连) → 成功：等收据（≤5 s）
          收据到 → {ok, via:'direct'}
          通道断 / 没等到 → 关掉直连，改走中转重发（接收方按 (发送方, 消息 id) 去重）
  中转 → {ok, via:'relay'}（不变）
```

- 收据、分块传输的回执**从信封来的那条路回去**（2026-11-14 改）：信封从直连来的，回执用「直连开着就走直连，否则中转」的发送函数（不为它们新建直连）；信封从中转来的，回执走中转，只有中转发不出去（断了、对方不在线）才试已开着的直连。原因：发送方等不到收据会关掉直连、改走中转重发，而关闭通知到达对面之前，对面看这条直连还是开着的——这时把收据写进直连，发送方已经不读它了，收据丢失，发送方报「forwarded but no receipt」并在之后重发（机器负载高时关闭通知更晚到，`test/morse-direct.test.ts` 偶发失败就是这个）。分块传输（ADR-038）的报价和块可以新建直连，传输进度里 `via` 记 `direct` 或 `relay`。
- **大于中转单条上限的数据**：直连不通时照 ADR-038 分块走中转（每块一个 ≤ 1 MB 信封，确认和断点续传不变）；这次不接 TURN。
- 中转断开、但到该设备的直连还开着：直接走直连，不用等中转。
- 收到的消息入库时 `parts[].via` **仍记 `morse-relay`**（含义是「端到端信封这条路」，插件、e2e 脚本、hook 都按它判断）；实际走的哪条路看日志和发送结果。

## 5. 可观测

- 发送：日志 `morse: <id8> → <label> delivered via direct (…)`；直连失败 `morse: <id8> → <label> direct failed (…) — falling back to relay`；dispatcher 的状态轨迹 `relayed-to:<device> via direct`。
- 接收：`direct: received <id8> from @… via direct`。
- 建连：`direct: link to <id7> open (<本地候选类型> ↔ <远端候选类型>, <ms> ms)` / `closed (idle|peer|failed)`。
- `morse status`：`direct: on — 2 link(s) open (abc1234, def5678)` / `direct: off — node-datachannel not installed (relay only)` / `direct: off (morse.direct.enabled = false)`。

## 6. 配置

`~/.morse/config.json`：

```json
{"morse": {"direct": {"enabled": true, "stun": ["stun:stun.cloudflare.com:3478"]}}}
```

环境变量 `MORSE_DIRECT=0` 也能关（e2e 脚本、排障用）。默认开。

## 7. 原生依赖与回退

- `package.json`：`"optionalDependencies": {"node-datachannel": "~0.33.6"}`。npm 对 optionalDependencies 装不上不报错。
- 加载：`direct.ts` 用动态 `import('node-datachannel')`，包在 try/catch 里；失败（没装、平台没预编译包、ABI 问题）→ `direct: off — <原因>`，一切走中转。顶层 `import` 里不出现这个包，所以 `dist/` 在没有它的机器上照样能跑。
- 预编译覆盖（npm registry 核对，2026-11-13）：darwin-arm64、darwin-x64、linux-x64-gnu、linux-x64-musl、linux-arm64-gnu/musl、win32-x64/arm64。N-API 8 → Node 18.20+ 全部可用（含 20 / 22）。本机 macOS arm64 实测 Node 22 和 Node 24（同一个二进制都能加载）；包挪走后 `loadRtc()` 返回 `node-datachannel is not installed`、守护进程打印 `direct: off …`。darwin-x64、linux-x64、Node 20 待 CI / 真机。
- **为什么不用 werift**（纯 TypeScript 的 WebRTC，零原生模块）：评估过，见 ADR-069「依赖选择」——0.25 起要求 Node ≥ 22（本仓库 ≥ 20）、拉进约 28 MB 依赖（含音视频库 mediabunny）、回环吞吐约为 node-datachannel 的 1/7。WebRTC 层只经 `RtcModule` 接口使用，以后可以加 werift 适配器做无预编译包平台的兜底。

## 8. 测试

- `relay-cf/test/signal.test.ts`：信令帧校验、转发帧构造、大小上限、限流（纯函数）。
- `test/direct.test.ts`：两个 `DirectLink` 用内存信令通道，真 node-datachannel 在本机回环建连、收发、大消息分片、帧乱序到达仍能拼好、数据帧先于 open 回调到达不丢、空闲关闭；伪造 / 篡改 / 重放 / 陌生人的信令被丢弃；模块不可用 → `available()=false`；建连超时 → 退避。
- `test/morse-direct.test.ts`：两个 `startMorse` 经内存假中转（`test/helpers/fake-relay.ts` 支持 `signal`）——直连成功 `via:'direct'`、链路复用、回信也走直连；对方不应答 → 3 秒内退回中转、之后不再等；直连上没等到收据 / 直连中途断 → 中转重发；发送方已放弃、对面还看着是开着的直连（关闭通知晚到）→ 收据从中转回来；老中转（不认 `signal`）→ 直接中转；陌生人不建直连；中转断开时已开的直连照样用；1 MB 文件分块走直连，直连不通时分块走中转。
- `relay-cf/test/direct-wrangler.test.ts`：起本地 `wrangler dev`（relay-cf，模拟 KV / DO，`XDG_CONFIG_HOME` 指向临时目录，不读本机 wrangler 登录、不部署），两个实例登录后建立直连并互发消息。没有 `relay-cf/node_modules/.bin/wrangler` 时跳过。

## 9. 风险与未做

- 两边都在对称 NAT 后（或公司网络封 UDP）：没有 TURN，直连建不起来，3 秒后走中转——正确但首条消息慢 3 秒；退避后不再付这个代价。
- 线上 relay-cf 需要部署后才转发 `signal`；部署前新客户端遇到 `unknown request`，自动只走中转。
- 两边都在 NAT 后的真机实测还没做（2026-11-13 只验证过锥形 NAT ↔ 公网服务器）。
- 分块传输的限速仍按中转的速率算（保守）；直连上可放开，留待后续。

## 10. 后续计划：第二步，自己设备之间也迁到 WebRTC（本人 2026-11-13 定，本阶段不实现）

WebRTC 分两步走：

1. **第一步（本规格）**：联系人之间直连，信令走 Cloudflare 中转。
2. **第二步**：等第一步稳定、并且验证过 `node-datachannel` 在各平台都能装上、跑稳之后，把**自己设备之间**（现在走 `lan.ts` / `peers.ts` / `secure-transport.ts` 的 mTLS）也迁到 WebRTC 数据通道。要求：
   - **保留 mDNS 发现**；
   - **局域网内的信令走本地网络，不依赖 Cloudflare**：断网的局域网照样能用；
   - **迁移期间 mTLS 通道保留作兜底**（原生依赖装不上的机器靠它），全部稳定后再删。

为第二步预留：`direct.ts` 只依赖 §3.1 的 `SignalChannel` 接口和设备身份，不认识中转；第二步加一个局域网信令通道（例如经现有 mTLS 对端 API 或 mDNS 发现到的本地端点）实现同一个接口即可，签名、指纹绑定、分片、退避都复用。
