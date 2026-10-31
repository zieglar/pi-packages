# 本地消息 Hook

CE 0.3 提供显式启用的本地 Hook，在消息提交后通知本地程序。Hook 不属于消息投递、ACK、Pi runtime 状态或 Wayforge 任务完成判定；不提供窗口自动化、远端命令选择、持久任务队列或 exactly-once 执行保证。

## 事件与路由

只有 Message 与 Payload BLOB 成功提交且结果为 `CREATED` 时，才产生 `ce.message.committed.v1`。`REPLAYED`、事务回滚和提交结果不明确都不产生事件。事件构造和调度位于 SQLite 写事务之外。

规则按 recipient 的完整 Endpoint 身份（`adapter` 与 `endpointId`）匹配，不按显示名称的子串猜测。ChatGPT → Pi 与 Pi → ChatGPT 可分别配置，Disabled 或不匹配的规则不会启动进程。

## 配置

在操作者控制的 MCP binding 或 Pi allowlist 中增加可选 `hooks` 数组；缺省表示没有 Hook。规则来自已经加载的配置，`/ce-hooks` 不会把之后的磁盘修改误报为 Active。

本轮支持 MCP binding 文件与显式 `CE_ALLOWLIST`／旧版 Pi allowlist。selected multi-session profile registration 尚不承载 Hook 规则，`/ce-hooks` 会注明此模式不支持。MCP 与 Pi 配置独立：ChatGPT → Pi 规则放在发送方 MCP binding，Pi → ChatGPT 规则放在发送方 Pi allowlist。

```json
{
  "hooks": [
    {
      "id": "pi-notify",
      "event": "ce.message.committed.v1",
      "recipient": { "adapter": "pi", "endpointId": "pi/main" },
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/local-hook.mjs", "--fixed-argument"],
      "timeoutMs": 30000,
      "enabled": true
    }
  ]
}
```

- `id` 在已加载配置中稳定且唯一。
- `event` 必须精确为 `ce.message.committed.v1`。
- `recipient` 必须同时包含 `adapter` 和 `endpointId`。
- `command` 必须是规范化绝对路径，`args` 只能包含本地固定字符串。CE 以 `shell:false` 直接执行，不会把 Payload 或远端文本插值到程序或参数中。
- `timeoutMs` 默认 30,000，可配置 1,000–60,000。规则存在时 `enabled` 默认是 `true`。
- 不要在参数或环境变量中放凭据。Hook 与 `payloadRead.enabled`、`ack.enabled` 是彼此独立的授权。

MCP 会在 Store 启动前拒绝无效 Hook 配置。Pi 会报告配置无效并将 active Hook 数降为 0，但不阻断消息功能。

## stdin 输入

子进程从 stdin 收到一个 UTF-8 JSON document，随后是 EOF。envelope 只包含引用和元数据：`schemaVersion`、`event`、`eventId`、`eventKey`、`messageId`、`exchangeId`、`sender`、`recipient`、`createdAt`、`payloadDigest`、`payloadLength`。

其中没有 `payload`、`payloadText`、命令字段、capability、Session ID、fencing token、host secret 或环境凭据。现有 Message 协议没有 correlation ID，因此不会凭空增加。digest 和 length 描述原始 UTF-8 Payload BLOB，而不是 JSON envelope。

脚本需要正文时，必须由独立获得授权的 Endpoint 通过 CE 正式 payload-read 接口读取。Hook 配置不继承也不创建读取权限。

## 执行与失败语义

每个 Runner 最多有 1 个活跃子进程和 32 个等待项，溢出记录 `SKIPPED_QUEUE_FULL`。子进程 stdout/stderr 会被忽略，不能污染 MCP stdio 或写入 CE 日志；仅提供最小环境。

按实际情况记录 `SUCCEEDED`、`FAILED`、`SPAWN_FAILED`、`TIMEOUT`、`SKIPPED_QUEUE_FULL` 和 `SKIPPED_SHUTDOWN`。脚本失败、程序缺失或超时不会自动重试，也不改变已提交的 send 结果、Delivery、ACK、Pi 状态或 Wayforge 完成判定。Shutdown 跳过未开始的工作；启动时不扫描旧 Audit，也不重放脚本。超时或缺少结束记录不能证明脚本没有副作用。

Shutdown 对活跃的直接子进程等待至其配置超时，CE ownership 释放不等待该脚本。超时向直接子进程发送 SIGKILL；这不是 sandbox，也不保证脚本派生进程或外部副作用已停止。

执行记录位于 `<store.directory>/ce-hooks/executions.jsonl`，只包含 Hook ID、event key、Message ID、开始/结束时间、状态、耗时、exit code/signal 和 timeout，不包含 Payload 正文或子进程输出。记录失败不影响 CE 消息状态。

## 配置审计

存在 Hook 配置时，Pi 启动会显示 active/configured 数量。在 Pi TUI 执行：

```text
/ce-hooks
```

命令显示当前进程实际加载的快照：Hook ID、event、精确 recipient、command、固定 args、timeout、enabled/disabled 和配置来源。它不会重新加载文件，也不会显示环境变量的值。MCP 启动时在 stderr 输出对应的脱敏数量摘要。
