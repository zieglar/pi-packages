[English](ownership-contract.md) | [简体中文](ownership-contract.zh-CN.md)

# B3-P2 所有权契约

> 版本化阶段记录：各节“尚未实现”和 scope 状态适用于该节所述阶段；后续修订按顺序覆盖早期状态。当前 ACK 契约见 [delivery-ack-contract.md](delivery-ack-contract.zh-CN.md)，综合存储契约见 [storage-contract.md](storage-contract.zh-CN.md)。

状态：**由 CE-0002-B3-P2A-R1 澄清**（本文是 P2 所有权设计决策的版本化记录）。范围仅限私有持久存储平面，不定义 delivery、adapter 或 Pi runtime 表面。

## 来源

P2A 交付时，仓库内没有已接受的 B3-D0 设计记录；独立审查（CE-0002-B3-P2A-INDEPENDENT-REVIEW-1）发现租约时间模型不安全（MAJOR-1），以及五个尚未决定的设计问题（Q1–Q5）。R1 记录以下决策。每项均区分已接受的现有行为（来自已实现并审查的 B2/P1A/P1B/P2A）与自 R1 起生效的新澄清决策。

## Q1：替换 Owner 属于 takeover

**新决策：**替换任何已有 Owner，包括租约已过期的 Owner，均属于 P2B `takeover` 范围。只有 Participant 不存在 ownership 行时，`attach` 才能取得所有权。

- 已有 live 行以 `OWNERSHIP_HELD` 拒绝获取（已接受的 P2A 行为，不变）。
- 已有 expired 行，包括在任意时刻均过期的旧 v2 行，以 `OWNERSHIP_TAKEOVER_REQUIRED` 拒绝获取（新增）。被拒绝的获取不分配 fencing token。
- R1 中 `takeover` 仍为 `CAPABILITY_SCOPE_UNSUPPORTED`，未实现 takeover。
- 因此，租约过期后，在 P2B takeover 实现前，Participant 保留持久、受 fencing 约束但不授予权限的 ownership 记录。这是有意的默认拒绝行为，不是遗漏。

## Q2：Resume 权限绑定 Session

**新决策：**`resume` 权限最终必须绑定 Session。R1 实现最小安全基础：

- Schema v3 增加 `participant_capability.session_id`（可空；所有非 resume scope 和旧 v2 行均为 NULL）。
- 签发 `resume` capability 必须提供 `sessionId`，签发时 Session 必须当前绑定到 Participant（在同一事务中检查）。其他所有 scope 均拒绝 `sessionId`。
- 每次 `resume` 授权都在修改事务内比较持久绑定与所呈现的 Session；旧的未绑定行、缺少 Session 或不匹配均归类为 `SESSION_MISMATCH` 并拒绝。
- 撤销 `resume` capability 必须呈现其绑定的 Session。
- **非目标：**Session ID 不是凭证。没有操作可以仅凭 Session ID 授权；bearer token、Participant 绑定、scope、trust generation、撤销和过期检查均不变。

P2A 的 Participant 级 resume token 不延续：迁移后的 store 中，旧（NULL）resume capability 永远不能授权。host 签发新的 Session-bound resume capability。默认拒绝，不静默扩大权限。

## Q3：持久保存租约期限边界

**新决策：**持久保存租约起点（`participant_ownership.lease_started_at`），在获取时写入，每次续租时更新。默认 TTL 120 秒；允许 TTL 30–3600 秒（沿用 P2A）。

- 租约判断只将操作时钟与持久边界 `[leaseStartedAt, expiresAt)` 比较。请求 TTL 只在获取或续租时计算新 expiry，绝不重新解释已存期限。（这修复 R1 发现 MAJOR-1：P2A 用 `expiresAt − requestTTL` 推导起点，不同调用 TTL 不同时会误拒绝有效 Owner，也允许回退时钟通过扩大所呈现 TTL 延长租约。）
- 续租不得缩短期限：新 expiry 早于当前值时拒绝（`LEASE_TERM_SHORTENED`）。
- 保留恰好过期时的拒绝：`now >= expiresAt` 为 `LEASE_EXPIRED`。
- **已知限制（不变，已记录）：**没有持久单调观察值时，无法区分落在当前期限内部的墙上时钟回退与有效时刻。R1 不声称检测所有回退。拒绝均为零写入。
- 旧 v2 ownership 行（NULL `lease_started_at`）在任意时刻均视为过期：不从不可信 TTL 编造起点，也没有 v3 操作可以据其授权。

## Q4：过期 Owner 不能 release

**决策（确认现有 P2A 行为，现纳入契约）：**release 要求 live lease。过期 Owner 的 release 以 `LEASE_EXPIRED` 拒绝；行保留为受 fencing 约束且不授予权限的记录，直到 takeover。

## Q5：不能直接删除当前 Owner 的 Session 绑定

**决策（确认现有 P2A 行为，现纳入契约）：**P2A/P2A-R1 没有 detach 操作。当前 Owner 对应的 Session 已 detached，属于不一致持久状态（`STORAGE_OWNERSHIP_CORRUPT`，拒绝且绝不修复）。Detach 语义（包括 detach 与 ownership 的排序规则）延后到 P2B。

## R1 原样沿用的已接受行为

- Session 身份：不透明、非秘密的 `ses_<ULID>`；绝不是 Participant 身份或凭证。一个 Session 恰好属于一个 Participant（现在也由持久 `participant_session_unique_session_id` 索引强制）；一个 Participant 可有多个历史 Session。绑定不授予所有权；创建 Participant 不创建 Session 或 ownership。
- Fencing：首个 token 为 1；每个 Participant 的 high-water 严格单调；跨重启、过期和 release 保留；永不复用；超过 `Number.MAX_SAFE_INTEGER` 的分配拒绝（`FENCING_EXHAUSTED`）；fencing 与 ownership 写入为原子单元；ownership 行必须恰好带当前 high-water token 和已绑定 Session，否则状态损坏。
- Capability 平面：bearer token、host-keyed digest、trust-generation 绑定、撤销、过期；统一不透明 `CAPABILITY_REJECTED` 分类；每次授权重新验证 trust root。
- 事务纪律：受控 BEGIN IMMEDIATE 事务；BUSY / ROLLED_BACK / INDETERMINATE 分类；拒绝而不修复；零写入拒绝；隐私边界（固定、已净化的 details）。

## R1 记录的 P2B 前置事项

1. Takeover：在 `takeover` capability 下替换已有（expired 或 legacy）Owner，分配下一个 fencing token 和新期限；分类并固定 takeover 竞争行为。**已由 CE-0002-B3-P2B 实现**，见下文。
2. Detach：定义排序规则（ownership 行仍引用当前 Owner 绑定时不得 detach，Q5），以及 detach 时 Session-bound resume capability 的命运。
3. 租约策略位置：若 TTL 策略必须超出单次请求存续（如 store 固定策略），需决定其是否属于持久元数据。

## P2B：Takeover 已实现（CE-0002-B3-P2B）

状态：**已实现**。落实 Q1，且不改变 R1 边界：`acquireOwnership` 仍拒绝每个已有行；替换只能通过 `takeover` scope 下的 `takeoverOwnership`。

- **权限。**`takeover` scope 已可用，并绑定到预期新 Owner Session，与已接受的 resume 模型（Q2）一致：签发要求 `sessionId` 指向 Participant 当前绑定的 Session；分类在修改事务内比较持久绑定；撤销要求呈现绑定 Session。Session ID 单独不授予 takeover 权限。`send`、`ack`、`read` 仍未启用。
- **资格。**只允许接管已有 EXPIRED 行，包括旧 v2 行（NULL `lease_started_at`，任意时刻均过期）。live Owner 拒绝（`OWNERSHIP_HELD`，按持久期限判断；恰好 expiry 是边界）；时钟回退的租约拒绝（`LEASE_CLOCK_REGRESSION`）；无行时拒绝（`OWNERSHIP_TAKEOVER_INELIGIBLE`）：首次获取仍由 `attach` 执行。本阶段没有强制接管 live Owner。
- **原子性。**资格、fencing 分配（恰好 high-water + 1，compare-and-set，上限为 `FENCING_EXHAUSTED`）和 Owner 替换在一个受控 IMMEDIATE 事务中完成，并以确切预读值保护：恰好一个胜者、不发生部分 fencing 分配或部分替换、不复用 token、拒绝零写入。与 live lease 续租竞争的 takeover 绝不能获胜（竞争中的每个时刻租约均 live）。
- **取代。**旧 Session 立即失去当前所有权：其 fencing token 已过时，其 `resume` capability 不能续租、release 或验证新 Owner（`OWNERSHIP_NOT_CURRENT` / `FENCING_STALE`）。历史 Session 绑定、Participant 身份、Endpoint 绑定、Exchange 成员关系、加入边界和审计历史均不变；takeover 绝不修改 capability 行。
- **恢复。**`reconcileTakeover` 是零写入、默认拒绝的对账读取，依据调用方呈现的证据（Participant、目标 Session、确切持久期限边界、可选 fencing token）分类：`COMMITTED`（精确匹配持久状态，不重试）、`NO_TRACE`（持久状态无所呈现证据的痕迹；新尝试必须重新授权并检查资格）、`EVIDENCE_CONFLICT`（目标 Session 在不同证据下为当前 Session；需操作者审查，绝不自动重试）。三者均是持久状态的副作用级分类，不是对某次调用的操作级归因：`COMMITTED` 不声称恰好一次；`NO_TRACE` 不证明原调用从未提交（已提交后又被取代的 takeover 也报告 `NO_TRACE`）。明确保留以下限制，不用恰好一次语义掩盖：拒绝和已回滚的 takeover 留下相同持久状态；提交后被取代的 takeover 报告 `NO_TRACE`；参数相同且已提交的重试是同一逻辑请求。没有后台恢复 worker。
- **证据可用性（澄清，无行为变化）。**操作时钟在受控事务内采样（见下文 B3-P2B-R1），因此采样时刻不是普通调用方请求字段：`leaseStartedAt` 为该采样，`expiresAt` 为 `sample + ttl`。调用方通常只能从成功返回获得确切期限，或自行提供并记录操作时钟 seam；使用默认时钟且调用以 INDETERMINATE 结束的调用方不知道该期限，调用前采样墙上时钟也不能重建。`reconcileTakeover` 当前要求 `participantId`、`sessionId`、`leaseStartedAt`、`expiresAt`，可选 `fencingToken`；调用方不得编造、估算或舍入期限边界来满足输入形状。INDETERMINATE 不等于 ROLLED_BACK：不得复用失效连接，检查要求新打开的 store，丢失确认绝不授权盲目重试。没有确切期限证据时，结果对调用方仍未知；API 没有 UNKNOWN 输入或 UNKNOWN disposition。对同一 Participant，有效后读的 `readFencingHighWater` 与调用前快照相同，说明两次读取间该 Participant 没有 fencing 分配提交；high-water 增长不能标识调用、不能证明本调用方的 takeover，也不能建立持久租约。解决 CE-TAKEOVER-RECOVERY-CALLER-001 的仅限操作者恢复调用方有意不调用 `reconcileTakeover`：写入前要求确切 endpoint 和旧 Owner 证据，以及已过期的持久租约；随后绑定新的 recovery Session，使用现有 Session-bound `takeover` 原语，release 该租约，再 detach recovery Session。成功返回不含 capability 的 receipt 及持久 fencing/session 证据。任何阶段为 INDETERMINATE 时保持未知，绝不自动重试。`reconcileTakeover` 仍无生产调用方，因为默认时钟调用方丢失确认后无法重建确切期限边界（CE-TAKEOVER-RECONCILIATION-EVIDENCE-001）。完整说明见 `docs/storage-contract.md` §11 “Evidence availability after an uncertain outcome”。
- **旧 ownership。**迁移的 v2 行绝不授权、绝不修复；它具备 takeover 资格，takeover 用完整持久 v3 期限替换，fencing token 严格大于旧 token。
- Q4、Q5 不变：过期 Owner 不能 release；仍无 detach 操作（P2B 未纳入 detach，仍为前置事项 2）。

## B3-P2B-R1：事务内时钟采样（修复）

状态：**已实现**。修复 CE-0002-B3-P2B-INDEPENDENT-REVIEW-1 独立确认的 MAJOR-1（锁前陈旧时钟）。

**缺陷。**P2B 在 `BEGIN
IMMEDIATE` 前采样每个操作的时钟。等待 SQLite 写锁的操作使用锁前时刻判断授权和租约：过期前发起、过期后串行化的续租会依据陈旧采样提交，复活过期租约并阻止本已具备资格的 takeover（审查者以真实进程和真实锁竞争复现）。锁等待期间过期的 capability 也会被接受。

**新契约决策：**每个受控修改事务恰好有一个权威操作时间采样点，位于受控事务内部、`BEGIN
IMMEDIATE` 取得写锁之后：`BEGIN IMMEDIATE → sample now → validate authority → evaluate current state
→ mutate → COMMIT`。一次修改内的所有检查使用同一时刻。适用于 `bindSession`、`acquireOwnership`、`renewLease`、`releaseOwnership`、`verifyOwnership`、`takeoverOwnership`（ownership 平面），以及 `createParticipant`（sponsor 授权）、`bindEndpointRef`、`issueCapability`、`revokeCapability`、`joinExchange`（capability/membership 平面）。租约起点和 expiry 来自事务内时钟；capability expiry 按事务内时钟判断，因此锁等待期间过期的 capability 绝不会被接受。请求校验（字段形状、TTL 范围、身份）仍先于事务，不检查依赖状态的条件。

**保留语义。**恰好过期行为不变（`now >=
expiresAt` 为过期）；时钟回退拒绝不变（期限前时刻拒绝 `LEASE_CLOCK_REGRESSION`）；注入时钟测试 seam 不变（只将调用点移到事务内采样位置）；不引入 scheduler 或全局时钟。对其余存储修改入口的审计（由 CE-0002-B3-P2C-A 修正）：B2 Exchange/Message 创建在候选生成期间、`BEGIN IMMEDIATE` 之前采样时钟；时间戳是记录用创建元数据，不授权任何操作，因此已接受的 B2 契约不变（无效时钟行为仍按已接受先例）。migration/recovery/initialization 的 `appliedAt` ledger 时间戳同样不授权，保持不变。

**锁等待语义（现已定义）。**授权和资格由串行化时刻决定，不由发起时刻决定。过期前发起、过期后串行化的续租拒绝 `LEASE_EXPIRED`；过期前发起、过期后串行化的 takeover 具备资格并可能获胜；租约仍 live 时串行化的 takeover 拒绝 `OWNERSHIP_HELD`；等待期间过期的 capability 拒绝 `CAPABILITY_REJECTED`。所有此类拒绝均零写入，绝不分配 fencing token。

**剩余墙上时钟限制（不变，不新增单调性声明）。**落在当前期限内部的时钟回退，在没有持久单调观察值时仍无法与有效时刻区分（Q3）；事务内采样只在各自串行化时刻决定操作，不创建跨事务单调时钟。拒绝仍零写入。

**回归固定点。**`test/storage/lease-lock-wait.test.ts` 使用真实 OS 进程、真实写锁、可观察发起 marker，以及针对持久 expiry 的 deadline 等待，检查 renewal/takeover/capability 锁等待边界（不用仅靠 sleep 的断言，也不用假时钟模拟竞争）。

## P2B 记录的 P2C 前置事项

1. Detach 语义（Q5 排序规则和 detach 时 Session-bound capability 的命运）。
2. 租约策略位置（上文前置事项 3，不变）。
3. `send`/`ack`/`read` scope 仍留给投递阶段。

## B3-P2C-A：不可逆 Session 生命周期与 schema v4（CE-0002-B3-P2C-A）

状态：**已实现**（仅结构基础）。落实已接受的 CE-0002-B3-P2C-D0 设计决策 D1、D2、D5（作为 schema guard）、D9（读取）、D14 和 D15。**本阶段尚无 detach 操作**；capability scope 语义不变（没有 `detach` scope；`resume` 尚未扩展到 self-detach）。P3 尚未开始。

- **状态。**Session 行恰好是 ATTACHED（`detached_at IS NULL`、`private_revision = 1`）或 DETACHED（规范 `detached_at` 不早于 `bound_at`、`private_revision = 2`）。其他组合均为 `STORAGE_OWNERSHIP_CORRUPT`：拒绝、零写入、绝不修复。DETACHED 是终态；已 detached Session 绝不是当前绑定，也绝不重新获得权限。
- **Schema v4（仅 trigger）。**Session 行创建时为 ATTACHED，绝不删除；Participant ID、Session ID 和 `bound_at` 不可变；唯一允许的 UPDATE 是单向 ATTACHED r1 → DETACHED r2 转换；不能 detach 当前 Owner Session；ownership 行绝不能引用 detached Session。因此 Session ID 永不复用。不重建 table、不新增 column、不新增 capability scope。R1：转换还要求规范 `detached_at` 不早于规范 `bound_at`，由 SQLite 自身强制；确切的 SQLite/应用校验边界、`recursive_triggers` 要求和特权 writer 信任限制见 `docs/storage-contract.md` §12。
- **与 ownership 的关系（Q5 正式化）。**只要 ownership 行仍引用当前 Owner，无论 live、expired、legacy 或时钟回退，都不能 detach；退出方式是现有 release 或 takeover。Detach 绝不删除或替换 ownership，也不触碰 fencing high-water。
- **校验。**`issueCapability`（Session-bound scope）、`bindSession`、`acquireOwnership`、`takeoverOwnership`、`renewLease`、`releaseOwnership`、`verifyOwnership` 和每次 Session 读取都严格校验行：DETACHED Session 拒绝 `SESSION_NOT_BOUND`；格式损坏的行拒绝 `STORAGE_OWNERSHIP_CORRUPT`；重新绑定 detached Session ID 仍按原规则拒绝（`SESSION_ALREADY_BOUND` / `SESSION_BOUND_TO_OTHER_PARTICIPANT`）。
- **生命周期读取。**`readSessionLifecycle` 是私有、host-local、零写入的单快照读取，返回 `ATTACHED` / `DETACHED` / `NOT_FOUND`（外属配对为 `NOT_FOUND`）；同一快照中校验 Participant ownership 状态，不授予任何权限。
- **剩余 P2C 工作（P2C-B）：已实现**，由 CE-0002-B3-P2C-B 完成，见下一节。P3（send/ack/read、delivery）在本阶段尚未开始。

## B3-P2C-B：授权 Session Detach（CE-0002-B3-P2C-B）

状态：**已实现**。落实已接受的 P2C-D0 设计决策 D4、D7、D10 和 D11，不改变任何已接受边界：schema v4 保持冻结（无 DDL、无新 migration、无 checksum 变化），不存在 `detach` capability scope。Disconnect 不等于 Detach：Detach 是私有存储平面的持久绑定生命周期事实，绝不是 transport 事件。

- **操作（D4）。**`detachSession(store, request)` 使用 Session 自身的 Session-bound `resume` capability 执行单向 ATTACHED → DETACHED 转换，只能对自身执行。capability 必须恰好授权其绑定 Session；Session ID 单独绝不是凭证。在一个受控 BEGIN IMMEDIATE 事务内依次执行：事务内时钟（取得写锁后采样）、capability 校验（trust generation、expiry、revocation、Session 绑定）、Participant 身份、Session 绑定、完整 ownership 状态校验、当前 Owner 拒绝、时钟回退拒绝，以及受保护的 `detached_at IS NULL AND private_revision = 1` → `detached_at = now,` `private_revision = 2` 更新，恰好改变一行。
- **与 ownership 的关系（Q5）。**只要 ownership 行仍引用其 Session，当前 Owner 无论 live、expired、legacy（NULL `lease_started_at`）或时钟回退，均拒绝 `SESSION_IS_CURRENT_OWNER`，不论租约是否过期。退出方式是现有 release（仅 live Owner；保留 Q4：过期 Owner 不能 release）或授权 takeover；被取代的旧 Owner 随后可自由 detach。Detach 绝不修改 ownership 行、触碰 fencing high-water、删除 Session 行或修改 capability 行。并发 release / takeover / renew 结果由串行化持久状态决定；真实进程锁等待场景 F、G 固定串行化边界。
- **Capability 生命周期（D7）。**Session 生命周期校验集中在 capability 分类中：绑定 Session 已 DETACHED 的 Session-bound capability，对任何呈现者均不可用。持久 `detached_at` 是生命周期事实来源；只在读取时失效，不批量撤销、不重写 capability 行。调用方可见拒绝仍为统一不透明 `CAPABILITY_REJECTED`；host-local status read 标识 `SESSION_DETACHED`。未来 Session-bound scope（`send`、`ack`、`read`，本阶段未实现）加入 `SESSION_BOUND_CAPABILITY_SCOPES` 后原样继承此检查。Session-bound capability 的绑定行缺失或损坏时拒绝 `STORAGE_OWNERSHIP_CORRUPT`，绝不认领或修复。刻意的错误优先级变化（已记录并固定）：DETACHED Session 的 capability 平面拒绝，现优先于 `renewLease` / `releaseOwnership` / `verifyOwnership` / `takeoverOwnership` 之前返回的操作级 `SESSION_NOT_BOUND`；`attach`（非 Session-bound）仍在操作级拒绝 `SESSION_NOT_BOUND`。撤销 detached Session capability 与撤销已过期 capability 一样拒绝。
- **恢复。**`reconcileDetach(store, evidence)` 是不确定结果后的私有、基于读取、零写入、默认拒绝的对账（COMMIT 前后失败、响应丢失、BUSY、ROLLED_BACK、INDETERMINATE）：在一个快照中根据持久 Session 状态分类为 COMMITTED / NO_TRACE / EVIDENCE_CONFLICT，并在同一快照校验 ownership 一致性（并发 takeover 和 release 只是所观察状态的一部分）。证据 `detachedAt` 可选：提供时，精确匹配为 COMMITTED，任何不匹配为 EVIDENCE_CONFLICT（操作者审查）；不提供时，DETACHED 行为 COMMITTED，因为终态持久副作用存在。持久副作用幂等，但 API 响应不幂等：重试已提交 detach 会拒绝 `CAPABILITY_REJECTED`。因此必须先对账，绝不盲目重试；NO_TRACE 后的新尝试是新的完整授权，不是重放。不声称恰好一次执行。`reconcileTakeover` 不变。
- **租约策略（D10/D11）。**host 拥有租约策略：默认 TTL 120 秒，允许范围 30–3600 秒，建议每 30 秒续租。adapter 可按操作请求 TTL（`leaseTtlSeconds`）；请求仅在获取或续租时计算新 expiry，绝不重新解释已存期限。不持久化策略：没有 policy table，本阶段也无此计划。host 应使用获取和续租返回的 `expiresAt` 提前安排续租（并根据每次续租返回的 `expiresAt` 重新计算计划），因为过期后才串行化的操作拒绝 `LEASE_EXPIRED`，不能复活期限；始终由持久 `lease_started_at` / `expires_at` 边界决定。

## B3-P3A：限定 scope 的当前 Owner 权限

状态：**仅私有存储 send/read 已实现**。上文历史 P2 章节仍记录各阶段边界；其称 `send`/`read` 未启用的状态，由本 P3A 修订覆盖。

`send`、`read` 现在可用，且与 `resume`/`takeover` 一样绑定 Session：签发要求持久 ATTACHED Session 绑定；分类绑定 Participant + 确切 scope + trust generation + Session；撤销呈现该 Session；终态 detach 使 token 不可用，无需重写 capability 行。`ack` 在本阶段仍未启用。

共享当前 Owner 原语对所有已接受 P2 renew/release/verification 调用方默认使用 `resume`，保留其 API 和拒绝优先级。P3A 调用方显式只请求 `send` 或 `read`；resume token 和 takeover token 都不能授权这些操作。在调用方拥有的 IMMEDIATE 事务内，先做 capability 分类，再检查 Participant/Session；随后持久 ownership 行确定当前 Owner，所呈现 fencing token 必须等于持久单调 token/high-water 状态，持久租约期限必须活跃且无时钟回退。

P3A 仅在取得写锁后采样授权时间。send 与 release 竞争时，要么在 release 前串行化并可能提交，要么在其后拒绝 `OWNERSHIP_NOT_CURRENT`。临近过期的 send 与 takeover 竞争同样只能在替换前提交，否则之后作为旧 Owner 被拒绝；不能使用陈旧 fencing 提交。独立进程测试固定这两类结果。

本修订不扩大 takeover 恢复范围，不定义现有持久绑定以外的 Pi Session 生命周期，也不因 Session ID、Participant ID、Worker/Advisor 标签、endpoint 标签或单独 fencing token 而授予权限。ACK 和外部投递仍是该 P3 阶段的后续工作。
