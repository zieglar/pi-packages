[English](README.md) | [简体中文](README.zh-CN.md)

# Pi Chat Exchange — ChatGPT Desktop 本地插件

这是 Desktop-only stdio 插件，不是 Tunnel client。它启动 bundled CE MCP server，提供 `ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`；`ce_ack` 仅在外置 binding 的独立 ACK opt-in 为 true 时提供。payload 工具存在不代表实际读取已获授权。

## 安装前配置

插件不包含实际 Endpoint、Store、credential 或 capability。将 `config/binding.example.json` 复制到系统账户的：

```text
~/.config/pi-chat-exchange/mcp-binding.json
```

把模板身份和路径替换为操作者核准的值，收紧文件权限。Store directory 必须是规范化绝对 POSIX 路径且不是 `/`。Pi 侧需互补 allowlist，并精确对齐 Store directory/file、Exchange namespace/idempotencyKey；两个 Endpoint 的 Ownership 仍独立。

`payloadRead.enabled` 和 `ack.enabled` 各自默认关闭，只有明确授权后才分别开启。ACK 仅记录 reception，不是 delivery、read、processing 或 task completion 的证明。

launcher 从系统 home 取得固定 binding 路径，不接受模型参数或环境变量选择身份。本地包诊断可显式传 `server/launch.mjs --config /normalized/absolute/path.json`；shipped `mcp.json` 不使用此 override。

## Runtime 与已知部署限制

- 支持 local plugins 的 ChatGPT Desktop；macOS 或 Linux。
- 当前 CE 0.2.1 要求 **Node >=22.19.0**，默认使用固定信任版本的 Rust Native SQLite。先在 Pi 侧按 [Native 管理](../../docs/native-management.zh-CN.md)准备驱动并重启，再使用同一系统账号的 Desktop MCP server。Store 支持仍为 macOS arm64 / Linux x64 GNU。`mcp.json` 应选择可信本地 Node，不能依赖 Desktop 受限 PATH。制品测试不认证真实 Desktop UI 安装或云传输。
- 分发包的 `mcp.json` 默认没有启用的 server；既不嵌入开发机路径，也不回退到未验证的 `node`。先将 ZIP 解压到本机私有、操作者拥有的目录，再执行下面的显式配置。
- 重新打包/刷新插件后用新对话发现工具；不要同时用 Tunnel 与本地插件争用同一个 Endpoint。

```sh
# 先把 artifact 解压至仓库外新建的私有目录，再替换下列路径
chmod 700 "/absolute/private/plugin"
"/trusted/absolute/node" "/absolute/private/plugin/server/configure.mjs" --node "/trusted/absolute/node"
```

将示例替换为本机路径（允许目录含空格）。配置器先检查路径、权限与完整 Node/SQLite 资格，只修改该本地副本的 `mcp.json`；不安装、注册或启动服务，不读取 binding 或 Store。已配置副本不会被静默覆盖；需重新配置时使用新的未配置副本。生成的 manifest 含本机绝对路径，不要重新分发；ZIP 与仓库模板保持未配置。此命令应在解压后的 artifact 上运行，不是未构建的源码模板。

插件根目录须由当前操作者拥有且权限恰为 `0700`，防止其他账户遍历或替换内部代码。若通过 marketplace 安装，复制完整 marketplace 到新的私有目录，将其中 `plugins/pi-chat-exchange` 设为 `0700`，运行该嵌套副本的配置器，并注册同一个私有 marketplace 根目录；不要配置独立插件副本后注册未配置的原始 marketplace。

macOS 同时检查根目录及祖先 ACL，仅接受无 ACL 或 deny-only 条目；allow ACL、检查失败或未知输出均拒绝（即使 POSIX mode 为 `0700`）。不会自动清除 ACL 或修改系统安装权限；请选用满足门槛的私有副本。

Pi host 也必须以批准 Node 启动；另配 MCP child 不会改变 Pi 正在使用的 Node。mise 不是运行要求。Secure Tunnel 使用者不需要此本地 stdio 插件或 Marketplace 安装。

Pi 侧 `/ce-tunnel doctor` 可分别检查当前 host、所选 child Node 和 Tunnel client 信任；它不检查 Desktop 的已安装 manifest，也不证明该客户端已加载工具。Desktop 以本机 configure 成功及新对话的实际工具发现为准。每个 Pi Session 的 Endpoint、当前身份、正常 deactivate 与 revoke 区别见[多 Session 指南](../../docs/multi-session-usage.zh-CN.md)。

源码仓库中的 [ChatGPT 安装指南](../../docs/chatgpt-installation.zh-CN.md)包含打包、marketplace、完整虚构 binding 和恢复限制。本 README 随 artifact 分发时，相对链接可能没有仓库 docs，请回到源码仓库阅读。
