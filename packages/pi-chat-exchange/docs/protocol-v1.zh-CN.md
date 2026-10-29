[English](protocol-v1.md) | [简体中文](protocol-v1.zh-CN.md)

# pi-handoff 协议 v1（冻结）

> **已被取代（2026-10-06，PH-0002）：**本文是 PH-0001 的冻结历史证据。修正后的契约见 [protocol-v2.md](protocol-v2.zh-CN.md)：handoff 实体改为 Exchange 聚合（保留 `ho_` 前缀），Message 采用 CREATED→…→RESULT_AVAILABLE 生命周期，并通过证据控制重新入队和隔离；移除 `CONSUMED`；`piSessionRef` 改为通用 EndpointRef；带产品名称的表面改为中立端口。下文保留历史内容以供审计，不得据此实现。

PH-0001 Phase 0/1 于 2026-10-05 冻结。变更必须经过显式契约修订。契约的机器可读形式位于 `src/protocol/`。

## 1. 身份

- handoff 的权威身份：`ho_<ULID>`（Crockford Base32 ULID，26 个字符，48 位毫秒时间戳 + 80 位 CSPRNG 随机数）。其属性为不透明、唯一、不可变、非秘密、独立于提示内容，可安全持久化和记录日志。
- Result 身份：`hr_<ULID>`（相同构造，不同前缀）。
- 显示 ID（如最后 8 个字符）仅用于方便展示，绝不能作为持久化、关联或 API 身份的权威依据。

## 2. 生命周期状态机

```text
CREATED → QUEUED → CLAIMED → DELIVERED → ACKNOWLEDGED → RUNNING → SETTLED
                                                              ↘ (no activity
                                                                observed) ↗
SETTLED → RESULT_AVAILABLE → CONSUMED
```

显式建模失败、取消和不确定状态：

```text
QUEUED   → CANCELLED
CLAIMED  → CANCELLED        (consumer releases before delivery)
CLAIMED  → QUEUED           (lease expiry, delivery DEFINITELY not attempted)
DELIVERED → DELIVERY_UNKNOWN (acknowledgement unknown)
DELIVERY_UNKNOWN → ACKNOWLEDGED  (confirmed accepted by runtime probe)
DELIVERY_UNKNOWN → FAILED        (confirmed not executed)
DELIVERY_UNKNOWN → CANCELLED     (owner abandons)
any failure path → FAILED
```

终态：`CONSUMED`、`CANCELLED`、`FAILED`。
隔离态：`DELIVERY_UNKNOWN`（既非终态，也不可重试）。

### 冻结语义

| 状态 | 含义 | 不代表 |
| --- | --- | --- |
| QUEUED | broker 已持久接受 handoff | Pi 已收到 |
| CLAIMED | Pi 侧消费者已取得处理所有权 | 已投递或执行 |
| DELIVERED | 按 Pi API 边界已尝试或提交向 Pi runtime 的投递 | Pi 已接受 |
| ACKNOWLEDGED | Pi 已接受提示或请求 | 执行成功 |
| RUNNING | 已观察到有意义的 runtime 活动 | 语义正确 |
| SETTLED | runtime 调用已结束 | 任务正确 |
| RESULT_AVAILABLE | Result 信封已持久可用 | 已有人读取 |
| CONSUMED | ChatGPT/客户端显式获取或确认了 Result | — |

**投递不确定时默认拒绝。** `DELIVERY_UNKNOWN` 不能转入 `QUEUED`、`CLAIMED` 或 `DELIVERED`，也不会自动重试：重复的编码提示可能造成不可逆的仓库变更。解除隔离必须通过显式且有证据支持的转换进入 `ACKNOWLEDGED`、`FAILED` 或 `CANCELLED`。只有投递记录证明未发生尝试（租约过期）时，才允许安全重新入队（`CLAIMED → QUEUED`）。

## 3. 幂等性（创建）

`handoff_create` 接受可选 `idempotencyKey`（1–256 个字符），限定在所属命名空间内，并与规范化请求摘要一起存储（对递归按键排序的 JSON 计算 SHA-256）：

```
create(key=A, digest=D) → ho_123
create(key=A, digest=D) → ho_123   (same record)
create(key=A, digest=E) → IDEMPOTENCY_KEY_CONFLICT   (never a new id)
```

参考实现为 `src/protocol/idempotency.ts` 中的 `InMemoryIdempotencyStore`。持久 broker 必须以事务方式保持完全相同的语义。

## 4. ChatGPT MCP 表面（工具已冻结；Phase 1 仅实现 `ping`）

| 工具 | 类型 | 用途 |
| --- | --- | --- |
| `ping` | 只读 | 存活探测（已实现） |
| `handoff_create` | 写 | 创建 handoff（prompt、可选 idempotencyKey/workspace/metadata）→ handoff 记录 |
| `handoff_get` | 读 | 按 id 获取一个 handoff（状态和摘要；列表视图绝不包含原始提示） |
| `handoff_list` | 读 | 按 state/createdAt 时间窗口筛选，限制分页大小 |
| `handoff_cancel` | 写 | 请求取消；仅允许从 QUEUED/CLAIMED/DELIVERY_UNKNOWN 发起 |
| `handoff_result` | 读 | 获取 handoff 的 Result 信封 |

有意不向 ChatGPT 提供 `submit_result`、`mark_completed`、`acknowledge_delivery` 或等价工具。这些能力只存在于内部消费者表面（§5）。所有写工具必须带准确的 MCP 注解；对没有 `readOnlyHint: true` 的工具，ChatGPT 要求确认。

Schema：`src/protocol/` 中的 `HandoffCreateRequestSchema`、`HandoffSchema`、`HandoffResultSchema`。

## 5. Pi 消费者表面（仅限内部，绝不作为 MCP 工具）

操作：`claim_next`、`acknowledge`、`heartbeat`、`report_activity`、`settle`、`publish_result`、`release`。

- broker 仅向已认证的本地消费者（pi-handoff Pi 扩展）提供这些操作。
- 传输建议（已冻结，延后实现）：**loopback HTTP**，地址为 `http://127.0.0.1:<ephemeral-port>`，每次安装使用独立 bearer token，存于 broker 状态旁的 `0600` 文件（`~/.local/share/pi-handoff/`）。这是跨 macOS/Linux/Windows 保持可移植性的最小可靠机制；双方均支持时，Unix domain socket 是已批准的未来优化。loopback 绑定必须拒绝非 loopback 接口；payload 大小有上限。
- 此表面明确禁止使用 RPC 模式，因为它会创建竞争的 Pi session。

## 6. Result 信封

区分三个层次，绝不合并（`HandoffResultSchema`）：

```text
HandoffResult {
  handoffId            ho_<ULID>
  resultId             hr_<ULID>
  attempt              integer ≥ 1
  startedAt, settledAt ISO-8601 UTC
  transportOutcome     "delivered" | "delivery_unknown"
  runtimeOutcome       "succeeded" | "failed" | "cancelled" | "interrupted"
  result { summary, body }
  source { piSessionRef, workspace }
  inputDigest          sha256(canonical prompt payload)
  resultDigest         sha256(canonical result payload)
  applicationEvidence? opaque — pi-handoff does not interpret it
}
```

未来的 Wayforge 集成可将 `taskState` / `completionEvidenceDigest` 放入 `applicationEvidence`；pi-handoff 只按不透明数据持久化和转发，绝不将其视为语义正确性的依据。

## 7. 安全规则（冻结）

- 绝不持久化或暴露：ChatGPT 凭证、Pi OAuth 凭证、API key、原始认证文件、环境秘密、隐藏的模型推理、原始 provider 错误体（除非经过显式净化）。
- 提示和 Result 正文属于预期的 payload 数据：以严格权限持久化，不进入诊断日志；诊断使用 ID、摘要、长度和带类型的状态。
- 面向 ChatGPT 的响应绝不回显凭证或环境值；Phase 1 的 `ping` 仅暴露 `platform + release`。
