[English](./2026-10-25-distribution-fix.md) | [简体中文](./2026-10-25-distribution-fix.zh-CN.md)

> 历史计划（2026-10-25）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="independent-pi-tarball-distribution-implementation-plan"></a>

# 独立 Pi Tarball 分发实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 交付可独立安装的私有 CE Pi extension tarball，不是 Desktop MCP ZIP 或开发目录引用。
**架构：** 用户批准作者侧 build + validation + 显式 native pack 和 files whitelist。消费者不构建、不执行 lifecycle hook；不改冻结 runtime/authority。保留 workspace 作者构建；消费者获得 runtime closure，不依赖父 tsconfig。
**技术栈：** Node24.21.0、pnpm12.9.1、TypeScript5.9.3、npm native pack/install、Pi1.3.0。

<a id="approved-design--constraints"></a>

## 已批准设计与约束

起点 affc05d024d0bef4254eaf14de7d521815c720ea。只使用 fix/ce-distribution-fix worktree。不改 main，不 merge/push/PR/tag/release。只分发私有本地制品。不使用真实 Tunnel/client/credential/Store/Session/business/ACK。所有真实 Host 操作使用合成私有 fixture。不升级无关依赖，不重构构建系统。保留首次失败。

<a id="task-1-characterization-and-minimal-package-repair"></a>

## 任务 1：刻画问题及最小软件包修复

文件：packages/pi-chat-exchange/package.json；新 scripts/package-pi-extension.mjs 或同等限定名称；新 test/package/distribution.test.ts；适当的 docs/audits 证据。

1. 阅读基线安装报告 /private/tmp/ce-install-amendment/execution/report.md，以及当前 manifest/ignore/extension import/native path/build script。改变依赖声明前检查 Pi Host peer/runtime 模块用法。
2. 编写真实 native-pack 回归，断言包含 Pi entry/local TS module、编译后的传递 runtime 路径（含 dist/bin/mcp-stdio.js）、native/tunnel-keychain.swift 和有文档的 operator script。断言不含 secret/store/build fixture/node_modules/devtest。保留原 manifest 的真实 RED：先 build 再 pack 仍缺 dist。
3. 最小 files whitelist、显式作者 build-and-pack 命令、静态/native payload 验证及可预测输出。不加消费者 pre/postinstall 或 prepare build。不分发损坏的消费者 build config；解释作者 workspace 要求。绝不盲目遍历符号链接源码/私有状态，不运行 shell 注入字符串。
4. 测试缺失/不完整 dist 检测、真实 pack 内容及失败行为。不能只靠字符串或 native pack mock 做弱测试。
5. 重跑定向测试到 GREEN。Build/check/typecheck。记录证据后只提交授权实现。

<a id="task-2-independent-packagehost-regression-and-docs"></a>

## 任务 2：独立 package/Host 回归及文档

文件：小范围新增 package/host distribution regression 测试和支持；仅必要时改 package.json test lane；README.md、docs/tunnel-setup.md、pi-extension/README.md、independent-install guide。

1. 增加 opt-in 的重型真实 tarball install + 真实 Pi1.3.0 Host 回归，显式说明前提，启用后前提不满足必须报错，不新增静默 skip。不允许 source-tree -e fallback。默认套件保持离线安全；适当时低成本测试 opt-in 行为。
2. 在新 consumer 中物理安装未修改制品，使用私有 cache/HOME/PI/XDG/TMP 和批准 Node。Native dependency bin 可在内部链接；不得有外部 symlink/hardlink/workspace source reference。独立安装 Host；可行时禁止运行时读取开发目录，并禁止运行时网络。启用 lifecycle script 前审计，优先 ignore-scripts，消费者不需要脚本。
3. 实际 PTY 通过正式 pi install/list 加载。执行 doctor/configuration/profile、native 合成 Session registration 和 deactivate；不启动 transport，不用 realclient/realStore。Doctor client-unavailable 是诊断证据，不是真实 client compatibility 成功。若前提阻塞真实首次运行，报告 BLOCKED，不模拟 PASS。跟踪自有 child，安全清理、有界等待；失败时保留制品。复用此前 harness 证据，不操作任意在线 PID/process。
4. 文档区分制品生产者（workspace frozen install/build/package）和消费者（可信 Node/Pi、native tarball dependency install、pi registration）。核对实际用过的精确命令；路径是用户本地路径，不要求开发者 mise。Desktop 保持独立。说明 version/hash、信任/权限/前提。评审 host-provided peer warning，但不为消除警告而破坏独立 compiled ESM resolution。
5. 提交测试/文档，报告完整 SHA、变更路径、命令、证据目录和真实 RED/GREEN。

<a id="task-3-fixed-artifact-verification-and-review-parent-coordinates"></a>

## 任务 3：固定制品验证和评审（父会话协调）

1. 冻结干净 commit，记录 baseline、完整 diff 和 artifact hash。
2. 独立 verifier 运行 build/check/typecheck、定向测试、带 --no-file-parallelism 的完整相关 CE 默认测试选择、plugin test、真实 pack、新物理 tarball install、真实 Pi1.3.0 load 和 first-run smoke。保持批准的隔离 fixture 及现有安全排除；不测 existing-client，不做业务操作。
3. 独立固定 delta 评审涵盖 package closure、install script、dependency、可复现性、permission/trust 和精确文档。Reviewer/verifier 读取时不得移动 commit。顺序修复已确认发现，再重新冻结/验证受影响范围。
4. 父会话检查 diff 和证据。结果必须区分 SOURCE_BUILD、PACKAGE_INSTALL、REAL_HOST_LOAD、FIRST_RUN 和 CLOUD_TRANSPORT_NOT_VERIFIED。只有 install/load/first-run 全部 PASS 才建议重新进入；否则明确 REWORK 和最小下一步。不隐含 integration/publication 授权。
