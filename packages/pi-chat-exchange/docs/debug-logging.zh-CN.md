[English](debug-logging.md) | [简体中文](debug-logging.zh-CN.md)

# 开发诊断（DIAG-01）

诊断始终开启，不需要环境开关、logger 依赖或协议扩展。它观测现有入口，不授予工具权限、不改变 ACK/Authority 规则、不恢复 ownership，也不把回复变成 MCP 证据。

## 输出与隐私

每条 JSONL 记录都有 `ts`（ISO 8601）、`pid`、`component` 和 `event`。logger 在打包的 debug 插件中使用 `server/.debug-logs/`，源码 checkout 则使用 `dist/` 旁的 `.debug-logs/`，按 PID 写入私有文件，并尽力镜像到 stderr。**绝不写 stdout。** 文件、序列化和 stderr 失败会被忽略，不转成业务失败。原 stderr 状态码不变。

日志只包含显式投影的元数据：已知 JSON-RPC 方法、数字 request ID（字符串 ID 只记类型/长度）、已知工具名、参数字段名/类型/字符串长度、阶段/计数/结果/耗时，以及净化后的栈文件 basename/行/列。不记录完整参数、payload、结果正文、config、env、凭据或错误消息。fatal error 保留 Node 默认失败/退出行为；净化 JSONL 不替换其原生 stderr 栈。分享证据时需单独检查原生 stderr。

## 独立制品

冻结的 `pi-chat-exchange-gate-b1` 0.1.5 保持不变。先运行 `pnpm run build`，再构建独立的 `pi-chat-exchange-gate-b1-debug`（`0.1.0-debug.3`）；两条命令均从 `packages/pi-chat-exchange/` 执行：

```sh
node scripts/package-debug-plugin.mjs \
  --root /absolute/isolated-debug-root \
  --dependencies /absolute/existing-materialized/node_modules
```

隔离根目录必须已有 `mcp-config/binding.json`，且其 Store 位于该根目录下。配置/Store 祖先的 symlink 和链接输入树会被拒绝。根目录不能是 home 或位于 `~/.codex` 下。builder 不安装依赖，已有 `marketplace/` 输出时拒绝。

输出为 `marketplace/plugins/pi-chat-exchange-gate-b1-debug/`。只在隔离 Desktop CODEX_HOME 中注册它的新 marketplace/cache。内置 `./bin/launch` 固定使用 `/opt/homebrew/bin/mise`，不下载，并在 launcher 与实际 server 中都预加载严格 Node `v24.21.0` guard。不匹配时 exit 78，不以预检子进程替代运行中检查。这验证运行中的 Node 版本，不验证 binary 来源。

生产 Store 的 capability policy（见 `runtime-qualification.md`）不会扩大此隔离 debug 派生制品的版本 pin。fatal-monitor 与 debug-launcher 成功测试仅在 24.21.0 运行；24.22.1 仍必须以 exit 78 拒绝。生产 Host/MCP 和本地插件资格与这些测试相互独立。

## 事件与解释

- Shell/launcher：`LAUNCH_STARTED`、`NODE_RESOLVED`、`NODE_VERSION`、`SERVER_EXEC_STARTED`、`LAUNCH_FAILED`、`SERVER_EXITED`、`LAUNCH_EXITED`。
- Guard：`VERSION_GUARD_STARTED`、`VERSION_GUARD_PASSED`、`VERSION_GUARD_FAILED`。
- Server/transport：`SERVER_ENTRY`、`SERVER_CREATED`、`TRANSPORT_CREATED`、`TRANSPORT_CONNECTED`、`SERVER_READY`、`SERVER_STOPPED`。
- Protocol：`MCP_REQUEST_RECEIVED`、`MCP_RESPONSE_SENT`、`MCP_ERROR`、`MCP_INITIALIZE`、`MCP_INITIALIZED`、`MCP_TOOLS_LIST`、`MCP_TOOLS_CALL`。
- Tool：`TOOL_REGISTERED`、`TOOL_CALL_STARTED`、`TOOL_DISPATCH`、`TOOL_CALL_COMPLETED`、`TOOL_CALL_FAILED`。`isError` 工具结果仍按原样返回，不转成抛出的异常。
- Store/Authority composition：`STORE_OPEN_STARTED`、`STORE_OPEN_COMPLETED`、`AUTHORITY_CHECK_STARTED`、`AUTHORITY_CHECK_RESULT`（heartbeat callback）、`OWNERSHIP_ACQUIRED`、`OWNERSHIP_RELEASED`。当前 bound-port API 不暴露 fencing；不会为获取它增加内部 Authority instrumentation。
- Process：`PROCESS_SIGNAL`、`UNCAUGHT_EXCEPTION`、`UNHANDLED_REJECTION`、`PROCESS_EXIT`。SIGKILL 无法观测。同一 PID 可以同时出现 guard 与入口的 exit/exception 记录，需区分 `component`。

`SERVER_READY` 表示 transport connected，不表示 client initialized。`MCP_INITIALIZE` 记录请求收到，不代表握手完成。`MCP_INITIALIZED` 记录 client notification，仍需分别核实 initialize response 和 `tools/list`。`NODE_RESOLVED` 表示执行 Node 的阶段，不独立保证解析/来源。没有日志文件，不能证明 Desktop 拒绝注册或某次对话用了特定 backend。

## 限制与安全验证

这是仅开发使用的同步 I/O，没有 rotation/retention 管理；监控磁盘并保持日志目录私有。既有攻击者控制的祖先目录和同用户竞态不在此私有制品的威胁模型内。不要部署到生产，不访问生产 Store。

直接协议测试使用新的隔离 fixtures，只做 initialize、tools/list、合法及非法 ping，不需要真实 ACK。Desktop 安装/发现不授予发送对话消息或调用工具的权限；若继续运行验证需要消息，应停止并申请授权。
