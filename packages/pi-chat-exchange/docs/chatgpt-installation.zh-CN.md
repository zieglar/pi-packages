[English](chatgpt-installation.md) | [简体中文](chatgpt-installation.zh-CN.md)

# ChatGPT 安装：Tunnel 与 Desktop 本地插件

有两条不同的部署路径，不要同时让它们占用同一个 CE Endpoint：

| 路径 | 连接方式 | 配置入口 |
|---|---|---|
| Secure MCP Tunnel | ChatGPT 自定义 MCP 插件选择 Tunnel，client 启动本机 MCP | [完整 Tunnel 快速开始](tunnel-setup.zh-CN.md)，无需本地 marketplace |
| Desktop 本地插件（本页后续） | ChatGPT Desktop 启动 bundled MCP，stdio | 外置 `mcp-binding.json`；操作者配置互补 Pi allowlist |

**不要**给 Tunnel generation 再复制一个 Desktop binding 当作同一客户端，也不要把 Desktop 默认路径误当成 Tunnel 使用的 `--config` 路径。两个模式共用 CE Host/Storage 契约，不共用进程所有权。

## Tunnel：ChatGPT 自定义 MCP

先按 [Tunnel 指南](tunnel-setup.zh-CN.md)完成 `/ce-tunnel doctor`、Setup / Advanced Messaging、显式 reload/activate 与单独 Start。在 [ChatGPT Plugins](https://chatgpt.com/plugins)选择 **+ → Add custom MCP server → Connection: Tunnel**，选择相同 Tunnel，按目标配置认证，审阅风险后创建并安装插件；当前对话用 `@` 选择它。工具变更在插...

## Desktop 适用条件与打包

要求：支持 local plugins 的 ChatGPT Desktop、macOS 或 Linux、开发候选 **Node.js >=24.20.0 <=24.22.2**（须满足 SQLite >=3.51.3、平台/编译安全与共享行为探针，不固定 SQLite/source ID）、仓库 pnpm 12.9.1。Node 24.19.0、25.9.0 因已复现的 native crash 被拒绝；26.12.1 仅作隔离预览。实测为 macOS arm64，不新增 Linux/Desktop UI 验收；已发布 npm 0.2.0 不变。Desktop 插件使用 `plugin.json`、根 `mcp.json`、`${PLUGIN_ROOT}` 与本地 stdio。

官方格式参考（客户端入口与组织资格以其当前文档为准）：

- <https://developers.openai.com/plugins/deploy/desktop-only>
- <https://developers.openai.com/plugins/build/plugins>

在已选中批准 Node 的 shell，从仓库根目录安装依赖，然后打包（无需 mise）：

```sh
node --version
pnpm install --frozen-lockfile
cd packages/pi-chat-exchange
pnpm run package:desktop-plugin
```

生成的 ignored artifacts：

- `.plugin-build/pi-chat-exchange-0.2.0.zip`：单根 ZIP。
- `.plugin-build/marketplace/`：可注册的本地 marketplace。
- `.plugin-build/pi-chat-exchange/`：解包检查副本。

包内含 compiled server 与生产依赖，不含 live Endpoint、Store、token、capability 或密钥。public directory 发布是独立流程，不能把本地 marketplace 安装解释成公开发布。

**本机运行时配置：** 分发 ZIP 和 marketplace 的 `mcp.json` 默认为空 server 集合，不包含机器路径，也不会执行未验证的 `node`。以下将完整 marketplace 复制到仓库外的新私有目录；已存在时应停止，不覆盖旧配置。将 Node 路径替换为本机可信批准 executable：

```sh
umask 077
mkdir -p "$HOME/.local/share"
MARKETPLACE="$HOME/.local/share/ce-marketplace-local"
mkdir -m 700 "$MARKETPLACE" && \
  cp -R .plugin-build/marketplace/. "$MARKETPLACE/" && \
  chmod 700 "$MARKETPLACE/plugins/pi-chat-exchange" && \
  "/trusted/absolute/node" "$MARKETPLACE/plugins/pi-chat-exchange/server/configure.mjs" --node "/trusted/absolute/node"
```

插件根目录必须由当前操作者拥有且权限恰为 `0700`；根目录、祖先及 Node 的路径/ACL 全链都须通过信任门槛。配置器不自动修复权限或清 ACL。它验证完整 Node/SQLite 资格后只生成该副本的绝对 stdio command，不安装/注册/启动、不读取 binding 或 Store。目录可含空格；生成的 manifest 属本机配置，不可重新分发。仓库、ZIP、原始 marketplace 保持未配置；配置与注册必须使用同一副本。Secure Tunnel 用户无需此流程。

## 创建外置 binding

binding 留在插件安装/cache 之外，默认由系统账户 home 定位：

```bash
umask 077
mkdir -p "$HOME/.config/pi-chat-exchange"
# 目标已存在则停止，先核实原配置，不覆盖
test ! -e "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  test ! -L "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  cp plugin/pi-chat-exchange/config/binding.example.json \
    "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  chmod 600 "$HOME/.config/pi-chat-exchange/mcp-binding.json"
```

下面是可解析的完整虚构示例，与 [Pi 指南](../pi-extension/README.zh-CN.md)的手工示例互补。路径与 Session placeholder 必须按本机授权替换；不要将示例当作已生效设置。payload/ACK 若未授权，分别保持 false。

```json
{
  "version": 1,
  "store": { "directory": "/srv/example-ce-store", "file": "ce-store.sqlite" },
  "exchange": { "namespace": "example-local", "idempotencyKey": "example-chatgpt-pi" },
  "endpoint": { "adapter": "chatgpt", "endpointId": "chatgpt/main" },
  "recipients": [{ "adapter": "pi", "endpointId": "pi/main" }],
  "lease": { "ttlSeconds": 120, "renewIntervalSeconds": 30 },
  "payloadRead": { "enabled": false },
  "ack": { "enabled": false },
  "debugExecutionGuard": { "enabled": false }
}
```

Store directory 必须为规范化绝对 POSIX 路径且不是 `/`，本地文件系统与权限门槛见[Storage security](storage-security.zh-CN.md)（当前源码打包清单已纳入；已发布历史制品内容以实际检查为准）。lease renewal interval 不超过 TTL 一半。双方 Store directory/file、Exchange namespace/idempotencyKey 四项必须一致；Endpoint 与 Ownership 各自独立。模板中的旧标签不是强制名称。

launcher 固定读取 `~/.config/pi-chat-exchange/mcp-binding.json`，不从模型参数或环境变量选身份。仅本地包诊断支持 strict normalized absolute `--config`；shipped `mcp.json` 不传这个 override。缺失/非法配置为 `CE_MCP_CONFIG_INVALID`，不降级成任意身份。

## 注册与使用

按[官方本地 marketplace 流程](https://developers.openai.com/plugins/build/plugins)，用支持该命令的 Codex CLI 注册上面已配置的同一私有目录（此处 `MARKETPLACE` 沿用前文同一 shell）：

```sh
codex plugin marketplace add "$MARKETPLACE"
codex plugin marketplace list
```

重启支持本地插件的 ChatGPT Desktop，在 Plugins Directory 选择 **Pi Chat Exchange Local**，安装 **Pi Chat Exchange**，新建对话核对工具。客户端可能从 plugin cache 的安装副本加载；目录权限和本机 Node 在实际安装环境中仍须合格，不能用打包测试替代 UI 验收。

更新时重新打包，复制到新的私有目录、收紧嵌套 plugin 根目录为 `0700`、配置后再注册；刷新/重装并新建对话，旧对话不保证重载。缺少资格或菜单不同时按官方说明核实，不绕过组织限制，也不要改用 Tunnel 来证明 Desktop 安装成功。

## 针对性验收与结果边界

在独立授权、两端先加入同一 Exchange 后验证：

1. 新对话启用 Pi Chat Exchange，`ping` 得到 `status: "reachable"`。
2. 发现 base tools：`ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`。即使 payload read 关闭，MCP 仍广告该工具，但实际读取拒绝；这不同于 Pi 按 opt-in 注册工具。
3. `ack.enabled` exact true 时额外提供 `ce_ack`，否则不广告并拒绝调用；ACK 不顺带开启 payload read。
4. 按[消息流程](tunnel-setup.zh-CN.md#4-双向-send--inbox--read--ack)双向 send → 独立 list → 授权 read → 单独授权 ACK，明确每一步证据。

packaged artifact 测试验证 stdio/tool discovery，不证明 Desktop UI 安装成功。当前已完成的实际 ChatGPT↔Pi 消息及 Tunnel 启停验收见[README](../README.zh-CN.md)；不能把 Tunnel 验收外推成每条 Desktop 安装路径都重新跑过。ACK 永远仅 reception，非 task completion。

## 显式 stale-ownership 恢复

正常 MCP/Pi 启动不接管已有 Owner。崩溃后 lease 到期也不自动接管；先由操作者核实进程确已丢失，再以只读连接检查准确 durable owner evidence。这是独立授权的恢复操作，**不是**通用启动前置步骤，也不是模型可调用工具。

CLI 在包目录，先 build；以下只是模板，不可直接执行，所有 `<...>` 都必须由操作者从已核实证据替换，不能猜测：

```bash
node scripts/recover-stale-ownership.mjs \
  --config /absolute/path/to/operator-binding.json \
  --confirm-endpoint '<adapter>/<endpointId>' \
  --expect-owner-session '<exact-owner-session>' \
  --expect-fencing-token '<exact-fencing-token>' \
  --expect-lease-started-at '<exact-lease-start-or-null>' \
  --expect-expires-at '<exact-expiry>' \
  > /operator-controlled/path/recovery-receipt.json
```

直接调用批准 Node，避免 `pnpm run` 的 banner 污染重定向 receipt。六个 flags 必须匹配 durable row；`--confirm-endpoint` 是 `<adapter>/<endpointId>`，**不是** `ce_send.to` 的 label 用法。历史无 lease start 的迁移行才用 literal `null`。该 CLI 使用 MCP binding 选择恢复目标，不支持拿 Pi allowlist 文件替代；Pi Endpoint 的事故恢复需另行核实目标与授权。

CLI 拒绝 live lease、缺失/不符证据和并发 loser；成功时绑定 recovery Session，执行现有原子 takeover，再 release/detach，fencing 单调增加。receipt 不含 capability/host secret，但内部标识符仍不应公开。

| 固定码 | 意义与操作边界 |
|---|---|
| `CE_RECOVERY_LAUNCH_INVALID` / `INVALID_REQUEST` / `CONFIG_INVALID`（后两项同 `CE_RECOVERY_` 前缀） | flags、配置、目标路径或字段非法；核实输入，不猜值 |
| `CE_RECOVERY_TARGET_MISMATCH` / `OWNER_ABSENT` / `OWNER_MISMATCH`（同前缀） | 无目标 Participant、无 Owner 或证据不符；重新核实，不能放宽确认 |
| `CE_RECOVERY_OWNER_ACTIVE` / `CLOCK_REGRESSION`（同前缀） | lease 仍活跃或时钟先于持久 term；拒绝恢复 |
| `CE_RECOVERY_RACE_LOST` / `BUSY`（同前缀） | 并发赢家或事务冲突；本次未据此取得 authority |
| `CE_RECOVERY_FAILED` | 写入前 fail closed |
| `CE_RECOVERY_OUTCOME_UNKNOWN` | durable outcome 未知，停止并核实，绝不盲重试 |

exit 0 表示恢复成功，exit 1 仅向 stderr 输出固定拒绝码；不是消息或工作流完成。Tunnel process ownership 的恢复是另一套边界，不能用这个 CLI 清理 Manager 锁。

## 支持限制

Windows 不满足当前绝对 POSIX path contract。缺失批准 Node、权限不符、Store identity/版本不符均 fail closed，不自动初始化替代 Store。诊断不应输出 key、capability、正文、完整日志或真实 Session 信息。其他常见问题统一见[排障](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复)。
