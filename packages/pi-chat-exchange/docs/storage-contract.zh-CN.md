[English](storage-contract.md) | [简体中文](storage-contract.zh-CN.md)

# 持久化存储契约（CE-0002-B2-S6-2）

Chat Exchange 已验收的私有 SQLite 持久化存储的历史契约及修订。下列每项规范性声明均有已验收的测试或实现证据支持；参见后文的追溯矩阵。

## E2-A 仅限当前 v7 的实现候选

对于 E2-A 实现候选，本节取代下文历史版本及迁移要求；父会话审查和验收仍待完成。

新 Store 直接使用完整的最终 `src/storage/current-schema.ts` v7 基础，不再通过历史 COPY/DROP/RENAME 组合构建。唯一的新建迁移账本行为 `(7, b3-p3b-direct-current-ack-foundation,
fd07d7a0e65183700c7f71e1f5522c59ef053f1e316eb4bb93596f5b3309b5b1)`。元数据中的初始化版本和 user_version 均为 7。精确 schema、账本、身份、完整性、外键、restore-hold 和宿主信任根均在 COMMIT 前验证，并在发布句柄前再次验证。另行固定的静态 94 对象清单位于 `test/storage/support/current-v7-manifest.json`。

正常打开以 STORAGE_INCOMPATIBLE 拒绝不受支持、旧版或混合结构，并给出需另行获得操作员批准的 Dev Reset 指引；不会重置、删除、修复、重新初始化或迁移。外来身份、过新版本、校验和、损坏、文件系统、hold 和信任根拒绝各自保留独立的类型含义。历史 SQL/校验和及 migration.ts 保持不变；它们不是 v7 升级服务，也不是 E2-A 正常打开的前置条件。

初始化负责异常安全的连接清理，包括秘密生成阶段。初始化失败可能留下被拒绝的文件系统产物；不会自动删除或重复执行。不确定结果或响应丢失可能发生在完整 Store 已提交之后。失败本身不能证明回滚，必须重新执行完整验证。

新的私有 ACK/回执对账语义见 [delivery-ack-contract.md](delivery-ack-contract.zh-CN.md)。本节不新增公共 ACK 传输。

全文使用以下范围标签：

- **公共契约**：调用方可依赖的行为；
- **内部**：私有实现细节，不构成调用方保证；
- **仅测试**：只存在于测试框架中的能力；
- **限制**：当前证据的已知边界；
- **待办**：已记录的未来要求，尚未实现。

本文不改变架构、生产行为或测试。

下文保留各阶段声明。后续修订仅在明确说明处取代早期声明；历史迁移要求不能覆盖上面的仅限当前 v7 章节。除非明确导出，标为公共契约的 Storage API 仍位于私有存储平面内。

## 1. 存储契约

### 创建 API（公共契约）

`createExchange(store, input)` 和 `createMessage(store, input)` 均为同步操作。两者返回冻结结果 `{ disposition, entity, record }`，其中 `disposition` 为 `"CREATED"` 或 `"REPLAYED"`（`src/storage/creation.ts:24`、`:214` 中的 `ExchangeCreation`、`MessageCreation`）。

- `createExchange` 在一个自有事务中创建 Exchange 行、幂等记录和序号为 1 的 `exchange_opened` 审计事件（实现：`creation.ts:120`；审计插入：`:178`）。
- `createMessage` 在一个自有事务中创建 Message 行、幂等记录和按 Exchange 连续编号的 `message_created` 审计事件（实现：`creation.ts:382`；序号选择：`:346`；审计插入：`:456`）。
- Message 身份以 `msg_` 开头，审计身份以 `evt_` 开头（测试：`test/storage/message-creation.test.ts` 中的 M2）。
- COMMIT 后，独立只读连接可见全部三行（测试：M6）。

### 公共结果结构（公共契约）

创建或重放的 Message 仅暴露合法公共字段：`messageId`、`exchangeId`、`from`、`to`、`payloadDigest`、`payloadLength`、`createdAt`、`state`，以及外层 `disposition` 和幂等 `record`。端点身份（`from`、`to`）按**已验收的 M3 契约属于公共字段**：存储端点嵌入重放的 Message，且严格按请求持久化（测试：M3）。结果深度冻结（测试：M5）。

### 私有载荷处理（公共契约）

载荷正文私有存储。公共结果仅暴露摘要和长度，不暴露载荷字节，也不提供载荷访问器（测试：SB6、M3 和 S6-1 扫描）。空载荷存为零长度正文（M7）；授权最大尺寸可接受（M8）；超限载荷在任何事务开始前拒绝（M9）。

### 幂等与重放（公共契约）

幂等键以 Exchange 为作用域，不依赖内存状态（I7）。相同键和相同请求重放原 Message：`REPLAYED` 结果、保留创建元数据和当前存储状态、零写入、不调用 hook（I1、I2、I3）。Store 关闭重开后和多进程并发时均可重放（`test/storage/message-creation-recovery.test.ts` 中的 R4）。

### 冲突（公共契约）

相同键对应不同请求（载荷或端点不同）时，为不可重试的冲突，绝不替换（I4、I5；C2 竞争及串行情形）。有效请求与已存储的不同请求冲突时，分类为冲突而非损坏（I8）。

### Exchange 准入（公共契约）

Exchange 缺失（A1）、CLOSED（A3）或带有 disposition 行（A4；实现：`creation.ts:334`）时拒绝新建。CLOSED 或带 disposition 后仍允许零写入重放（A5、A6）；冲突分类不依赖 CLOSED 准入检查（A7）。外部已提交的 disposition 变化可由已打开 Store 观察，无需重开（F2-A、F2-B、F3）。

### 事务所有权与结果（公共契约）

所有变更均在 `withImmediateTransaction` 中执行；它同步、独占地拥有连接（内部原语；契约见 `docs/storage-security.md`，由 `transaction*.test.ts` 覆盖）。公共错误类为 `CreationDomainError`、`StorageTransactionError`、`ConditionalMutationError`，消息和代码固定且已脱敏（`creation.ts:50`、`transaction.ts:6`、`:26`）。

- **BUSY**：事务竞争分类为 `STORAGE_TRANSACTION_BUSY`，结果 `ROLLED_BACK`，可重试（S6-1 的 “BUSY classification errors …” 测试）。
- **ROLLED_BACK**：COMMIT 失败且已证明回滚时，返回 `ROLLED_BACK`，不伪造成功（S6-1 提交失败测试）。
- **INDETERMINATE**：自有 ROLLBACK 本身失败时，返回 `STORAGE_TRANSACTION_FAILED`、`INDETERMINATE`、不可重试，并使连接失效；后续调用重复同一脱敏分类（S6-1 不确定回滚测试；机制见 `transaction.ts` 的 `invalidated` WeakSet）。INDETERMINATE **不保证**零持久化写入；观察到的零写入仅适用于受控测试夹具（限制）。

### 审计行为（公共契约）

每次成功创建恰有一个审计事件；重放不写审计（I3）。Message 审计序号在每个 Exchange 内连续（C3）。损坏或意外的持久化历史一律拒绝，不修复（P3；`a51c091` 不安全整数分类）。

### 持久化存储边界（公共契约）

Storage 为包内私有：公共入口仅重新导出 protocol/core（`src/index.ts:7-10`），契约门禁强制维持私有存储边界（19 个负向夹具；Wayforge 19 项架构门禁）。文件系统、拒绝、schema 清单及快照预检边界见 `docs/storage-security.md`。

## 2. 崩溃与恢复证据

已验收且已提交的回归证据：

- **K1–K6 边界标记**：仅在完整事务结束后，创建才可证明已提交；边界前崩溃不留下持久化三元组，已证明 COMMIT 后崩溃保留持久化结果，重试重放该结果（K6；`test/storage/message-creation-crash.test.ts`；提交 `b3141ca`）。
- **SIGKILL 释放锁**：被杀死的写入进程释放写锁，后续进程可正常创建（R1-A；`f178dec`）。
- **死亡期间的竞争**：阻塞于 BEGIN IMMEDIATE 的竞争者在持锁进程死亡后安全结束（R1-B）。
- **读快照隔离**：已打开的读事务不受写入方未提交工作及 SIGKILL 影响（R2）。
- **Store 关闭重开与并发重放**：幂等记录经关闭重开及并发进程重放，不产生重复写入（R4；`bbf28f0`）。
- **K5 崩溃**：已提交历史保留；未提交三元组不存在（R3）。

**必须保留的区别（限制）**：已验收 K5 场景在崩溃时 WAL 为零字节；K5 是*未提交回滚*场景。零字节 WAL **不能**证明未提交页的物理位置。*非空已提交 WAL 恢复*有独立审查框架证据（S5-2 审查探针中 45,352 字节 WAL 经 SIGKILL 保留），但**不属于已验收且已提交的回归套件**；登记为 `CE-STORAGE-WAL-RECOVERY-REGRESSION`。

## 3. 隐私契约

**合法公共字段**（不属于泄漏）：`messageId`、`exchangeId`、`from`、`to`、`payloadDigest`、`payloadLength`、`createdAt`、`state`、`disposition`。端点身份按已验收 M3 契约公开。

任何公共结果或错误均**禁止披露**：载荷字节（十六进制、十进制序列、`Uint8Array` 或 `Buffer`）、凭证、数据库路径、原始 SQL、内部异常原因（`cause` 属性）。公共错误使用固定词汇；`Error.stack` 可以存在，但不得含受保护信息。

已验收 S6-1 回归覆盖（`test/storage/public-surface-privacy.test.ts`；`84e0603`、`f606594`）：扫描 CREATED 和 REPLAYED Message 结果、REPLAYED Exchange 结果及八条错误路径（冲突、无效请求、准入拒绝、BUSY、COMMIT 失败回滚、不确定回滚 INDETERMINATE、hook seam 失败），用负向控制证明能检测每类哨兵（含二进制载荷形式），并以合法公共字段做误报控制。生产 cause 泄漏变异敏感性已验证：变异 **createMessage** 包装点导致 4 项测试失败（退出 1）。

**非阻塞缺口：`CE-PRIVACY-EXCHANGE-ERROR-COVERAGE`（待办）**：createExchange 错误路径没有直接隐私断言；仅变异其包装点时套件仍通过。两个 API 的变异敏感性**并不相同**。共享包装机制和脱敏断言只经 createMessage 路径执行。

## 4. 架构边界

Chat Exchange 当前不负责模型路由、账号轮换、自动任务重试、持久化任务执行、恢复调度或跨插件编排。Chat Exchange 消息持久化（本契约）与 Wayforge 任务持久化相互独立，不能彼此推导。本文记录边界，不改变架构。

## 5. 待办登记

已有技术限制及可选加固：

- **`CE-STORAGE-IMMUTABILITY-V2`**：Schema v1 缺乏带认证的状态完整性；已刻画特权 CLOSED→OPEN 漂移，但未阻止（F4、P4）。
- **`CE-STORAGE-WAL-RECOVERY-REGRESSION`**：非空已提交 WAL 崩溃恢复尚无已提交回归测试，证据仅来自审查框架。
- **`CE-PRIVACY-EXCHANGE-ERROR-COVERAGE`**：createExchange 错误路径缺少直接隐私变异敏感性（见 §3）。

未来产品能力（未实现，也不在此设计）：

- **`CE-SESSION-CONTINUITY-001`**：新的 Pi Session 可安全恢复参与既有 Exchange，且不丢失已提交消息。当前边界：消息持久化和 Store 重开本身不提供跨会话连续性；Participant 接管不在此范围。
- **`CE-RECONNECT-001`**：ChatGPT.app 重启、更新或暂时断连后恢复通信。须区分持久化 Exchange 状态（本契约）、Pi 侧连接恢复、ChatGPT.app 集成和任务执行恢复。不得假定 ChatGPT.app 提供自动重连生命周期 hook。

这些登记不扩展 B2 范围。

## 6. 追溯矩阵

| 契约声明 | 测试证据 | 已验收提交 | 限制 |
| --- | --- | --- | --- |
| Exchange 创建：三行、单事务、审计序号 1 | exchange-creation suite；`creation.ts:120`、`:178` | `deefd8e` | 无 |
| Message 创建：schema 有效的 CREATED、三行可见 | M1、M6 | `deefd8e` | 无 |
| 含端点的公共字段；深度冻结 | M3、M5；S6-1 扫描 | `deefd8e`、`84e0603` | 端点公开，不隐藏 |
| 私有载荷；仅摘要/长度；无访问器 | SB1–SB10、M3、M7–M9 | `deefd8e` | 无 |
| 幂等重放：零写入、保留元数据 | I1–I3、I7 | `deefd8e` | 无 |
| 冲突不可重试；不替换 | I4、I5、I8、C2 | `deefd8e`、`1250800` | 无 |
| 准入：拒绝缺失/CLOSED/带 disposition | A1、A3–A8、F2-A/F2-B/F3 | `deefd8e`、`8318b36` | 无 |
| 事务结果：BUSY/ROLLED_BACK/INDETERMINATE 及失效 | transaction suites；S6-1 错误测试 | `deefd8e`、`84e0603` | INDETERMINATE ≠ 零写入保证 |
| 错误优先级及损坏拒绝 | P1–P5 | `5005078`、`a51c091` | 无 |
| 崩溃边界 K1–K6、SIGKILL 提交持久性 | crash suite（19 项） | `263c191`、`b3141ca` | 框架中的进程夹具 |
| 释放锁、竞争、读隔离 | R1-A、R1-B、R2 | `f178dec` | 无 |
| 关闭重开及并发重放 | R4、C5 | `bbf28f0`、`1250800` | 无 |
| K5 未提交回滚经崩溃保留 | R3 | `bbf28f0` | WAL 零字节；见 CE-STORAGE-WAL-RECOVERY-REGRESSION |
| 公共面隐私扫描及二进制控制 | S6-1 suite（18 项） | `84e0603`、`f606594` | createExchange 错误路径：CE-PRIVACY-EXCHANGE-ERROR-COVERAGE |
| 私有存储边界/无公共导出 | architecture contract gate（19 个夹具） | （工作区门禁） | 无 |

## 7. B3-P1A schema v2、显式迁移与宿主信任根

已验收 B3-P1A 修订（CE-0002-B3-P1A）。保留 §§1-6 全部内容：每个 v1 表、触发器、索引和行均不变；v2 仅追加 schema 对象及账本行。`store_metadata` 从不 UPDATE 或 DELETE（v1 不可变触发器会中止操作）；`store_metadata.schema_version` 永久记录初始化版本（迁移 Store 为 1，新建 v2 为 2）。实时 schema 版本为 `PRAGMA user_version`，必须等于迁移账本最高条目。

### 增量 v2 schema

新增表：`participant`、`participant_capability`（仅 SHA-256 摘要，绝不存明文能力）、`participant_session`（P1A 仅定义 schema）、`exchange_membership`、`participant_ownership`、`participant_fencing_high_water`、`delivery_cursor`、`host_trust_root`。新增仅追加/不可变触发器：`participant_identity_immutable`、`exchange_membership_immutable`/`_nodelete`、`host_trust_root_immutable`/`_nodelete`。P1A 中所有权、fencing、cursor 表均为未启用 schema：B3-P2/P3 前无代码路径读写，迁移测试断言它们为空。

### 版本识别（正常打开）

- 已识别的原始 v1（账本恰为 v1 行、`user_version` 1、v1 清单）：以 `STORAGE_MIGRATION_REQUIRED` 拒绝；迁移从不隐式执行，也不在正常打开时执行。
- 迁移 v2（v1 行加 v2 迁移行，`user_version` 2）或新建 v2（单 v2 基础行，`user_version` 2）：完整验证（含宿主信任根）后打开。两者共享字节完全相同的获批清单（`INITIAL_SCHEMA_SQL + V2_ADDITIVE_SQL`）。
- `user_version` 或元数据版本高于 2：`STORAGE_SCHEMA_TOO_NEW`。
- 任何账本偏离：`STORAGE_MIGRATION_CHECKSUM_MISMATCH`。任何 schema 漂移（新增、删除、修改对象，含空白差异）：`STORAGE_INCOMPATIBLE`。继续遵循拒绝优先于修复。

### 显式迁移（`migrateStore`）

专用宿主本地入口，`openStore` 永不可达：要求显式 `{ fromVersion: 1, toVersion: 2 }` 路径；在一次性只读快照上预检精确 v1 结构（完整性、外键、身份、账本、清单、restore hold）；引导信任根 generation 1；在单个自有 BEGIN IMMEDIATE 事务中应用增量 DDL、追加 v2 账本行、推进 `user_version`；再以完整 v2 重开证明成功。中断回滚为有效 v1（仍返回 `STORAGE_MIGRATION_REQUIRED`）；BUSY / ROLLED_BACK / INDETERMINATE 原样传播，不重试、不修复。v1 二进制在结构上无法打开 v2（`user_version` 2 超出支持版本），因而无法降级。

### 宿主信任根

宿主秘密是 256 位随机值，以十六进制编码保存于私有 Store 目录的 `host-secret` 文件：使用 O_NOFOLLOW 独占创建、0600、当前用户所有、禁止符号链接，与数据库遵循相同产物策略。仅 SHA-256 指纹持久化到仅追加的 `host_trust_root` 表。每次 v2 打开均重读文件、重做产物检查并比较指纹：缺文件 `STORAGE_TRUST_ROOT_MISSING`；不一致 `STORAGE_TRUST_ROOT_MISMATCH`；不安全产物 `STORAGE_TRUST_ROOT_INSECURE`；初始化/迁移/恢复时已有秘密 `STORAGE_TRUST_ROOT_AMBIGUOUS`。全部封闭失败、零写入、不修复、不自动再生，错误、结果、日志均不暴露秘密或指纹。

### 信任根恢复（`recoverTrustRoot`）

仅限操作员显式授权：先由操作员移除旧秘密文件（命令拒绝覆盖）；Store 必须是有效 v2；一个自有事务追加带新指纹的 generation N+1，并撤销全部现有能力行。替换秘密不继承权限：旧代能力同时因撤销及代际绑定失效，每个 Participant 必须重新签发能力。能力签发属于 B3-P1B，在本阶段尚不存在。

### 限制

保护等同于已记录的文件系统信任边界（`storage-security.md`）：同时控制数据库与秘密文件的攻击者可一致地重写两者，不声称防护此类攻击者。`CE-STORAGE-IMMUTABILITY-V2` 保持开放且不变；新 v2 表继承相同的未认证状态限制。

## 8. B3-P1B Participant 身份、能力授权与成员关系

已实现 B3-P1B 修订（CE-0002-B3-P1B）。保留 §§1-7：不改变 v1 DDL、触发器、索引、行或 schema-v2 清单（P1B 仅使用已验收 v2 表）；不改变 B2 创建、请求摘要、幂等/冲突语义、审计排序、事务分类。所有权、fencing、cursor 表继续未启用。

### Participant 身份（私有平面内的公共契约）

`createParticipant` 创建一个持久化、全局唯一 Participant（`prt_<ULID>`，由冻结的协议 ULID 编码器生成），不可变地绑定到唯一稳定 Endpoint 身份 `(adapter, endpointId)`。身份和绑定不可变（`participant_identity_immutable`），绑定为 1:1（`UNIQUE (endpoint_adapter, endpoint_id)`）；同一 Endpoint 的第二个 Participant 被拒绝（`PARTICIPANT_ENDPOINT_CONFLICT`），不支持重新分配或别名。Session ID 从不是身份：P1B 不使用 `participant_session`。`instanceId` 为临时值，不进入身份、请求摘要或持久化绑定，因此不同实例会重放而非冲突。创建使用已验收 B2 幂等键语义（重放、冲突、损坏先于冲突）。不发审计事件：已验收 v1 DDL 中 `audit_event` 按 Exchange 定域，而 Participant 身份全局唯一。

`bindEndpointRef` 是对不可变绑定的授权确认：要求 `bind` 能力，零写入，拒绝不同 Endpoint 身份（`PARTICIPANT_BINDING_MISMATCH`）或已属另一 Participant 的身份（`PARTICIPANT_ENDPOINT_CONFLICT`），忽略 `instanceId`。

### Host Capability 授权

仅 P1 scope `create`、`bind`、`join` 可操作；其余已验收 schema scope 返回 `CAPABILITY_SCOPE_UNSUPPORTED`。能力为 256 位 CSPRNG bearer token（`cap_<64 hex>`），仅向签发宿主返回一次。只持久化以宿主秘密为密钥的 HMAC-SHA256 摘要，绑定当前信任代、Participant 和精确 scope。验证与所授权变更位于同一自有事务，并在每次授权时重新验证宿主信任根（产物策略及指纹一致性）。伪造、未知、错误 scope、错误 Participant、错误代、撤销、过期能力均统一返回不透明的 `CAPABILITY_REJECTED`，避免成为探测 oracle；宿主本地 `readCapabilityStatus` 保留详细原因。Session ID 和 Participant ID 均不授予权限。自 CE-0002-B3-P2C-B 起，Session-bound 能力（`resume`、`takeover`；未来 `send`/`ack`/`read` 操作化后继承）绑定到 DETACHED Session 时也不可用：持久化 `detached_at` 是生命周期真相，读取时使能力失效，不重写能力行；宿主本地状态为 `SESSION_DETACHED`，调用方仍见相同不透明分类。绑定行缺失或畸形时，Session-bound 能力返回 `STORAGE_OWNERSHIP_CORRUPT`。撤销显式且单向，不自动恢复能力。操作员恢复信任根后，旧能力因撤销及代际绑定失效，必须按 Participant 重新签发。

### Exchange 成员关系及加入边界

`joinExchange` 要求有效 `join` 能力，验证 Participant，仅允许加入既存 OPEN 且无行政 disposition 的 Exchange。写入一个 `exchange_membership` 行、一个幂等记录及恰好一个 `participant_joined` 审计事件；沿用已验收的每 Exchange MAX(sequence)+1 分配，持久化为不可变 `join_boundary_seq`。成员行不可变且不可删（`exchange_membership_immutable`/`_nodelete`）。重复加入为零写入重放，绝不移动边界；同键不同请求为 `IDEMPOTENCY_KEY_CONFLICT`。不重写历史 Message：边界下方审计序号为加入前历史，上方为加入后活动。键按 Exchange 定域，一个 Participant 可加入多个 Exchange，一个 Exchange 可含多个 Participant。

**成员资格不等于投递。** P1B 不提供消息列表、投递、cursor 或 ACK，也不接入 adapter；投递平面仍属未授权的 B3-P2/P3 范围。

### 持久化读取

仅提供最小私有读取：Participant 存在性、稳定 Endpoint 绑定、带加入边界的 Exchange 成员关系和宿主本地能力状态。不新增公共包 API，私有存储边界及契约门禁不变。

### 解释说明

- `create` scope 通过可选赞助创建生效：`createParticipant` 收到 `sponsor` 时，在同一自有事务中验证赞助方的 `create` 能力。让 `create` 限制已验收 B2 Exchange/Message 创建会改变 B2 契约，不在范围内。
- `participant_joined` 是私有存储审计 kind。冻结的协议 `EVENT_KINDS` 词汇和 `prt_` 身份前缀刻意不加入公共重新导出的协议面；已验收 v1 DDL 的 `audit_event.kind` 为自由文本。

### 8.1 R1 修复（CE-0002-B3-P1B-R1）

针对独立 B3-P1B 审查的修复。无 schema 变化、新依赖、公共导出或 P2 范围。

**任何受保护结果均先授权。** `joinExchange` 和赞助 `createParticipant` 过去先评估幂等重放，再验证能力，因此持有已知幂等键的调用方可用伪造、过期、撤销、错误 scope、错误 Participant 或错误代能力获取 `REPLAYED` Membership/Participant。当前新建及重放结果均先在同一自有事务内授权。幂等键从不是授权凭证。

**有意改变错误优先级。** 这两条路径上，`CAPABILITY_REJECTED` 现在优先于重放、`IDEMPOTENCY_KEY_CONFLICT`、`STORAGE_IDEMPOTENCY_CORRUPT`。已授权重放内部仍保留损坏先于冲突。无赞助的 `createParticipant` 是受信宿主本地操作，维持原语义，不要求能力。

**其余幂等行为不变。** 已授权重放仍零写入、确定、字节一致、保留边界，不发审计、不新增能力、不改变所有权。B2 请求摘要及 Exchange/Message 行为不变。

**`bindEndpointRef` 仅验证。** 保留已验收名称；操作从不创建或改变绑定。绑定仅在创建身份时原子建立一次。

**信任根分类对齐。** 能力验证期间缺少信任代行为 `STORAGE_CORRUPT`，宿主秘密指纹不一致为 `STORAGE_TRUST_ROOT_MISMATCH`；这是能力平面已记录且 `issueCapability` 已采用的类型化信任根拒绝。能力拒绝本身仍统一为不透明 `CAPABILITY_REJECTED`，两条路径均封闭失败、零写入。

**`recoverTrustRoot` 损坏分类。** 自有事务证明因类型化生命周期拒绝而发生不可重试回滚时，该拒绝成为顶层分类（例如 `STORAGE_CORRUPT`，不再是通用事务失败）。事务结果、不可重试分类及原始事务错误仍作为 `cause` 保留。BUSY、INDETERMINATE、未分类结果原样传播，不重试、不修复。

## 9. B3-P2A Session 绑定、所有权、租约及 fencing

已实现 B3-P2A 修订（CE-0002-B3-P2A）。保留 §§1-8：不改变 DDL、触发器、索引、schema-v2 清单（P2A 仅写已验收的 `participant_session`、`participant_ownership`、`participant_fencing_high_water`）；不改变 B2 创建、P1A 迁移/恢复、P1B 身份、Endpoint 绑定、成员关系、加入边界或审计排序。`delivery_cursor` 仍未启用。不新增公共包 API；无投递 API、adapter 接入、后台心跳或接管。

### Scope

`attach` 和 `resume` 可操作。`attach` 授权 Session 绑定及所有权获取；`resume` 授权续租、释放、零写入 Owner 验证。`takeover`、`send`、`ack`、`read` 仍为 `CAPABILITY_SCOPE_UNSUPPORTED`。授权始终与变更处于同一自有事务，重新验证宿主信任根。

### SessionRef 与绑定

Session 是不透明、非秘密的 `ses_<ULID>` SessionRef，既非 Participant 身份，也非凭证。`bindSession` 在 `attach` 能力下记录一个 `(participant, session)` 行；绑定不授予所有权，重复绑定为 `SESSION_ALREADY_BOUND`，已绑定其他 Participant 为 `SESSION_BOUND_TO_OTHER_PARTICIPANT`（一个 Session 恰属一个 Participant；一个 Participant 可有多个历史 Session）。创建 Participant 不创建 Session 或所有权。P2A 不 detach Session；已 detached 行视为未绑定。

### 所有权与 fencing

`acquireOwnership` 让一个已绑定 Session 成为当前无 Owner 的 Participant 的唯一 Owner。任何有效租约（含请求 Session 自己持有）均为 `OWNERSHIP_HELD`，不默默接纳、不接管。获取在同一自有事务内分配 fencing token 并写所有权行。**被 §10 取代**：本节 P2A 原允许覆盖*过期*行（“supersession”）；R1（设计澄清 Q1）将任何已有 Owner 的替换移至尚未启用的 P2B `takeover` scope。

**首个 token 规则**：无 `participant_fencing_high_water` 行时分配 token 1 并插入行；之后每次恰为 high-water + 1（对旧值 compare-and-set）。high-water 永不递减或删除，token 经重启、租约过期、释放后保留且不复用；计数器按 Participant 独立。超出 `Number.MAX_SAFE_INTEGER` 为 `FENCING_EXHAUSTED`。token 不从时间戳或 Session ID 推导。所有权 token 与 high-water 不同、high-water 缺失、已存 token 越界、截止时间无效，或所有权指向未绑定 Session，均为 `STORAGE_OWNERSHIP_CORRUPT`，拒绝且不接纳、不修复。

### Owner 授权与租约

续租、释放、验证依次检查：当前有效 `resume` 能力（Participant、scope、信任代、撤销、过期），Participant，已绑定 Session，Session 是否为持久化当前 Owner（`OWNERSHIP_NOT_CURRENT`），所呈 token 是否当前（`FENCING_STALE`），租约（`LEASE_EXPIRED`、`LEASE_CLOCK_REGRESSION`）。不从 Session ID 推导所有权。接管（§11）后，旧 Session 的所有 Owner 操作均拒绝。

TTL 默认 120 s，可配置 30–3600 s（请求验证）。30 s 是宿主续租建议，不是调度器。时间仅来自注入时钟。释放仅删除所有权行。

**被 §10 取代**：P2A 原用*请求* TTL 的 `expiresAt - ttl` 推导起点，并声称时钟回退绝不延长租约。独立审查（MAJOR-1）证明推导与声明均不安全：TTL 变化会将有效 Owner 错误拒绝为 `LEASE_CLOCK_REGRESSION`；回退配合更大 TTL 可续租延长。R1 持久化租期起点。落在当前租期内的回退仍无法与有效时刻区分（拒绝均零写入）。

### 持久化读取

仅私有宿主本地读取：`readSessionBinding`、`readSessionBindings`、`readCurrentOwnership`（不论是否过期均读持久化行）、`readFencingHighWater`（从未分配则为 0）、`readLeaseStatus`（`UNOWNED`/`ACTIVE`/`EXPIRED`/`CLOCK_REGRESSION`）。每项基于单个读快照，执行同样一致性验证。

### P1B 加固固定项

P1B-R1 最终门禁的四个 MINOR 缺口已有回归固定：能力验证缺信任代（join、bind、赞助 create、Session attach 上的 `STORAGE_CORRUPT`）；已授权 join/赞助创建重放中损坏先于冲突；`recoverTrustRoot` 每个 unwrap guard（分类器原样提取为 `classifyRecoveryFailure` 并有单元固定，加端到端 BUSY、未分类回滚、类型化回滚）；赞助重放负向授权矩阵。

## 10. B3-P2A-R1 租期持久化、获取边界及 schema v3

修复修订（CE-0002-B3-P2A-R1），受版本化 P2 所有权契约约束（`docs/ownership-contract.md`，Q1–Q5）。保留 §§1-9，唯本节明确取代 §9 之处除外。

### Schema v3（增量，仅显式迁移）

- `participant_ownership.lease_started_at TEXT`（可空）：当前租期起点，获取时写入、每次续租更新。NULL 标记旧 v2 行，在所有时刻均视为过期；不从不可信 TTL 伪造起点，v3 操作不针对旧行授权。
- `participant_capability.session_id TEXT`（可空）：`resume` 能力的持久化 Session 绑定。其他 scope 和旧 v2 行为 NULL；旧未绑定 resume 能力永不授权（封闭失败）。
- `participant_session_unique_session_id`：Session 跨 Participant 的持久化唯一性。历史行将一个 Session 绑定多个 Participant 时，v2→v3 迁移以 `STORAGE_CORRUPT`、零写入拒绝；不修复冲突历史。
- 迁移路径显式获批：v1→v2（P1A 不变）、v2→v3、v1→v3 链。每步独立提交，中断仅回滚该步。v2→v3 重新验证既有信任根，不创建、轮换或删除宿主秘密。正常打开要求当前 v3；v1/v2 返回 `STORAGE_MIGRATION_REQUIRED`。新建及迁移 v3 收敛为字节一致的 schema 清单。

### 租期模型（取代 §9 推导起点）

租约评估仅将操作时钟与持久化边界 `[leaseStartedAt, expiresAt)` 比较。请求 TTL（默认 120 s，30–3600 s）仅用于获取/续租时计算*新*到期时间，绝不重释已存租期。`verifyOwnership`、`releaseOwnership`、`readLeaseStatus` 不再接受 TTL。续租设 `lease_started_at = now`，拒绝缩短租期（`LEASE_TERM_SHORTENED`）。保留精确到期拒绝。时钟回退至持久化起点之前为 `LEASE_CLOCK_REGRESSION`，永不续租或延长；当前租期内回退不可检测（已记录限制，拒绝零写入）。

### 获取边界（设计澄清 Q1）

仅在 Participant 无所有权行时准入 `acquireOwnership`。任何已有行均拒绝：按操作时钟租约有效为 `OWNERSHIP_HELD`，过期后为 `OWNERSHIP_TAKEOVER_REQUIRED`（含旧 v2 行）。拒绝不分配 fencing token。**§11 更新**：CE-0002-B3-P2B 启用 `takeover` 并实现显式接管；获取边界不变。

### Session-bound resume（设计澄清 Q2）

`resume` 能力为恰好一个当前已绑定 Session 签发（签发必须有 `sessionId`，其他 scope 禁止），仅授权该 Session；新增宿主本地分类 `SESSION_MISMATCH`。撤销 resume 能力须呈现其绑定 Session。绑定缩小权限，本身绝非凭证，单独 Session ID 从不授权。

### 回归覆盖（R1）

新增真实 SQLite 固定项涵盖：不依赖 TTL 的租期评估（无误报 `LEASE_CLOCK_REGRESSION`）、回退配合扩大 TTL 的拒绝、续租起点持久化、精确到期拒绝、过期 Owner 续租/释放拒绝、过期 Owner 获取拒绝（`OWNERSHIP_TAKEOVER_REQUIRED`）、首次获取、释放/重启后的 fencing 单调性、重启持久化、带旧行策略的 v2→v3 迁移、新建/迁移清单收敛、冲突历史迁移拒绝、Session 持久化唯一性、多进程续租与获取竞争、全部所有权操作缺信任代，以及带隐私和零写入拒绝的 BUSY/ROLLED_BACK/INDETERMINATE 分类。

## 11. B3-P2B 持久化接管、替代与对账

增量修订（CE-0002-B3-P2B）。无 schema 变化，复用已验收 v3 列。保留 §§1-10，唯本节明确更新 §10 之处除外。CE-0002-B3-P2B-R1 进一步修订本节（见“事务内时钟采样”），修复独立确认的加锁前旧时钟缺陷，不改变接管权限、资格、fencing、替代或对账契约。

### 接管权限

`takeover` scope 可操作且 Session-bound，沿用 resume 模型：签发须用 `sessionId` 指定 Participant 当前已绑定 Session（潜在新 Owner）；非 Session-bound scope 禁止 `sessionId`；变更事务内比较持久化绑定（`SESSION_MISMATCH`）；撤销须呈现绑定 Session。Session ID 本身从不授予接管权限；bearer token、Participant 绑定、scope、信任代、撤销、到期检查不变。`send`/`ack`/`read` 仍为 `CAPABILITY_SCOPE_UNSUPPORTED`。

### 接管资格

`takeoverOwnership` 替换按操作时钟已过期的**既存**所有权行，包括旧 v2 行（NULL `lease_started_at`，任何时刻均过期）。拒绝：有效 Owner（`OWNERSHIP_HELD`，按持久化租期评估，到期前一毫秒仍拒绝，精确到期可接管）；时钟回退租约（`LEASE_CLOCK_REGRESSION`）；无所有权行 Participant（`OWNERSHIP_TAKEOVER_INELIGIBLE`，首次获取仍由 `attach` 完成）；损坏所有权（`STORAGE_OWNERSHIP_CORRUPT`，不修复）；无效、撤销、到期、错误 Participant/Session/scope/代能力（`CAPABILITY_REJECTED`）。本阶段不允许强制接管有效 Owner。

### 事务内时钟采样（B3-P2B-R1）

**更新 §10 租约时间措辞并解决 R1 审查 MINOR-1。** P2B 原在 `BEGIN IMMEDIATE` 前采样；等待 SQLite 写锁后，仍用加锁前旧时刻评估授权及租约（独立确认的 MAJOR-1：到期前发起、到期后串行执行的续租提交并复活过期租约；等待时已过期能力被接受）。

R1 为每个自有变更事务定义唯一权威采样点：事务内、`BEGIN IMMEDIATE` 获写锁之后，即 `BEGIN IMMEDIATE → sample now → validate
authority → evaluate current state → mutate → COMMIT`。一次变更内所有检查共用该时刻。适用于 `bindSession`、`acquireOwnership`、`renewLease`、`releaseOwnership`、`verifyOwnership`、`takeoverOwnership`，以及能力/成员变更（`createParticipant` sponsor 授权、`bindEndpointRef`、`issueCapability`、`revokeCapability`、`joinExchange`）。租期起止从事务内时钟派生，能力到期按同一时钟评估，因此等待期间到期的能力不会被接受。请求验证（形状、TTL 范围、身份）仍在事务前，不检查状态相关条件。

已定义的等锁语义：到期前发起、到期后串行执行的续租拒绝 `LEASE_EXPIRED`；同样时间关系的接管可准入并获胜；有效租约期间串行执行的接管拒绝 `OWNERSHIP_HELD`；等待期间到期能力拒绝 `CAPABILITY_REJECTED`。全部零写入，不分配 fencing token。

保留精确到期（`now >= expiresAt` 即过期）、时钟回退拒绝、注入时钟测试 seam（在事务采样点调用）和已记录的墙钟限制：落在当前租期内的回退不可与有效时刻区分；不声称跨事务单调时钟，不引入调度器或全局时钟。B2 Exchange/Message 创建在候选生成时、`BEGIN IMMEDIATE` 前采样（CE-0002-B3-P2C-A 修正措辞）；时间戳仅记录创建元数据，不授权，B2 契约不变。迁移/恢复/初始化的 `appliedAt` 同样不授权且不变。回归固定：`test/storage/lease-lock-wait.test.ts`（真实 OS 进程、真实写锁竞争、可观察发起、截止等待）。worker 发起标记原子发布（CE-0002-B3-P2C-A-R1）：完整标记先写入最终路径旁的暂存文件，再 rename，因此父进程不会读到半写标记；场景及时间断言不变。

### 原子替换与 fencing 转换

资格、fencing 分配、Owner 替换在一个自有 IMMEDIATE 事务中完成：high-water 恰增一（对旧值 compare-and-set，上限为 `FENCING_EXHAUSTED`）；原位重写所有权行（新 Session、新 token、`lease_started_at = now`、`expires_at = now + ttl`），由精确预读值保护，任何交错变化导致单行检查失败并回滚。并发接管恰一方获胜；其他方串行后遇 `OWNERSHIP_HELD` 或超时为 `STORAGE_TRANSACTION_BUSY`（可重试）。无部分分配、部分替换、token 复用，拒绝零写入。接管与有效租约续租竞争时，只要接管串行时租约有效就拒绝（见“事务内时钟采样”）：不论发起时读到什么，串行时有效即 `OWNERSHIP_HELD`。有效期内串行的续租延长租期；到期后串行拒绝 `LEASE_EXPIRED`，永不复活。竞争由各操作串行时的持久化租约状态决定：恰一方获胜，不受旧时钟偏差影响。

### 替代

接管成功后旧 Session 不再是当前 Owner：其 token 已陈旧（`FENCING_STALE`），`resume` 能力不能续租、释放或验证新 Owner（`OWNERSHIP_NOT_CURRENT`，由持久化行判断，不凭 Session ID）。保留历史绑定以延续审计。接管不创建 Participant、不改 Endpoint 绑定、成员关系、加入边界、审计历史或能力行。

### 恢复与对账

不确定接管结果（如 INDETERMINATE）须显式经 `reconcileTakeover` 对账。该零写入读取在一致快照中，将调用方证据（Participant、目标 Session、精确持久化租期边界、可选 token）与持久化行比较，绝不只凭 Session ID：

- `COMMITTED`：当前行精确匹配证据。这识别持久化状态效果，不归因到某次调用，也不声称 exactly-once：相同逻辑请求重试会存相同证据，无法指出哪次写入。不要重试。后续授权接管/续租仍可替代该租期。
- `NO_TRACE`：当前状态无所呈证据痕迹（无行、旧行、不同 Owner Session，或同 Session 但租期早于证据）。**不能**证明原调用从未提交：未提交、被拒绝、提交后被替代三者事后不可区分。新尝试的安全性仅来自重新授权及资格检查，不来自 `NO_TRACE` 证明未提交。
- `EVIDENCE_CONFLICT`：目标 Session 是当前 Owner，但租期/token 证据不同，当前状态由不同请求安装。绝不自动重试，交由操作员审查。

已记录限制（封闭失败，不发明 exactly-once 语义）：被拒绝与回滚接管留下相同持久化状态；提交后被替代返回 `NO_TRACE`；相同参数的已提交重试与原提交不可区分。没有后台恢复 worker。

#### 不确定结果后的证据可用性

`takeoverOwnership` 在自有 `BEGIN IMMEDIATE` 事务**内部**采样（见上）。该时刻不是普通调用方请求字段：`leaseStartedAt` 恰为采样，`expiresAt` 为 `sample + ttl`。因此调用方通常只能从 `takeoverOwnership` 成功返回值，或自行提供并记录操作时钟 seam 得到精确租期。默认墙钟调用以 INDETERMINATE 结束时，调用方**不知道**精确租期；调用前采样无法重建（真实采样发生在获写锁之后，已等待一段调用方未知、未记录的时间）。

`reconcileTakeover` 当前要求 `participantId`、`sessionId`、`leaseStartedAt`、`expiresAt`，`fencingToken` 可选。不得为满足输入而伪造、估计、取整边界：猜得比持久化租期晚，会将已提交误读为 `NO_TRACE`；猜得早，会将同 Session 行误归为 `EVIDENCE_CONFLICT`。没有精确证据时，调用方只能保留结果未知。`reconcileTakeover` 不接受 UNKNOWN 输入，也不返回 UNKNOWN disposition；保留不确定性是调用方判断，不是已有 API 分类，上述三类含义不变。

INDETERMINATE 不等于 ROLLED_BACK。不确定结果导致失效的连接不得复用；恢复检查须新开 Store。确认响应丢失从不授权盲目重试。

调用前也可快照该 Participant 的 `readFencingHighWater`。若后续有效读取同一 Participant 仍返回相同值，则在两读之间没有提交 fencing 分配，因而没有成功接管或获取，前提是两次读取有效、顺序正确且指向同一 Participant。high-water 增加仅证明某次分配已提交，不能识别哪次调用，不能证明本次接管提交，也不建立持久化租约（只有所有权行能证明）。这是效果级证据。

`reconcileTakeover` 仍无生产调用方（CE-TAKEOVER-RECONCILIATION-EVIDENCE-001）：真实时钟调用方在 INDETERMINATE 后无法重建精确租期，因此不得编造证据或盲目重试。

CE-TAKEOVER-RECOVERY-CALLER-001 已由显式操作员专用调用方解决，位于 `src/host/ownership-recovery.ts` 和 `scripts/recover-stale-ownership.mjs`。要求精确 Endpoint，以及操作员确认的旧 Session、token、租期起止。恢复写入前拒绝缺失、不匹配、时钟回退或有效所有权；仅使用 `bindSession`、Session-bound 能力、`takeoverOwnership`、`releaseOwnership`、`detachSession`；保留单调 fencing；输出无能力的结构化回执。它不是 MCP/Pi 工具，正常宿主启动永不调用。任何未知结果都停下，要求重新检查持久化状态，不自动重试。

### 旧所有权恢复

迁移 v2 所有权行（NULL `lease_started_at`）永不作为有效租约授权，也不修复。可显式 Session-bound 接管，将其替换为完整持久化 v3 租期（`lease_started_at = now`），分配严格大于旧 token 的 token（v2 high-water 在迁移中原样保留）。

## 12. B3-P2C-A 不可逆 Session 生命周期与 schema v4

增量修订（CE-0002-B3-P2C-A），受已验收 CE-0002-B3-P2C-D0 设计约束，记录于 `docs/ownership-contract.md`。保留 §§1-11。不新增 detach 操作、能力 scope 或投递。

### Schema v4（增量触发器，仅显式迁移）

`V4_ADDITIVE_SQL` 仅追加七个触发器：`participant_session_insert_attached`、`participant_session_nodelete`、`participant_session_identity_immutable`、`participant_session_detach_once`、`participant_session_detach_not_owner`、`participant_ownership_session_attached_insert`、`participant_ownership_session_attached_update`。新建使用 `V4_FOUNDATION_SQL = V3_FOUNDATION_SQL + V4_ADDITIVE_SQL`，一个 v4 基础账本行；新建/迁移 v4 收敛为字节一致清单。触发器仅在缺陷或特权篡改时触发（代码先以类型化、零写入方式拒绝）；能 drop 它们的行为者不在保护范围（`CE-STORAGE-IMMUTABILITY-V2` 不变）。

### 时间戳验证边界（CE-0002-B3-P2C-A-R1）

detach 转换是唯一可写 `detached_at` 的路径。schema v4 对 `detached_at` 强制执行已验收规范表示，不仅检查单向 revision 转换：

- **SQLite 强制**（仅 `participant_session_detach_once` UPDATE 路径）：`detached_at` 为规范 UTC 时刻，含 GLOB 形状（`YYYY-MM-DDTHH:MM:SS.mmmZ`）、`strftime` 解析往返（月 13、2 月 30、非闰年 2 月 29、日 00、分钟 60、闰秒均拒绝，不静默规范化）、hour < 24（SQLite 解析器接受 `24:00:00`，已验收表示不接受）；`bound_at` 也须规范，且文本比较 `detached_at >= bound_at`（固定宽度规范 UTC 文本的顺序等同时间顺序）。拒绝 NULL 和空串；STRICT TEXT 列不能存 BLOB，错误存储类别至多以不匹配文本进入谓词。
- **应用解析器强制**（`session-state.ts`）：每次读行均对 `bound_at`、`detached_at` 检查形状、`Date.parse` 有限性、`toISOString` 往返，另验证身份模式及两状态 revision 矩阵。应用仍是权威：insert 触发器仅检查生来 ATTACHED，特权写入方仍可插入畸形 `bound_at`；每次读取均以 `STORAGE_OWNERSHIP_CORRUPT` 拒绝，detach 路径封闭失败。

**信任边界。** 触发器仅在存在且执行时保护。关闭 `recursive_triggers` 的连接可经冲突解决（`INSERT OR REPLACE`）删除绕过删除触发器；存储连接每次打开均断言 `recursive_triggers=ON`（连同 `foreign_keys=ON`、`trusted_schema=OFF`）。无限制数据库写入者可删除触发器或直接改行，不声称防护（`CE-STORAGE-IMMUTABILITY-V2` 不变）。

### 版本识别及迁移

- 正常打开要求 v4；v1、v2、v3 零写入拒绝 `STORAGE_MIGRATION_REQUIRED`。v4 的 `user_version` 为 4，全部旧二进制（最高支持 3）以 `STORAGE_SCHEMA_TOO_NEW` 拒绝。
- 显式获批路径：单步 1→2、2→3、3→4；链 1→3、2→4、1→4。每步一个自有 IMMEDIATE 事务，独立提交；中断回滚到上一个有效版本，余下步骤可重试。中间目标 v2/v3 经结构验证的 proof open 证明。
- v3→v4 重新验证信任根（不创建、轮换、删除秘密），原样保留 Session、所有权、fencing、能力行；任一 pre-v4 Session 非精确 ATTACHED r1，或所有权引用 detached Session，均 `STORAGE_CORRUPT`、零写入拒绝，不修复。v2/v3 来源在一次性预检快照上也做此检查，使链在任何步骤提交前拒绝；v4 步骤内在 live writer 再查。

### Session 生命周期验证与读取

ATTACHED（NULL，r1）和 DETACHED（规范时刻 ≥ `bound_at`，r2）是仅有有效行；任何读取 Session 行处（含能力签发）遇其他形状均 `STORAGE_OWNERSHIP_CORRUPT`。DETACHED Session 不是当前绑定（`SESSION_NOT_BOUND`），不接收新 Session-bound 能力，永不成为获取/接管目标。`readSessionLifecycle` 是私有宿主本地、零写入、单快照读取（`ATTACHED` / `DETACHED` / `NOT_FOUND`）；不重新导出，拒绝使用固定脱敏详情。

### 回归覆盖

`test/storage/session-lifecycle.test.ts`：新建 v4 结构、全部触发器（含独立身份强制）、Session ID 复用拒绝、当前 Owner detach guard（有效、过期、被替代后）、所有权引用 detached Session、全部操作的 detached 拒绝、带隐私/零写入断言的畸形矩阵、重启持久化、生命周期读取、v3→v4 / v2→v4 / v1→v4 迁移、中断及逐步原子性、信任根连续性、外来生命周期零写入预检拒绝、清单收敛。CE-0002-B3-P2C-A-R1 增加触发器时间戳矩阵：NULL、空值、错误存储类、畸形、非规范、无效日历值、早于 `bound_at` 的 `detached_at`，以及畸形 `bound_at` 上 detach，均由 SQLite 自身拒绝，应用层拒绝仍有测试固定。

CE-0002-B3-P2C-B 新增授权 detach 面：`test/storage/detach-lifecycle.test.ts`（伪造/到期/撤销/错误 scope/错误 Session 能力矩阵；无所有权、已释放、被替代、有效/过期/旧版/时钟回退当前 Owner、`bound_at` 前回退、损坏所有权、串行并发 release/takeover/renew/detach 的完整交互；`SESSION_DETACHED` 本地状态、不透明调用方拒绝、无批量撤销、撤销与过期同样拒绝；`reconcileDetach` COMMITTED / NO_TRACE / EVIDENCE_CONFLICT）；`test/storage/detach-crash.test.ts`（真实进程在提交前后 SIGKILL，持久化取证及封闭失败对账：回滚 → NO_TRACE + 新尝试成功；提交 → COMMITTED + 终态重试拒绝）；`test/storage/lease-lock-wait.test.ts` 场景 F/G（真实进程及写锁：租约到期后串行 detach 仍以 `SESSION_IS_CURRENT_OWNER` 零写入拒绝；非 Owner 等锁后按串行时刻提交 detach，不动所有权/fencing）。

## B3-P3A：Session 授权的持久化发送/读取（CE-0002-B3-P3A）

状态：**已实现为私有存储切片**。Schema v4 和冻结公共 `Message` 实体不变。本修订不定义端点投递、ACK、worker、重试、对账、Pi 运行时集成或公共载荷列表 API。更广 P3 投递范围仍未完成。

### 保留 B2 创建

`createMessage` 仍为已验收的受信宿主操作：既有调用方无需 Session，保留请求摘要、Exchange 作用域幂等性、新写入准入前重放、原子 Message/幂等/审计三元组、审计排序、载荷处理及 BUSY/ROLLED_BACK/INDETERMINATE。P3A 复用提取的事务内持久化 helper，不重建 Message 存储。

### 授权发送

`sendMessage` 属私有存储权限。在 `BEGIN IMMEDIATE` 前捕获并验证请求，获写锁后采样唯一权威时刻。同一事务内依次验证：精确 Session-bound `send` 能力和 ATTACHED 生命周期；持久化当前 Owner；所呈单调 token；有效持久化租约；成员关系；发送 Participant 的不可变 `(adapter, endpointId)` 绑定。Session ID 或调用方标签从不是权限。

全部检查先于受保护幂等重放。已授权历史重放即使 Exchange 关闭仍零写入；新 Message 再执行 OPEN/无 disposition 准入。新建原子提交 Message、幂等记录和一个 `message_created` 事件。COMMIT 前不返回结果。不确定结果后不盲目重试，不声称 exactly-once 或远端去重。

### 受保护接收方元数据读取

`readMessageMetadata` 是同一写锁下串行的可重复私有操作。要求精确 Session-bound `read` 能力、ATTACHED 当前 Owner、有效租约、当前 fencing、持久化成员关系、请求 Exchange 身份、与已存接收方匹配的稳定端点绑定。缺失及错误接收方身份共享不透明资格拒绝。仅返回冻结 `Message` 元数据及私有 `auditSequence`，不输出载荷。

资格为 `message_created.sequence > exchange_membership.join_boundary_seq`。关联审计行须唯一，且精确匹配 Message 身份、Exchange、创建时刻、摘要、长度；缺失、重复、不一致关联均按持久化损坏封闭失败。审计序号为私有投影，不新增 `Message.seq`。

### Cursor 及余下投递范围

P3A 从不插入或更新 `delivery_cursor`。发送、重放、读取、拒绝、回滚、竞争、崩溃、恢复均不伪造 ACK 进度。`ack` 仍为 `CAPABILITY_SCOPE_UNSUPPORTED`。ACK/cursor 推进、端点投递、worker、自动重试、远端去重、投递对账、接管恢复 API 重设计不在本修订范围。

### P3A 证据

`test/storage/message-send-read.test.ts` 固定授权先于重放、B2 保留、精确能力/Session/Participant/Owner/租约/fencing 检查、成员及端点绑定、关闭/重放准入、仅接收方及加入边界可见性、精确审计关联、回滚、BUSY、INDETERMINATE 新 Store 检查、元数据隐私、cursor 不变。`test/storage/message-send-concurrency.test.ts` 用独立 OS 进程测同键发送及 send 对 release/takeover 串行。`test/storage/message-send-crash.test.ts` 在 after-BEGIN、after-Message、after-idempotency、after-audit、after-COMMIT 真实 SIGKILL，证明仅完整事务保留。

## B3-P3C：最小审计关联索引（CE-ARCH-P3C-INDEX-001）

Schema v5 恰追加一个非唯一索引：`idx_audit_event_correlation ON audit_event(exchange_id, kind, subject_id)`。Schema v1-v4 SQL、对象名、校验和全部冻结。索引加速既有精确 P3A 关联谓词，不断言唯一性，不改变 Message、Audit Sequence、成员、端点、能力、Session、租约、fencing、ACK 语义。

新建写 v5 基础账本及精确清单。既有 v4 须显式获批 `4→5` 迁移，正常打开不迁移。经 v4 的历史获批路径仍可用，但止于精确 v4。v5 步骤在一个自有 `BEGIN IMMEDIATE` 中重新验证信任根、建索引、追加 v5 账本、推进 `user_version`。已证明提交前回滚则回到精确 v4。不确定提交不能确定 v4/v5，操作员须先检查持久化结构，绝不盲目重试。同名既存索引属漂移而拒绝；不使用 `IF NOT EXISTS`、修复或降级。

P3A 精确关联保留全部检查，最多读取两条匹配行。零、二或更多均属损坏；唯一行仍须匹配 Exchange、Message subject、创建时刻、摘要、长度、事件 schema、outcome、私有 revision。索引不能证明存在、唯一、字段一致或无孤儿行。v5 本身不新增 Inbox API；下述有界操作使用冻结 schema，不改变它。

## B3-P3C：有界存储 Inbox Discovery

状态：**已实现为私有存储切片**。不新增 schema 对象、迁移、表、索引、持久化 cursor、公共包导出、provider 集成、后台轮询器、重试循环、ACK、delivery cursor 或 Completion Authority。

### 私有操作及权限

`src/storage/inbox-discovery.ts` 的 `discoverInboxMessages` 复用精确 Session-bound `read` 能力及既有串行 `BEGIN IMMEDIATE` 边界。读取受保护元数据前验证请求形状、能力和 Exchange/Participant/Session 绑定、ATTACHED 生命周期、当前所有权、当前 token、有效租约、成员关系及 Participant 不可变端点绑定。保留既有脱敏错误分类及 BUSY/ROLLED_BACK/INDETERMINATE。

### 有界、审计优先枚举

计算 `max(afterAuditSequence, joinBoundarySeq)`，按 `sequence > ? ORDER BY sequence
ASC LIMIT ?` 最多读 `rawScanLimit` 条 Exchange 审计行。不用 Message 序号、时间戳、`OFFSET` 或 `K+1`。私有实现上限为 50 个合格 Message、2,000 条原始审计行；调用方只能请求更小的正安全整数，`pageSize` 不得大于 `rawScanLimit`。这些是实现参数，不是冻结协议常量。

每个 `message_created` 候选仅加载元数据，绝不加载 `payload_body`，再调用不变的 Schema v5 `LIMIT 2` 精确关联查询。仍须恰一匹配审计，并验证 Exchange、subject、事件 kind/schema、Audit Sequence、创建时刻、摘要、长度、revision、outcome。每条检查过的原始行须使用已识别协议或私有成员审计词汇，并有有效身份/序号字段。观察到缺 Message、重复关联、畸形元数据或稳定 Participant 端点绑定、字段不一致，整次失败，不返回部分元数据。有效消息按授权 Participant 的稳定接收端点过滤。

返回冻结 `{ messages, continuationAuditSequence,
scanBudgetExhausted }`。非空 continuation 恰为最后实际检查的原始 Audit Sequence，含被过滤事件；未检查任何原始行为 null。达到合格消息上限立即停止，不越过未检查行。仅完整用尽原始预算时 `scanBudgetExhausted` 为 true，不断言还有合格消息。continuation 是下次请求的无状态调用方输入，绝不持久化，也不解释为 ACK 进度。

### 完整性限制及证据

审计优先发现无法找到没有 `message_created` 行的 Message，因此有界空结果不能证明全库完整性，也不声称检测全部孤儿 Message。这是有意限制：被检查的 `message_created` 候选中的可观察损坏封闭失败，未引用 Message 不在该审计窗口内。

`test/storage/inbox-discovery.test.ts` 覆盖权限、分页、接收方及 Exchange 过滤、加入边界、扫描限额、损坏、隐私、零写入、BUSY/INDETERMINATE、重启、查询计划。`test/storage/inbox-discovery-concurrency.test.ts` 用独立进程证明 send/list、revocation/list、release/list 有效前后顺序，并用确定持有的 Inbox 事务排除重叠发送方。

## B3-P4C：Schema v6 独立载荷能力

状态：**仅 schema 和能力权限已实现**。本阶段不新增载荷读取 Storage 操作、Session Host 签发、Pi 工具、投递、ACK、cursor 变更、回执、消费状态、接管或 Completion Authority。

### Schema v6

仅在封闭 `participant_capability.scope` 词汇中添加 `payload_read`。Schema v1-v5 SQL 和校验和全部冻结。显式 v5→v6 创建 `participant_capability_v6`，复制全部列/行，验证等行数及双向 `EXCEPT` 等价，删除 v5 表并重命名。相同自有 `BEGIN IMMEDIATE` 步骤要求 `PRAGMA foreign_key_check` 为空，追加带校验和 v6 账本行并将 `user_version` 置 6。已证明失败整步回滚至有效 v5；不确定结果须检查持久化结构，不自动重试。

新建 v6 应用不变 v5 基础，再执行同一 v6 重建 SQL。新建/迁移收敛为严格获批清单。正常打开仅接受 v6，已识别 v1-v5 返回 `STORAGE_MIGRATION_REQUIRED`，迁移仍为显式操作员行动。每个 v1-v5 来源到 v6 的获批链按序执行历史步骤，每步独立事务/提交边界。

### 独立 `payload_read` 权限

`payload_read` 是新增 P4C 操作性 Session-bound scope。历史 P3A scope 列表仍精确为 `send` 和 `read`；`read` 仅元数据，不授权载荷披露。能力 HMAC 派生包含精确 scope，因此 `read` 和 `payload_read` token 在密码学上不可互换。

签发要求与其他 Session-bound scope 相同的既有持久化 ATTACHED 绑定。Participant/Session 绑定、信任代、撤销、到期、DETACHED 失效均原样继承。共享 current-Owner 授权原语接受 `payload_read` 作为精确未来操作 scope，保留所有权、fencing、有效租约检查。本阶段无组件自动签发；不持久化、记录或通过公共 DTO 暴露明文 bearer token。

证据由 `test/storage/schema-v6.test.ts`、`test/storage/payload-read-capability.test.ts` 以及不变的迁移、Store、能力、消息、Inbox、所有权、恢复回归套件固定。

## B3-P4D：授权 Message 载荷读取

状态：**Storage、Pi session host 及操作员自愿启用的 Pi 扩展工具均已实现**。Schema v6、`payload_read` 和 B3-P4C 全部冻结契约不变；不新增 schema 对象、能力 scope、ACK、cursor、回执、投递生命周期或 Completion Authority 语义。

### 私有 Storage 操作

`src/storage/messaging.ts` 的 `readMessagePayload` 与元数据读取采用相同请求形状和自有 `BEGIN IMMEDIATE` 串行边界。同一事务内验证精确 `payload_read` scope（不接受元数据 `read`，反之亦然）、ATTACHED Session、当前 Owner、当前 token、有效租约；随后仅按元数据验证成员关系、Message、缺失/错误接收方不透明拒绝、接收端点、精确 `message_created` 关联及加入边界。全部通过后才由 `src/storage/creation.ts` 的 `readMessagePayloadBodyInTransaction` 实体化 `payload_body`，验证 BLOB 类别、精确字节长度、SHA-256 摘要，提交后返回全新完整字节副本。纯读取：重复授权读取返回相同字节，不改变 Message、Audit、回执、cursor、租约、所有权、能力。`DELIVERY_UNKNOWN` 仍是 `DELIVERY_UNKNOWN`。

### Session host 与 Pi 扩展

`CeSessionHost.readPayload` 将原始 Store 和明文能力保留在 host/storage 边界内。`payloadRead.enabled` 操作员策略仅接受精确 boolean `true`；缺失、false、畸形均封闭失败。策略在 host 实例生命周期内固定，同时控制 `beginSession` 和已验证 `resume` 的签发；禁用时固定返回脱敏 `CE_HOST_PAYLOAD_DISABLED`。暴露上限为编码后 65,536 字节，解码前检查（`CE_HOST_PAYLOAD_TOO_LARGE`），严格 UTF-8 解码（`CE_HOST_PAYLOAD_INVALID_UTF8`），绝不返回部分内容。

扩展仅在 opt-in 启用时注册 `ce_read_payload`（输入仅 `messageId`）；禁用部署完全不注册载荷工具。每次调用读取受保护当前 Pi 上下文、解析 allowlist、检查启动绑定、同步委托。成功结果为固定不可信内容警告加精确解码文本；载荷不进入 details、日志、失败、映射，不自动 ACK、消费、轮询、注入或接管。

证据：`test/storage/message-payload-read.test.ts`、`test/endpoints/pi/session-host-payload.test.ts`、`test/endpoints/pi/extension-payload.test.ts`。
