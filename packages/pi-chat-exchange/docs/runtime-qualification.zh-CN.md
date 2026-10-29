[English](runtime-qualification.md) | [简体中文](runtime-qualification.zh-CN.md)

# 运行时解耦：当前开发策略

Handoff：`HANDOFF-PI-SQLITE-RUNTIME-DECOUPLE-01`。下方 COMPAT-02 和原始精确运行时资格章节均为历史记录。已发布 npm 0.2.0 不变。

当前候选策略取消将 SQLite 精确等于 3.53.4 及 source-ID 相等作为准入要求。运行时身份仍为可观察证据，不能替代行为检查。Node 候选限于规范稳定版 24（>=24.12.0）、25、26，仍须满足全部安全门禁并实际取得资格。未来 major 不自动支持。

必要 SQLite 安全下限仍为 **3.51.3 或更新**。SQLite [WAL-reset bug](https://sqlite.org/wal.html#walresetbug) 可在独立进程/线程的多连接并发写入或 checkpoint 时损坏 WAL 数据库。CE 使用 WAL 和多进程，因此实际 Node 24.12.0、25.2.1 中有缺陷的 SQLite 3.50.4 即使通过内存/API 探针也被拒绝。较早修复回移版保守排除在策略之外。问题已获上游确认；本工作不声称本地复现损坏。

另一个**本地已复现的原生崩溃**阻止 Node 24.19.0（SQLite 3.53.3）及 25.9.0（SQLite 3.51.3）。既有 `transaction-security.test.ts` 的 `unreadable transaction state cannot escape outcome classification` 用例在自有事务内关闭特权连接。使用生产事务 helper 的独立进程在这两个二进制上以 SIGSEGV 退出；24.20.0、24.21.0、26.12.1 则返回所要求的 `STORAGE_TRANSACTION_FAILED / INDETERMINATE`。这是进程崩溃发现，不是磁盘损坏证据。精确排除保留实测安全边界；通过 SQLite 下限和普通探针不能覆盖它。

平台及编译安全要求不变。Host/子进程共享的低成本内存探针须证明所需 SQL/API 行为；文件锁、WAL/FULL 策略、schema v7、信任根、提交不确定性及崩溃对账须另做有界真实运行时测试。启动探针通过不构成完整兼容证明。

包声明有意限于 **`>=24.20.0 <=24.22.1`**。列出并测试的四版（24.20.0、24.21.0、24.22.0、24.22.1）均为真实 Darwin arm64 二进制；调查时官方 Node 发布清单在此区间未列其他已发布补丁。这不代表后续补丁已取得资格。Node 26.12.1 为另行测试的预览，不在正式 engines 内；Node 25 无受支持声明。未来版本、Linux、掉电持久性仍未验证。

| 实际 Node | SQLite | 结论 |
| --- | --- | --- |
| 24.12.0 | 3.50.4 | 拒绝：上游 WAL-reset 缺陷 |
| 24.19.0 | 3.53.3 | 拒绝：本地复现事务关闭原生 SIGSEGV |
| 24.20.0 / 24.21.0 / 24.22.0 / 24.22.1 | 3.53.4 | 有界开发支持；针对性 storage/runtime、协议及真实 Pi 1.3.0 Host 证据 |
| 25.0.0 | API 负向控制 | 拒绝：缺 defensive API |
| 25.2.1 | 3.50.4 | 拒绝：上游 WAL-reset 缺陷 |
| 25.9.0 | 3.51.3 | 拒绝：本地复现事务关闭原生 SIGSEGV |
| 26.12.1 | 3.54.0 | 预览：实际不同 SQLite 引擎、针对性/较广存储、协议、真实 Host 证据；不声称 LTS 支持 |

最终五运行时矩阵（24.20.0、24.21.0、24.22.0、24.22.1、26.12.1）验证全部 25 个有向配对：正常重开/内容保留、提交前锁竞争/SIGKILL 回滚、提交后响应丢失对账（75 项测试）。实际 MCP 协议运行覆盖全部 25 个父/子组合及组合的独立 Pi factory 进程。每个运行时针对性套件通过 337 项、零跳过。较广 Node 26 storage/runtime 套件通过 1043 项、零跳过。早期广泛运行因废弃 test loader 警告失败，已用同步 `registerHooks` 修正；磁盘故障/崩溃注入限定于文件连接，使新内存 COMMIT 探针不消耗预定故障边界。首次失败是证据，不是兼容通过。

证据：`<private-evidence-root>/sqlite-runtime-decouple-01/` 保留获取/身份清单、原始拒绝和 RED 证据、逐运行时门禁、已知 WAL 缺陷证据及固定目标独立审查。新官方归档已与 HTTPS SHASUMS 比较；未验证分离签名。

## 历史 COMPAT-02 策略

# 运行时能力准入：开发候选

Handoff：`HANDOFF-PI-NODE-SQLITE-COMPAT-02`。本节仅针对当时本地开发候选，取代历史精确 Node 准入策略。已发布 npm 0.2.0 不变。

Node 候选门禁为 `>=24.21.0 <25`，排除预发布、自定义后缀及非规范版本。通过为必要但不充分条件：SQLite 仍须精确为 3.53.4，source ID 为 `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`，并满足支持平台/架构及既有必需/禁止编译选项。未授权扩展 SQLite 身份。

包声明有意更窄：`>=24.21.0 <=24.22.1`。实测二进制为 Darwin arm64 的 24.21.0、24.22.0、24.22.1。不认证未来 Node 24 或 Linux。声明之外候选须先取得资格并有独立回归证据，才能扩展声明。

Host 和 MCP 子进程执行同一自包含、已编译内存探针。验证 defensive mode、statement get/all/run、事务状态、事务及预准备 savepoint authorizer 拒绝、authorizer 重置，以及无保留行的回滚。失败在准备持久化 Store 路径前拒绝；无环境版本覆盖或 fallback 放宽门禁。子进程可执行文件所有权/路径/ACL 准入不变。

当前 v7 schema 验证、旧 schema 拒绝、持久化、锁、SIGKILL、不确定结果对账仍为独立磁盘回归。不改 schema、账本、恢复协议、消息格式。进程 kill 不证明掉电持久性。真实 Host 测试使用 Pi 1.3.0 和合成隔离配置/Store，不执行真实 Tunnel 客户端。

证据在两个仓库外的 `<private-evidence-root>/node-sqlite-compat-02/`：运行时获取/身份、RED/GREEN 日志、最终针对性命令封套、已安装 Host 证据及固定目标独立审查。新 24.22.0 官方归档已对比 HTTPS SHASUMS；未验证分离签名。

以下为 `HANDOFF-CE-RUNTIME-QUALIFICATION-01` 的历史证据；精确白名单措辞及旧计数不描述上述候选。

# 精确运行时资格证据

任务：`HANDOFF-CE-RUNTIME-QUALIFICATION-01`。记录已观察资格证据，不构成宽泛 Node 24 支持声明。最终验收还需固定目标四路审查及操作员接受。

## 真实身份

| 字段 | 运行时 A | 运行时 B |
| --- | --- | --- |
| Node | v24.21.0 | v24.22.1 |
| 平台/架构 | darwin / arm64 | darwin / arm64 |
| SQLite | 3.53.4 | 3.53.4 |
| SQLite source ID | `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc` | 相同 |
| 编译选项清单 | 50 项 | 相同 50 项 |
| 必需选项 | `THREADSAFE=1`、`MUTEX_PTHREADS` | 相同 |
| 行为 API 探针 | defensive mode、statement get/all/run、事务状态 | 相同 |

A 为既有本地精确版本安装。B 为私下下载的官方 `node-v24.22.1-darwin-arm64.tar.gz`，SHA-256 `89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7`，已对比官方 HTTPS SHASUMS。**未**验证分离签名。完整清单、绝对可执行路径、获取来源及命令/退出封套位于本地证据包 `<runtime-qualification-evidence-bundle>`（`formal-identities.json`、`initial-identities.json`、`acquisition.json`）。未改变全局运行时配置。

## 已观察兼容矩阵

全部 Store、端点、消息均为合成临时夹具。未使用真实 Tunnel/客户端或操作员 Store。

| 谓词 | A | B |
| --- | --- | --- |
| 创建、关闭、重开、完整性/外键检查 | PASS | PASS |
| WAL / FULL / foreign-key / trusted-schema 策略 | PASS | PASS |
| 事务、锁、并发写入、回滚、不确定结果对账 | PASS | PASS |
| 进程 kill 恢复及新句柄重放 | PASS | PASS |
| Store 身份、schema、账本、信任根稳定性 | PASS | PASS |
| Endpoint / Session / Ownership / 能力拒绝 | PASS | PASS |
| Inbox / 载荷读取 / ACK 授权 | PASS | PASS |
| 实际 stdio 初始化、工具发现、ping | PASS | PASS |
| 生成 portable manifest、无 mise、最小 PATH、带空格可执行路径 | PASS | PASS |
| Resolver 路径/所有权/ACL 拒绝、host/child 独立资格 | PASS | PASS |
| 契约、项目 typecheck、build、严格扩展编译 | PASS | PASS |
| 有界完整套件 | 2561 pass, 5 skip | 2559 pass, 7 skip |
| 门控 packaged-plugin 套件 | 7 pass | 7 pass |

`runtime-cross-version.test.ts` 覆盖 A→A、A→B、B→A、B→B 全配对（12 项）：已提交消息/审计/幂等身份、稳定 Store 元数据/账本/信任根、正常重开、提交前锁竞争及 SIGKILL 回滚、提交后响应前 SIGKILL 和新句柄幂等对账。两次完整运行均通过。这些是进程崩溃测试，**不证明掉电持久性**。

实际多 Session stdio 测试在各父进程下运行 A、B 子进程，覆盖全部四种 Host→MCP 组合。涵盖双向消息、inbox、载荷、ACK、错误端点拒绝、当前/已加载 grant 交集、移除全局 opt-in、无效策略拒绝、所有权/Session 清理。独立打包的 generated-manifest 启动另行证明各选定 portable 可执行文件。

实际 Node v25.2.1（含伪造环境版本值）在创建 Store 路径前拒绝。单元测试覆盖未获批补丁/版本、SQLite source/version/platform 不匹配、编译/API 证据缺失或畸形、禁用安全性的编译选项。生产中无绕过环境守卫的方法。

## 复现及保留证据

在包目录用**所选 Node 绝对路径**执行各命令，仅将其 bin 目录前置到命令本地 PATH。`CE_TEST_NODE_A`、`CE_TEST_NODE_B`、`CE_TEST_UNAPPROVED_NODE` 仅为测试选择真实二进制，不改变生产准入。

```sh
"$NODE" scripts/check-contract.mjs
"$NODE" node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
"$NODE" node_modules/typescript/bin/tsc -p tsconfig.build.json
CE_TEST_NODE_A="$A" CE_TEST_NODE_B="$B" CE_TEST_UNAPPROVED_NODE="$U" \
  "$NODE" node_modules/vitest/vitest.mjs run \
  --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
CE_PLUGIN_PACKAGE_TEST=1 "$NODE" node_modules/vitest/vitest.mjs run \
  test/plugin/local-plugin-package.test.ts --maxWorkers 2
"$NODE" node_modules/typescript/bin/tsc --noEmit --target ES2023 \
  --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
```

最终候选字节上的十二项最终门禁退出均为 0；本地包中日志及精确参数/环境封套为 `formal3-{contract,typecheck,build,full,plugin,extension}-{24.21.0,24.22.1}.{log,json}`。早期 `formal-*` 记录审查前同套件通过，`formal2-*` 保留下述编辑事故。混合 Host/MCP 日志为 `formal-host-mcp-*.{log,json}`。生产探针清单为 `formal-identities.json`。审查目标聚合指纹为去掉 `review-r1/target.json` 自身 `fingerprint` 字段后，规范排序键 JSON 的 SHA-256（Python `json.dumps(..., sort_keys=True)` UTF-8 字节）。

保留首次失败，不用成功运行覆盖：

- 初始 registry/admission RED：24 failed / 10 passed；migration/recovery RED：2 failed / 3 passed / 4 个环境跳过。暴露严格证据检查缺失、B 拒绝、过早创建路径。
- 初始 API 故障夹具：每运行时 2 failed / 68 passed。修正有缺陷的 defensive-mode、transaction-state mock，使其实际诱发目标异常；未放宽 SQLite defensive 默认。
- Resolver/diagnostic RED：9 failed / 28 passed；随后补探针证据并更新单版本预期。
- 首次 A full：2546 passed / 5 skipped。首次 B full：4 failed / 2542 passed / 5 skipped，含三个仅调试版本假设和一个生产组合测试硬编码 A 断言。生产断言改查精确获批集合及实际 child 身份。独立打包 debug 派生仍仅 A；B 显式测版本拒绝并跳过两项仅成功测试，不默默为派生版授予资格。
- 新增 `OMIT_CHECK` RED：1 failed / 28 passed；加入安全排除后 29 passed。
- 审查修复（四路 R1，Lane C 内容证据阻塞）：跨版本断言现于每阶段（含两条 SIGKILL）后比较原 baseline Message 完整行、完整 audit 行、幂等记录、生产载荷字节（对比已知合成 sha256）、baseline 幂等重放；每个哈希字段均有扰动负向控制。首次 RED 12/12 failed，因为 worker 无持久化行证据；worker 修改后各父运行时 12/12 passed（`task4-content-red/green-*`）。
- 编辑事故（门禁捕获，保留在 `formal2-*`）：添加 parity 注释时误删 `REQUIRED_SQLITE_CAPABILITIES` 声明行；两运行时 typecheck/build 退出 2，依赖的 full/plugin 在恢复该行前失败。`formal3-*` 随后十二项通过。无行为变化，未抹除失败。
- 最终主动诊断报告 migration/recovery 中两项继承的辅助规则发现，已确认 baseline HEAD 存在；四次探针无法确认干净。不声称全面 LSP-clean。两项实际 TypeScript 编译器门禁均通过。

完整套件五项跳过为四个门控 plugin-package 用例（另行七项门控运行执行）和一个需 root/chown 的错误文件所有者用例。B 额外两项为已说明的 A-only debug 成功用例。全程排除 `test/tunnel/real-client-compat.test.ts`：它会执行已安装真实客户端，本 handoff 禁止。不计为已测试。

首次 full 到 formal 的计数增长来自扩充：+12 `runtime-cross-version`、+2 `OMIT_CHECK` 拒绝、单 child 多 Session stdio 改为双 child `it.each` 加 1（2551 → 2566 总计）。

## 限制

本次仅新增 Darwin arm64 实测。既有 Linux x64 平台策略不变；本工作**无新增真实 Linux 二进制资格证据**。其他平台及 Node 版本继续拒绝。精确运行时资格不保证超出所记录获取检查的二进制来源真实性，也不要求 host/child 共用可执行文件。冻结 Store schema、迁移账本、信任根、路由、能力、ACK 契约不变。验收不授权 push、release、部署、全局配置或真实客户端运行。
