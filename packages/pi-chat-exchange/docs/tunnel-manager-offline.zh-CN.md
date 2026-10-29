[English](tunnel-manager-offline.md) | [简体中文](tunnel-manager-offline.zh-CN.md)

# Tunnel manager：离线范围（HOST-09 B1.1）

本文记录 HOST-09 B1.1 保留的**显式离线 harness**：masked capture、限定 scope 的 Keychain CRUD，以及自有离线模拟器生命周期。它是历史范围说明，不是当前真实 profile 设置指南。Kit Setup Wizard 与持久 Manager 见 [`tunnel-setup.md`](tunnel-setup.zh-CN.md)。只有 `CE_TUNNEL_OFFLINE_TEST=1` 才能进入 synthetic setup 和 Keychain authorization。

## 已实现范围

| 领域 | 模块 | 范围 |
|---|---|---|
| Masked credential capture | `src/tunnel/secure-input.ts` | `ui.custom` 组件，仅 TUI |
| Keychain CRUD | `src/tunnel/keychain.ts` + `native/tunnel-keychain.swift` | 每个 validated scope 恰一个 item |
| Offline simulator | `src/tunnel/offline-client.ts` | fake client，无 socket、无 credential |
| Owned lifecycle | `src/tunnel/manager.ts` | 仅该模拟器的 start/stop/status |
| Commands and status | `packages/pi-chat-exchange/pi-extension/index.ts` | `/ce-tunnel setup\|authorize\|start\|stop\|status\|help` |

## 硬边界

- **模拟器不能启动真实 client。** credential hand-off 仍被阻止。独立真实后台 Manager 的真实 start 需要精确 `CE_TUNNEL_BACKGROUND_ALLOW=1` 和已验证的真实 profile；status/setup/stop 不创建连接，不受此许可开关限制，见真实设置指南。plaintext key 不进入 child argv 或环境。
- **模拟器需显式 opt-in**：精确字符串 `CE_TUNNEL_OFFLINE_TEST=1`。未设置时扩展选择独立真实后台 Manager，不会悄悄启用模拟器凭据行为。
- **无 autostart、restart、auto-respawn。** 意外退出（包括 exit code 0）变为 `Error`，需显式 `start`。
- **只给自有 child 发信号。** 不从磁盘、lock file 或进程列表接管 PID；没有 `adopt`/`attach` API。
- **每 run 最多一次 SIGTERM request，无 SIGKILL 或盲 signal retry。** timeout 拒绝 `CE_TUNNEL_STOP_UNCONFIRMED`，保留 owned handle。重复 stop/dispose 等待同一 child 的真实退出，不重发。legacy `killTimeoutMs` 不启用升级终止。
- **ChildProcess `error` 事件不证明退出。** 进程仍活着但 signal 无法送达时也会触发，因此 pid 继续归属，状态为 `Error`/unconfirmed，`stop()` 等待实际 `exit`/`close`。error protection 在取得 handle 后立即安装，包括无 PID 的 spawn 失败，且保留至迟到/重复事件。无 PID child 不接管、不 signal；有效 owned child 不因 error 就被替换。
- **健康记录需严格递增的整数 `sequence`。** 重复、重放、缺失、非整数或非正数在任何 completion 盖戳前拒绝，不能刷新过期状态。记录还必须显式 `simulated: true`，且属于 live owned run/PID；child 退出后到达的记录不改变状态。
- `setup` 只写 **synthetic offline scope**（`https://offline-b11.invalid` + `tunnel_b11offline`），不读既有生产 profile、config 或 key。
- `authorize`（B1.1-INTEGRATION）是唯一由用户触发的原生 macOS keychain authorization 路径。它对已存 synthetic credential 做一次交互 read，操作者亲自选择 macOS prompt 的 Allow（仅本次）、Always Allow（此精确 helper build 可无人值守读取，直到 CODE IDENTITY 改变；普通 deterministic recompile 保持身份）或 Deny/Cancel（无改变）。后续 noninteractive read 报告所选状态。credential 值不可见并被丢弃，只暴露固定码 `CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED`、`CE_TUNNEL_KEYCHAIN_USER_CANCELED`。

## 状态段

三个独立 key，彼此不构成证据：

| Key | 含义 |
|---|---|
| `ce` | 本 session 的 CE runtime binding；CE unavailable 时不伪造 |
| `ce-tunnel` | Offline/simulated transport 状态，始终带 `(offline simulated)` |
| `ce-client` | 仅本 run 实际归属的 simulator record 出现后显示 `simulated activity observed this run`；否则 `no activity observed this run` |

Transport 状态不证明 delivery、ACK、reconciliation 或 completion。任何段都不声称 client online；未观察到活动只报告 “not observed”，不说 “offline”。

Status 是**只读 freshness projection**：可显示 expiry 或 `Unknown`，但不重置/推进 recovery counter、不盖 health completion 戳、不刷新证据、不改 run identity。即使中间读取 status，M 次独立 healthy completion 仍能恢复 disconnected run。

Transport teardown（shutdown/reload/session_start）等待 owned child 实际退出，或有界 unconfirmed-stop refusal；即使 CE disabled 或 CE release 失败也如此。重叠 teardown 共用一次 release。Manager `dispose()` 在 stop 未确认时拒绝。扩展记录拒绝，不将其抛入 CE cleanup，保留 manager 并阻止替换；后续 teardown 继续等待同一 child，不重发 signal。只有实际 exit/close 才允许成功 dispose 和替换。下一次 `/ce-tunnel` 报告固定码 `CE_TUNNEL_STOP_UNCONFIRMED`。CE release/fencing authority 不变。

## 凭据输入属性

- 要求 `ctx.mode === "tui"` **且**可用 `ui.custom`。`hasUI` 不够，因为 RPC 也可能为 true。非 TUI 拒绝 `CE_TUNNEL_INPUT_UNAVAILABLE`，不降级为 plaintext 路径。
- 有界单行 **visible ASCII**，不含空格、控制字节、非 ASCII，最多 512 字符。Bracketed paste 原子校验：非法 paste 整体拒绝，粘贴 newline 不提交。
- secret 只进入 Keychain writer 一个 sink，不进入 `ui.input`、主 editor、`pasteToEditor`、`notify`、`sendMessage`、`appendEntry`、日志或返回 outcome。
- submit / Escape / Ctrl-C / timeout / external abort / dispose 共用一次幂等 finish。`ui.custom` 不内置 abort/timeout，因此本组件实现两者。**Dispose 本身也是 outcome**：外部 dispose 使 capture 恰一次落为 `cancelled/aborted`，session teardown 不会永久等候。即使 runtime 在 `done` 内重入 dispose，也不会二次 finish。
- **Masking 不等于内存擦除。** JavaScript string 不可变，不承诺完整 zeroization。terminal paste buffer、crash dump、terminal recording、同用户进程访问仍是独立暴露面。

## Keychain 属性

- 固定 service `pi-chat-exchange-tunnel`；account 是 validated canonical scope 的 `v1:sha256(origin + NUL + tunnelId)`。
- 固定操作 allowlist（`exists`/`read`/`create`/`update`/`delete`），精确 class + service + account，一个 resolved keychain，update/delete 使用 exact item reference。不 enumeration、prefix、service-wide 或 search-list fallback。
- `create` 安装**显式空** trusted-application list，等同文档中的 `security -T ""`；不用 `nil`（creator trust）或 allow-all（`-A`）。`read`/`update` 拒绝更宽 ACL，不接管/修复；请求 secret 前先用 metadata-only 解析 exact item、验证 ACL，再对该 item reference 调用 `SecKeychainItemCopyContent`。不改 partition list，不自动处理 OS prompt。
- ACL 校验失败关闭：无法复制 access object、ACL list 缺失/为空、authorization list 不可读、application list 为 `nil`（all applications）均拒绝 `acl_too_broad`。空 trusted-application list 只有在实际覆盖 secret-reading authorization 的 ACL 上才具限制作用。
- secret 仅通过 **framed stdin** 跨进程，不出现在 argv、环境、compiler 参数、文件或 shell string。raw stdout/stderr 不转发，只输出固定 `CE_TUNNEL_*` 码。helper 对 fd 0 使用同一 reader，以有界 header scan（≤ 96 bytes）加 exact-length payload read 读取。不用 `readLine`（stdio buffering 会与 fd 0 失步）或 `readDataToEndOfFile`（长度门槛前就分配）。声明 frame 后多余字节为协议违规。
- 只有原生 `errSecItemNotFound`（-25300）表示 missing，不接受 `security(1)` CLI 的 exit 44 惯例。
- 模糊 timeout 绝不重试：mutation 可能已提交，必须先核对 exact item。
- 编译串行化：并发操作共享一次 compile 和一个 owner-only temporary directory。compile 中的 `dispose()` 等待并释放在途 artifact，不泄漏目录；artifact 恰释放一次。

### Probe keychain 定位（仅 test/probe）

helper 默认在进程内解析 default keychain，生产行为不变。显式构造的 test runner 可指定恰一个 keychain file，helper 用 `SecKeychainOpen` 打开并以 `SecKeychainGetStatus` 探测：

```ts
createNativeKeychainRunner({ probeKeychainPath: "/tmp/b11-probe/owned.keychain" })
```

这让授权 probe 能使用独占 temporary keychain，不修改 default keychain 或 search list。绝不调用 `SecKeychainSetDefault`、`SecKeychainSetSearchList`。路径只接受此构造选项，不接受环境、CE command、profile 或 `KeychainRequest`（request 上任何 `keychainPath` 字段均被结构性忽略）。路径必须 absolute、single-line、无 NUL、无空格且 ≤ 1024 bytes，否则 spawn 前拒绝 `CE_TUNNEL_KEYCHAIN_UNAVAILABLE`。自 B2-P2（S2-04 removal）起 TS runner 只接受 `v1:<sha256 hex>` account；旧 `b11-probe:` grammar 拒绝同码，不读取无关 item。

### Native helper request frame

```text
stdin:  "v1 <op> <accountBytes> <secretBytes>[ <keychainPathBytes>][ interactive]\n"
        + <account bytes> + <secret bytes> + <keychain path bytes>
op   ∈  exists | read | create | update | delete
service = "pi-chat-exchange-tunnel"   (compiled in, never an input)
account = v1:<sha256 hex>   (b11-probe grammar removed in B2-P2; refused by the runner)
```

没有 `probeKeychainPath` 时 header 恰四字段，frame 仅 account 和 create/update 的 secret。有该选项时追加第五字段与 path bytes。B1.1-INTEGRATION 增加可选末尾 literal `interactive`，仅 read 接受，位于可选 probe-length 字段后；六字段形式为 `v1 read <a> <s> <k> interactive`，触发用户控制的原生授权 read。token 不是数字，五字段形式仍无歧义。`stdout` 恰一行 JSON：
`{"status":"ok"}` | `{"status":"ok","secretBase64":"…"}` |
`{"status":"not_found"}` |
`{"status":"error","reason":"bad_request|unavailable|acl_too_broad|already_exists|authorization_required|user_canceled"}`。
`authorization_required` 是原生 -25293 类，表示此 code identity 尚无用户决定；`user_canceled` 是 -128 类，表示操作者关闭原生 prompt。UPDATE 比 READ 更严格：`update` 只接受 pristine empty-list 状态，非空 read trusted list 拒绝 `acl_too_broad`，因此 Always Allow 后轮换需 delete + create + 新的一次授权。

Round-3 hardening（Lane S S-R2-01）：`update` 还要求每个承载 ChangeACL 或 Any authorization 的 ACL 都有显式空、非 nil trusted-application list，且至少有一个 governance ACL。即使 read list 为空，另一个 ChangeACL ACL 已指定程序也会拒绝，因为该程序收到新 secret 后可无人值守将自己加入 read list。governance state 缺失/不可读则失败关闭；helper 不接管、修复或重建该 item。

## 验证与剩余限制（B1.1）

以下是历史验证记录，不扩展当前支持范围：

- Swift helper 编译时有 legacy API deprecation warnings。父会话运行的 probe 在独占 temporary Keychain 中，用两个唯一 synthetic account 测试 production adapter。create、metadata existence、update、exact deletion、account isolation 通过。实际 ACL 元数据显示 secret-reading authorization 的 trusted-application list 为空。自有 fake item 上刻意放宽的 ACL 对 read/update 均拒绝。
- **历史说明：** 下一项是 B1.1-FIX 当时的边界；后续 B1.1-KEYCHAIN-GATE 与 B1.1-INTEGRATION 已通过用户批准路径，验证 restrictive ACL 下真实成功读取。
- **B1.1-FIX 当时：成功 Keychain retrieval 仍为 NOT VERIFIED。** restrictive item 的 read 返回 `CE_TUNNEL_KEYCHAIN_UNAVAILABLE`，无法成功比较值。未为通过而放宽 ACL、授予 helper trust 或批准 OS prompt。update 成功本身不证明结果 secret 值。这不构成完整 CRUD 成功或 B2 readiness 声明。
- 父会话在 network-denied PTY 中，用隔离 agent directory 和持久 Session JSONL，测试实际安装 Pi 1.3.0 TUI 与 production component。Submit 使用 synthetic in-memory writer；观察到 cancel、Ctrl-C、timeout、dispose、abort、writer rejection、non-TUI refusal。raw output、output logs、decoded session strings 中没有完整/长片段/编码 synthetic canary。这不证明真实 Keychain setup 端到端成功、通用 terminal/clipboard 安全或 memory zeroization。
- CE disabled 下测试了 production extension help、setup cancellation 和显式 opt-in 的 bundled simulator start/status/stop。未测试真实 client、provider request、control plane、delivery、ACK 或 completion。
- 详细 immutable evidence 和最终 acceptance decision 位于外部 HANDOFF-CE-HOST-09-TUNNEL-MANAGEMENT B1.1 report。这些有界结果不授权真实 credential hand-off 或任何 B2 execution。
