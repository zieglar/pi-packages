[English](tunnel-manager-background.md) | [简体中文](tunnel-manager-background.zh-CN.md)

# Tunnel manager：真实后台范围（LOCAL-BACKGROUND-01）

本文说明 `/ce-tunnel start|status|stop` 的**真实后台**模式。离线模拟模式（`CE_TUNNEL_OFFLINE_TEST=1`，见 `tunnel-manager-offline.md`）不变。每个扩展 host 恰有一个 manager，两种模式不同时运行。

## 行为

- 将操作者管理的真实 client 启动为 **detached daemon**：`tunnel-client run --profile-file <profile>`。默认 profile 为 `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`，可用 `CE_TUNNEL_PROFILE` 覆盖。daemon 按设计可在 Pi session 结束后继续运行。
- 在 `<profileDir>/background-state.json` 持久化 ownership record（0600，原子 tmp+rename）：run id、pid、profile path **及** sha256、tunnel id、key file path、health url file、log path、spawn 后立即观测到的精确 `ps` command line 和 `ps` start-time key，以及 start/stop bookkeeping。
- 健康只来自真实探测：`tunnel-client health --url-file … --pid <owned> --require-control-plane-poll --json`，按冻结的 `health.ts` 规则解析，每次完成由共享 recorder 盖戳一次。PID 存活本身绝不等于 CONNECTED。
- 后台启动默认窗口为 **45s**，从 run 分配时计时。外部 client 0.0.16 默认初次 long-poll 30s，加 5s deadline guardrail，再给启动、探测及调度留 10s。这些是外部默认值，不是动态同步配置。共享离线模拟器保留 30s 窗口；显式 timing override 仍优先。required-poll readiness 和 verified cleanup 不变；不引入自动重启或超期恢复。
- 状态词为 `STOPPED / STARTING / CONNECTED / DEGRADED / UNKNOWN`。过期证据在读取时显示 UNKNOWN；纯读取不刷新状态。

## 硬边界

- **真实 Start 显式许可。** 除非操作者为本次 Pi session 精确设置 `CE_TUNNEL_BACKGROUND_ALLOW=1`，否则 `/ce-tunnel start` 拒绝 `CE_TUNNEL_BACKGROUND_UNAUTHORIZED`。`status`/`stop` 不受该开关限制：它们不创建费用，stop 只降低费用。
- **跨进程互斥。** Start/stop 及需要持久化的 refresh 持有 `<state>.lock.d`，这是用 pid + start key 验证 holder 的 mkdir DIRECTORY lock。陈旧/崩溃锁的回收在回收者间互斥：先 rename-to-grave，再核实 grave holder 仍是判定为 stale 的同一个锁；不匹配则回滚 rename 并拒绝 `CE_TUNNEL_MANAGER_BUSY`。无 holder 且不足 60s 的锁拒绝。所有 persist/signal 前重验锁 ownership；锁内重读 record，防止两个 Pi session 重复启动或发信号。
- **终止 ledger。** recorded run 必须先持久化 `termRequestedAt` intent 才能发信号；没有 ledger 就拒绝并保留 ownership。record 从未成功持久化的 run 由内存 once-set 保护，崩溃会同时丢失 record 和 guard。磁盘 ENOENT 或其他 run 的 stopped record 都不能丢弃该 pending ownership。
- **Stop 延迟。** stop 先等待其作废的 start 落定，界限为一次 probe timeout + identity capture + stop grace，再取锁；被取消的 start 仍拥有工作时不会返回。
- **双 run Stop。** 若 session 还拥有与磁盘 record 不同的未持久化 pending daemon，stop 会终止两者：pending run 用内存 once-set（最多一次 signal），磁盘 run 用 ledger。pending run 未退出时拒绝 `CE_TUNNEL_STOP_UNCONFIRMED`，状态提示再次 stop；仍有 owned run 存活时不报成功。
- **Ledger 写入约束。** 每次 `persist()` 都强制要求持锁 token，拒绝损坏 record，也拒绝覆盖其他 run 的 live record，任何代码路径都不能回滚其他 session 的 ownership/termination ledger。锁回收删除前核实 grave 的 inode、mtime、holder token 均与判定 stale 的锁一致。
- **三态检查。** `/bin/ps` 使用固定最小环境与 LC_ALL=C，结果为 present / proven-absent / unknown。Unknown 保留 ownership 并阻止 start，不能当退出证明。
- **Record 失败关闭。** 只有文件缺失才表示无 record；损坏或不可读为 `CE_TUNNEL_STATE_CORRUPT`，阻止 start/stop。
- **不接触凭据值。** key 只通过 profile 既有 `file:` reference 交给 client。manager 仅检查 key file 元数据（regular、非 symlink、owner-only 0600；`profile.ts` 的 `checkKeyFileRequirements`）。inline 值和 `env:` reference 拒绝 `CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED`。
- **Organization context（LOCAL-BACKGROUND-05）。** 可选 `control_plane.organization_id` 必须是双引号、无 escape 的 scalar，本地 grammar 为 `org-[A-Za-z0-9]{1,128}`。这只是有界语法策略，不证明服务器端 organization/Tunnel/Connector 绑定。缺失保留 legacy 行为；organization-scoped Tunnel 仍可能因此拒绝。空值、非法、重复（即使相同）字段及 extra-header override 均在 spawn 前拒绝。client 自行读取不变的显式 `--profile-file`。0.0.16 将 organization ID 表示为 `OpenAI-Organization` request header，优先级为 flags > environment > YAML > defaults。Manager 不添加 organization flags，保留最小环境白名单，不转发父进程的 `CONTROL_PLANE_*`、`OPENAI_*`、`TUNNEL_CLIENT_*`。因此这里只能从显式 profile 输入 organization。例如先核实目标非秘密元数据，再在 `control_plane` 下以两空格缩进添加 `organization_id: "org-Example123"`。既有 profile 不自动迁移；修改历史 Tunnel ID 或补 organization context 都需操作者明确批准。本地解析不证明真实认证或 Tunnel readiness。
- **PID 复用安全。** 后续 status/stop 都重验精确 command line 和 process start key。不匹配则 UNKNOWN / `CE_TUNNEL_EXTERNAL_INSTANCE`，不接管、不发信号。
- **Wrapper exec identity（LOCAL-BACKGROUND-03）。** Homebrew client 是 shim（`#!/bin/bash` 加 `exec "<Cellar libexec>" "$@"`）。exec 前 ps 为 `/bin/bash <shim> run …`，exec 后为 `<cellar> run …`，pid/start key 不变。spawn 时 manager 只读一次 client 文件，按显式证据推导身份集合：始终有 direct argv；仅无参数 `#!/abs/path` shebang 才加 `<interpreter> <shim>`；仅单条严格 `exec "<abs>" "$@"` 且目标为绝对、规范化、可打印、已存在 regular file 才加 post-exec 形式。后者持久化为 `commandIdentityExec`，供后续 session 识别。整个文件还必须是 canonical shim（shebang + 恰一条严格 exec，其他行只能空白/注释）；heredoc、缩进 exec、额外语句均失去资格。相对/未引用/多条 exec、目标缺失、文件过大或不可读等歧义不会生成该形式，保持拒绝。basename、pidfile、进程名不算证据。非 canonical wrapper 在 exec 后会变得不可管理：身份不符、UNKNOWN、`CE_TUNNEL_STOP_UNCONFIRMED`；不会误发信号，只能按文档另行人工核实身份后终止。identity capture 也只接受证据推导的集合，文件不可读会保留 unconfirmed pending run，不用 substring 匹配。
- **Pending-run PID 复用门槛（S-1/F1）。** 身份尚未捕获、仅在内存中的 run 保留 child handle。该 handle 的 exit event 证明本次 spawn 已死亡，之后同 PID 为外来复用者。证明按永不复用的 UUID runIds 归档；listener 在 identity-capture 窗口前安装，后续 start 不重置别的 run 的证据，双 run stop 不会断开它。dispose() 也在 pending run 存活期间保留证明，dispose 后仍可 stop/refresh。这样的 run 会按 exited 关闭，绝不接管或发信号；重新捕获必须同时有 live child link 和证据集合的精确匹配。Stop 提示区分 “exit observed after SIGTERM” 与 “exit observed (process already gone); no signal sent”。磁盘可选字段 `commandIdentityExec`、`termRequestedAt` 的 `null` 加载时归为 absent，不能伪造身份或压制 signal。已消失的 pending run 可直接 supersede，persist 前移除 `identityPending`，避免后续 start 误报 `CE_TUNNEL_STATE_CORRUPT`。
- **每 run 最多一次 SIGTERM。** `termRequestedAt` 持久化后，其他 Pi session 也不会重发。timeout 拒绝 `CE_TUNNEL_STOP_UNCONFIRMED` 并保留 record。不 SIGKILL、不 bulk kill、不按名称 signal；扫描仅用于拒绝重复 start。**Write-ahead 窗口：** record-backed run 若 intent 已持久化但 signal 丢失（如 `signal()` 前锁被取走），会刻意不重发；at-most-once 允许零次实际投递。只要进程存活，后续 stop 不重发，只报告 `CE_TUNNEL_STOP_UNCONFIRMED`。没有自动恢复；操作者需另行授权、人工核实身份后终止，绝不能清 ledger 绕过 guard。
- **无 autostart、reconnect、respawn 或业务 retry。** daemon 消失会标为 stopped 并注明 `process absent (unexpected)`；重启是新的显式 `/ce-tunnel start`。
- **Manager 绝不给 MCP child 发信号。** client 退出确认后，残留 profile 声明的 `mcp-stdio.js` child 只通过 `note` 报告，因为它属于 client。
- Session teardown（`shutdown`、`session_start`、reload）只释放该 host 的视图，不停止后台 daemon。
- Transport 状态不证明 delivery、ACK、reconciliation 或 completion；MCP reachable 不证明消息送达。

## 费用与授权

首次真实后台运行是付费连接，仍需操作者单独授权费用及窗口，并设置 `CE_TUNNEL_BACKGROUND_ALLOW=1`。命令是人工触发，没有无人值守路径。
