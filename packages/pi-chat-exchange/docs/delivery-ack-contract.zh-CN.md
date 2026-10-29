[English](delivery-ack-contract.md) | [简体中文](delivery-ack-contract.zh-CN.md)

# 私有投递 ACK 存储契约（E2-A）

存储契约已在 E2-A 阶段实现。后续操作界面增加下述由操作者主动启用的 MCP/host 接口，不改变该存储契约。本文不构成真实 ChatGPT dogfood 或发布证据。

## 含义与权限

ACK 是不可变的接收方接收声明：一条 Receipt 加一条 `receipt_recorded` 审计。它不能证明已阅读、理解、处理、恰好一次投递/执行、任务恢复或任务完成。Wayforge 保留受治理任务的权限；Pi 保留 runtime/transport 权限。`DELIVERY_UNKNOWN` 不会变为 `CANCELLED`。

私有 `recordDeliveryAck(store, input, seams?)` 恰好接受 host 字段 `participantId`、`sessionId`、`fencingToken`、`capability`、`exchangeId`，以及复制的 Message 元数据 `messageId`、`payloadDigest`、`payloadLength`、`messageCreatedAuditSequence`。输入只捕获一次；未知字段和无效标量类型会被拒绝，且不回显值。这些 host 权限字段不是拟议的公开调用输入。

现有受控事务中的顺序：

1. `BEGIN IMMEDIATE` 取得 SQLite 写锁。
2. 在锁后仅采样一次可信时间 tA。
3. 使用确切、独立且 Session-bound 的 `ack` capability，以及当前 Owner/Session/fence/lease 授权。撤销、已 detach/未绑定 Session、错误 scope、恰好过期和时钟回退，均在 Message/Receipt/审计查找前默认拒绝。
4. 校验成员关系、稳定接收方绑定、不可变加入边界、确切创建审计、原始正文 SHA-256 和字节长度。
5. 校验自然键 `(exchangeId, messageId, recipientParticipantId)` 的证据。
6. 等价证据零写入重放。首次 ACK 要求 Exchange 为 OPEN 且无行政 disposition，并原子插入 Receipt/审计对。
7. 确认 COMMIT 后才发布结果。

在 tA 有效的操作可以在租约过期后提交；提交时不会重新授权或续租。下一次已过期的调用即使 Receipt 已存在也会被拒绝。

## 证据与投影

`CREATED` 或 `REPLAYED` 返回 `{disposition, receipt, receiptAuditSequence}`。冻结的公开 Receipt 只含 `receiptId`、`exchangeId`、`messageId`、稳定接收方 `endpoint`、`kind: 'delivery_ack'`、`createdAt`。实际协议 Receipt 前缀是 **`rcpt_`**，不是 `rcp_`。

私有行保留最初确认的 Session/fence/trust-generation、摘要/长度、确切 Message 创建序号、时间和 revision=1。审计 subject 为 Receipt ID，outcome 为 `delivery_ack`，并带匹配的原始摘要/长度/时间。Receipt 审计序号与 Message 创建序号不同。新授权的 Owner 可以重放原始证据；来源记录绝不重写。当前授权和资格有效时，允许对 CLOSED Exchange 的已有 Receipt 重放/查询；拒绝首次 ACK。

部分、重复或不一致的证据均被拒绝；不修复、不使用 IGNORE 或 REPLACE。孤立的 Receipt 审计本身无法标识 Message：自然键不存在时，只要该 Exchange 中存在任何孤立 Receipt 审计，就保守拒绝。额外完整性扫描使用现有关联索引，但不声称其成本在 Receipt 数量增长时保持恒定。不新增索引。

## 不确定结果与只读对账

私有 `reconcileDeliveryAck` 使用相同的封闭输入、当前授权和资格。它返回原始 `{disposition:'COMMITTED', receipt, receiptAuditSequence}` 或 `{disposition:'NO_TRACE'}`，不产生持久变更。它不签发凭证、续租、恢复所有权、重试 ACK、发送、取消或声明完成。

`NO_TRACE` 只表示该串行化快照中不存在证据。仍存活且暂停在 BEGIN 前的原调用以后仍可能提交。即使已证明原调用静止，也不构成重试批准。本实现没有上层重试编排。

已证明回滚与 `INDETERMINATE` 保持区分。Busy 不授权重试。COMMIT/rollback 不确定时使旧连接失效，不返回成功。在原调用静止后，以新连接和确切授权诊断持久证据；绝不制造缺失证据。调用方响应丢失时，完整证据对仍可能已提交。

## 隔离、分页与隐私

ACK 绝不改变 Message/state/body/revision、attempt、claim、cursor、result、ownership、membership、task 或 transport 状态。读取/发现不会隐式 ACK；ACK 不隐藏 Message。Receipt 审计占用原始 inbox 扫描预算。续页位置始终为实际检查的最后一个原始序号，不是 ACK 水位或预取尾部。仅含 Receipt 的空页可以推进续页位置而不返回 Message；调用方需显式请求后续页。

正文、凭证、host 秘密和任意 cause 均不得进入 Receipt/审计结果、日志或错误。私有 hook 同步执行，不携带值，防御性捕获，拒绝不受支持的结果而不检查其内容，并在领域错误转换前替换调用方异常。测试插桩具有特权，不是沙箱。

## MCP 表面（操作界面阶段）

一个需主动启用的 MCP 工具现已暴露此已提交的存储契约。上述私有存储函数、顺序和保证不变。

- 工具名为 `ce_ack`。封闭输入恰好是 `{messageId,
  payloadDigest, payloadLength, messageCreatedAuditSequence}`；在任何端口调用前，未知字段和任何携带权限的字段均以 JSON-RPC invalid params 拒绝。摘要、长度和创建序号必须从授权读取结果复制（`ce_read_payload` 恰好返回 `payloadDigest`、`payloadLength` 和创建 `auditSequence`），绝不能由调用方或模型计算或转换。
- host 注入 Participant、Session、fencing token、Session-bound `ack` capability 和 Exchange。调用方不提供任何权限字段；仅在操作者启用 opt-in 时（provisioning 及已验证的 `resume`）签发 capability，并且只保留在内存中。
- 仅操作者主动启用时才公告：MCP 绑定配置增加可选的 `"ack": { "enabled": boolean }` 部分，默认禁用。未启用的部署恰好公告 `ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`，调用 `ce_ack` 会默认拒绝（MethodNotFound）。启用后，`ce_ack` 列在最后。
- 禁用策略在检查注册状态前拒绝 `CE_HOST_ACK_DISABLED`。存储拒绝映射到现有已净化的 host 拒绝集合（`CE_HOST_AUTHORITY_ABSENT`、`CE_HOST_INVALID_REQUEST`、`CE_HOST_BUSY`、`CE_HOST_UNCERTAIN`、`CE_HOST_UNAVAILABLE`）；`CE_HOST_UNCERTAIN` 永不可重试，调用方不得重试。仅对 ACK，`CE_HOST_BUSY` 保留原始安全存储原因和已证明回滚的分类，但 host 与 MCP 均按调用方策略报告 `retryable: false`：回滚不授权重试。再次调用 ACK 必须获得操作者或上层显式批准；系统不编排重试。现有 send/read 拒绝行为不变。
- 工具响应为冻结的公开 Receipt 投影，加上 `disposition` 和 `receiptAuditSequence`：首次 ACK 为 `CREATED`；等价重复为 `REPLAYED`，返回完全相同的原始 Receipt。确认方 Session、fencing token、trust generation 和 capability 绝不出现在任何结果、拒绝或日志中。
- 记录 ACK 仍不改变 Message 投递状态、cursor、inbox 可见性或任务状态，只表示接收方声明已接收，不能证明投递、阅读、理解、处理或任务完成。

当前仅 v7 的 bootstrap/gate 见 `storage-contract.md`。现有历史迁移代码保持不可变，不是 E2-A 升级或正常打开路径。大容量遍历测试证明工作量有界及索引使用，不构成生产延迟 SLO 或发布授权。
