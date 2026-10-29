[English](persistence-proposal.md) | [简体中文](persistence-proposal.zh-CN.md)

> 历史设计记录。以下选择、命令和限制描述当时的提案，不代表当前实现或支持承诺。

# 持久化提案：pi-handoff broker（Phase 2+，仅设计）

> 已延期/被取代（2026-10-06，PH-0002）：持久化宿主不在 v2 范围内。下列具体选择（SQLite、loopback HTTP + bearer token、`~/.local/share` 布局）仍是开放选项，延期到修正后的 [protocol-v2.md](protocol-v2.zh-CN.md) 合同被接受并启动宿主阶段后再决定。当时本包没有 broker、存储、API server、loopback listener、SQLite 或 token。

默认存储：SQLite，采用常规、事务性、单文件且支持 WAL 的方案。不存储任何凭证。

## 位置

```
~/.local/share/pi-handoff/handoff.db      (database)
~/.local/share/pi-handoff/consumer.token  (0600, loopback HTTP bearer token)
```

目录权限 `0700`，数据库文件 `0600`。XDG 风格路径让 broker 独立于 Pi 配置目录，能够独立运行；若后续项目惯例要求，也可采用 macOS `~/Library/Application Support` 变体，但此提案中 CLI 工具的冻结默认值为 XDG 路径。

## 实体关系草图

```text
consumers  1─n  handoffs (claims)      handoffs  1─n  deliveries
handoffs   1─n  results                handoffs  1─n  events (immutable)
```

逻辑实体（物理 DDL 属于 Phase 2 工作）：

- **handoffs**：handoffId（PK）、state、idempotencyKey（每个 namespace 内唯一）、promptDigest、promptLength、promptBody（敏感，独立列或 sidecar）、workspace、metadata JSON、createdAt、updatedAt。状态转换只能在冻结状态机保护的事务内发生。
- **deliveries**：deliveryId、handoffId → handoffs、attempt、consumerId、claimedAt、leaseUntil、deliveredAt、deliveryRecord JSON（为 fail-closed 规则证明 attempted/not-attempted）。
- **results**：resultId（PK）、handoffId → handoffs、attempt、envelope JSON、inputDigest、resultDigest、applicationEvidence JSON（不透明）。
- **events**：eventId、handoffId、seq（每个 handoff 单调递增）、type（state_transition、claim、heartbeat、delivery、settlement、consumption、cancel）、payload JSON（仅含摘要/长度/类型化状态，绝不包含原始 prompt 或 result body）、at。只追加、不可变。
- **consumers**：consumerId、label、registeredAt、lastSeenAt、tokenDigest（绝不存 token 本身）。

## 硬性要求

- 事务性状态转换：状态机强制检查与事件追加处于同一事务。
- `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`synchronous=NORMAL`。
- 通过 `schema_migrations` 表管理 schema 版本；迁移在 broker 启动时运行，测试绝不针对生产数据执行迁移。
- 数据库或事件负载不含凭证材料；必须传递的秘密（如 consumer bearer token）放在 DB 外部的 `0600` 文件中，数据库只保存摘要。
- 诊断和日志只引用 ID、摘要、长度和类型化状态。
