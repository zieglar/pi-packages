# 本地消息 Hook

CE 0.3 提供显式启用的本地 Hook，在消息提交后通知本地程序。Hook 不属于消息投递、ACK、Pi runtime 状态或 Wayforge 任务完成判定；不提供窗口自动化、远端命令选择、持久任务队列或 exactly-once 执行保证。

## 事件与路由

只有 Message 与 Payload BLOB 成功提交且结果为 `CREATED` 时，才产生 `ce.message.committed.v1`。`REPLAYED`、事务回滚和提交结果不明确都不产生事件。事件构造和调度位于 SQLite 写事务之外。

规则按 recipient 的完整 Endpoint 身份（`adapter` 与 `endpointId`）匹配，不按显示名称的子串猜测。ChatGPT → Pi 与 Pi → ChatGPT 可分别配置，Disabled 或不匹配的规则不会启动进程。

## 配置

在操作者控制的 MCP binding、显式 `CE_ALLOWLIST`／旧版 Pi allowlist，或所选多会话 manifest 的各 registration 中增加可选 `hooks` 数组；缺省表示没有 Hook，保持向后兼容。

MCP 与 Pi 配置独立。ChatGPT → Pi 规则放在 MCP binding 的 `hooks` 中；多会话模式下，recipient 必须是已注册且 active 的 Pi Endpoint。Pi → ChatGPT 规则放在 Pi allowlist 的 `hooks` 中，或现有 `ce-multi-session-v1` manifest 对应 `registrations[]` 项的 `hooks` 中。各 registration 使用下方相同的规则语法，`recipient` 必须精确等于 `manifest.chatgptEndpoint`。manifest 没有全局 `hooks` 字段。Pi 仅投影对应 registration 的规则，Hook 不创建新权限。

多会话模式的有效规则是已加载快照与当前所选 generation 中完全相同且均 enabled 的静态规则交集。两侧 registration 的身份、Endpoint、epoch 和 active 状态必须持续有效；MCP 规则对应的已注册 recipient 也必须仍获准使用。移除、禁用或修改规则可立即收窄执行范围。当前配置新增或修改的规则不能扩大已加载快照；新增规则须通过正常生命周期重新加载所属进程／配置。

下方 JSON 是编写配置的片段，不是完整配置。多会话 MCP binding 与 manifest 是不可变 generation 内分别存储、通过 digest 配对的文件。应离线准备编写输入，再经现有、获操作者授权的受控 generation 流程发布；不要原地修改生产环境的内容寻址文件。本功能没有自动迁移或 Hook 配置 CLI，`/ce-tunnel convert` 与 `/ce-tunnel register` 不提供添加 Hook 的参数。

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

Runner 的可选准入门禁在每次实际启动子进程前检查当前策略，包括已排队的工作。拒绝时记录 `SKIPPED_POLICY_DENIED`，不启动子进程；不会取消已经运行的子进程。

按实际情况记录 `SUCCEEDED`、`FAILED`、`SPAWN_FAILED`、`TIMEOUT`、`SKIPPED_QUEUE_FULL`、`SKIPPED_SHUTDOWN` 和 `SKIPPED_POLICY_DENIED`。脚本失败、程序缺失或超时不会自动重试，也不改变已提交的 send 结果、Delivery、ACK、Pi 状态或 Wayforge 完成判定。Shutdown 跳过未开始的工作；启动时不扫描旧 Audit，也不重放脚本。超时或缺少结束记录不能证明脚本没有副作用。

Shutdown 对活跃的直接子进程等待至其配置超时，CE ownership 释放不等待该脚本。超时向直接子进程发送 SIGKILL；这不是 sandbox，也不保证脚本派生进程或外部副作用已停止。

执行记录位于 `<store.directory>/ce-hooks/executions.jsonl`，只包含 Hook ID、event key、Message ID、开始/结束时间、状态、耗时、exit code/signal 和 timeout，不包含 Payload 正文或子进程输出。记录失败不影响 CE 消息状态。

## 配置审计

存在 Hook 配置时，Pi 启动会显示 active/configured 数量。在 Pi TUI 执行：

```text
/ce-hooks
```

命令显示已加载的规则：Hook ID、event、精确 recipient、command、固定 args、timeout、enabled/disabled 和配置来源。`configured` 是已加载规则数；多会话模式下，`active` 是当前有效交集数量，来源显示为 `selected multi-session profile registration`。命令检查当前策略的准入结果，但不把新增规则加载进快照，也不显示环境变量的值。MCP 启动时在 stderr 输出对应的脱敏数量摘要。
