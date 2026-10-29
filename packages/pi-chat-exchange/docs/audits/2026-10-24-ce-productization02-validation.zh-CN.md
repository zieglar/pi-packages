[English](2026-10-24-ce-productization02-validation.md) | [简体中文](2026-10-24-ce-productization02-validation.zh-CN.md)

> 历史本地验证记录。以下命令、结果和限制描述当时的阶段，不代表当前支持或发布资格。

# CE Productization 02：本地验证证据

## 范围

原始基线：`1578a7bb6d672819ff9b3fe1479d26f008cb5e60`。
已批准设计/计划：`docs/plans/2026-10-24-ce-productization02.md`。
运行时/测试提交：`8acc89eacdd9b705da702668361ae641c7a48968`。

本证据涉及当前 session 停用、只读安装诊断、准入身份状态和用户文档的隔离实现，不是发布或真实客户端验收记录。没有 push、PR、merge、真实 Tunnel 重启/重配置、真实消息 read/send/ACK 或真实 Store 清理。

## 父会话执行

环境：macOS arm64、Node 24.21.0、pnpm 12.9.1。独立工作树、离线 frozen-lockfile 依赖安装；未重建或编辑原 checkout 的已安装源码。父会话验证移除了继承的 `CE_*` 环境项。新命令测试框架使用临时合成配置/Store 和注入的进程 seam。

从包目录执行：

| 命令 | 结果 | 本地日志 |
|---|---|---|
| `pnpm run check` | PASS，架构门禁和负向夹具 | `/tmp/ceprod02-parent-check.log` |
| `pnpm run typecheck` | PASS | `/tmp/ceprod02-parent-typecheck.log` |
| `pnpm run build` | PASS | `/tmp/ceprod02-parent-build.log` |
| `pnpm exec vitest run test/endpoints/pi/extension-messaging-activation.test.ts test/endpoints/pi/extension-multi-session.test.ts test/endpoints/pi/extension-lifecycle.test.ts test/runtime/executables.test.ts test/runtime/diagnostics.test.ts test/runtime/installation-diagnostic.test.ts test/tunnel/extension-doctor.test.ts test/tunnel/extension-runtime-diagnostic.test.ts --maxWorkers=1` | 8 个文件、137 项测试 PASS | `/tmp/ceprod02-parent-targeted.log` |
| `CE_PLUGIN_PACKAGE_TEST=1 pnpm exec vitest run test/plugin/local-plugin-package.test.ts --maxWorkers=1` | 1 个文件、7 项测试 PASS，含制品构建和合成 stdio/工具发现 | `/tmp/ceprod02-parent-plugin.log` |

七份用户 Markdown：检查了 47 个相对链接/锚点；11 个 shell block 经 `bash -n` 解析，未执行。七份文件无开发者机器私有路径、Handoff ID 或看似强制的 `mise exec`。当前 UI/CLI 步骤参考了官方 OpenAI Tunnel、custom-MCP 和 plugin-packaging 文档；外部 UI 可用性仍需按客户端/工作区资格确认。

主动 LSP 探测覆盖三个生产 TypeScript 文件，未报告 TypeScript 错误，但服务器为 push-only/silent-on-clean，两个结果不确定，不能宣称完整干净 LSP 覆盖。辅助 AST 发现包括已有风格警告和确认点新增的受保护 non-null assertion；已确认的类型证据是编译器 typecheck。

## 实现者报告的 TDD 证据

初始 RED：停用 7 项失败；multi-session/status 3 项失败；diagnostic helper 11 项失败；doctor command 3 项失败。修正后的隔离 command-dispatch-disable 检查：12 失败/51 通过，日志 `/tmp/ceprod02-api-isolated-command-red.log`。修正后的最终子会话：8 个文件、137 项 PASS，日志 `/tmp/ceprod02-api-final-{build,green,typecheck,check}.log`。父会话独立重跑了上述最终 137 项。

## 隔离事件及修正

较早基线/activation 运行使用的现有框架只向 fixture manager 注入进程 seam，未注入扩展单独创建的 manager。这些运行可能调用只读宿主进程列表。没有观察或报告宿主变更，但较早运行不能作为零探测隔离证据。

修正后的 activation 和 multi-session 框架向全部 manager 注入合成 list/inspect seam，断言没有默认 inspection、spawn 或 signalling 调用。doctor 框架断言没有 Manager/Store 创建或 append。最终父会话命令测试使用这些修正；此前受影响的隔离声明被取代，未删除。

## policy-source fencing 和持久历史的后续验证

运行时/测试后续提交：`7ed30efeb9035713db0dd4a94e7ccece41d5d890`（基于 `34bf64ba4519d3b9a552bf426e54400faacc1424`）。本节补充较早运行，不替代它们。

- fallback-source RED 复现两个独立失败：无 profile 的 standalone binding 未终止，确认期间漏掉 fallback allowlist drift（2 失败/35 通过，`/tmp/ceprod02-r1-b1-red.log`）。修正 fingerprint 遵循 explicit → validated generated → fallback 优先级，不要求 Tunnel profile，也包含实际 fallback 文件。正向/drift 测试覆盖 absent/nonmessaging profile 和 explicit policy；所选 generation 畸形时仍拒绝。
- legacy 和 multi-session 停用测试现在经现有 Host API 写入非空合成 Message 和 reception Receipt 历史。首次和重复停用后比较精确持久行、UTF-8 payload byte/hex 和标识符；另一个 Pi Owner row 不变。
- 临时 test-only 破坏性 mutant 只在可丢弃合成数据库中禁用外键并移除 receipt-delete guard，再删除 message/receipt 行。正常和 revoked 清理两种情况均因新增历史相等断言失败（2 失败/27 跳过，`/tmp/ceprod02-r1-c1-history-deletion-mutant.log`），不是 trigger/fixture 失败。GREEN 和提交前已删除 mutant 代码。生产 storage schema/guard 不变。这证明 preservation oracle 能检测历史丢失，不证明生产存在删除缺陷。

后续修正后，父会话独立重跑上述同一命令矩阵：check/typecheck/build 均退出 0；八个目标文件、143 项 PASS；打包插件文件、7 项 PASS。日志 `/tmp/ceprod02-parent-r2-{check,typecheck,build,targeted,plugin}.log` 含实际退出码。子会话最终 143 项日志为 `/tmp/ceprod02-r1-final-{build,green,typecheck,check}.log`。未使用真实 client/runtime/Store；下述完整套件和人工/真实运行限制不变。

## 明确限制

- 完整套件 NOT RUN：现有 real-client compatibility 测试会执行已安装客户端；在保护真实运行时约束下，不能假定更广且未经评审的进程框架安全。
- 没有真实客户端 doctor/network 检查、真实 Tunnel/ChatGPT 验收重跑、生产 B/C 生命周期操作、人工交互 TUI 验证或机器冷启动测试。
- 没有新增 Node、SQLite、OS 或客户端版本认证；host/child 各自通过现有门禁确认资格。
- doctor 诊断候选安装资格，不证明已保存 profile command、运行中 child identity、兼容性、network readiness 或消息完成。
- 固定版本四路评审和父会话综合结论与测试结果分开；测试通过本身不批准 delta。
