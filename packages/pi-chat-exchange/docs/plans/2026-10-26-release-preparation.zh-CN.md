[English](./2026-10-26-release-preparation.md) | [简体中文](./2026-10-26-release-preparation.zh-CN.md)

> 历史计划（2026-10-26）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ce-020-release-preparation-implementation-plan"></a>

# CE 0.2.0 发布准备实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 准备最小安全生命周期文档及 npm0.2.0 分发；在不发布、不使用生产资源的前提下，证明真实 native managed-npm install/remove/reinstall 和离线合成 first-run。

**架构：** 现有 CE stop/status/deactivate 与 Pi native remove 保持不同 ownership 和软件包职责。不增加 runtime authority、daemon、delete hook、operator recovery 或隐式全局 Session discovery。Opt-in 隔离验证 harness 通过 loopback test registry 提供精确候选，调用真实 Pi1.3.0 npm installation，使用自有 fixture；若任何范围内 identity/exit/release/dependency 前提未知则 fail-closed。Package0.2.0 只是可发布候选 CANDIDATE；缺少 license approval 仍为 blocker。

**技术栈：** 精确批准的复制 Node24.21.0 / Pi1.3.0 / 固定 pnpm12.9.1；TypeScript/Vitest 及现有 Python cooperative-owned guardian；npm registry metadata 仅用于候选，不 publish。

<a id="approval-and-safety"></a>

## 批准和安全

用户批准先写文档的 safeuninstall、真实 lifecycle regression，以及 local testregistry 中 exact0.2.0 managedPi 路线，不用 publicnpm。用户选择提供现有 license authority，但尚未提供路径/license/rightsowner。不得创建/选择 LICENSE、licenseSPDX 或伪造 copyright。记录 PENDING，允许其他材料继续准备；不声称最终 public ready。Root/package 历史没有 LICENSE；README 只倾向 Apache，仍待 audit。Thirdparty audit 单独只读执行。

Basef6fbfbaf87bf317826a250d945d4a562c6c85c92。新 managed worktree branch fix/ce-release-preparation 从 exact base 创建，不用 main。原 main a611d31a 是 ancestor，17 commits/44 files；main 未跟踪 AGENTS/.herdr-web-ui 不动。不 merge/push/PR/tag/release/npm publish，不使用真实 Tunnel/MCP/Session/Store/business/ACK/credential/keychain/globalPi。只用 synthetic Store/Session/自有 process。允许为 frozen author/deps 获取 registry；禁止 cloud runtime。现有获批 exact ps 例外只针对 pinned hash/uid/mode/codesign，不允许 blanket nosandbox 或依靠持久 PID 发信号。历史 anchor record 不是当前存活证明。Runtime 为精确 Node24.21 加 SQLite qualification。

<a id="task-1--inspect-and-document-existing-native-remove-and-release-safety"></a>

## 任务 1：检查并记录现有 native remove 和 release 安全

阅读已安装 Pi1.3 的 package-manager.js remove/removeAndPersist/uninstallNpm 行为，以及完整相关 packages/CLI 文档。先读现有 CE stop/status/deactivate/Manager proof 和失败语义源码。文档修改前编写真正失败的回归，覆盖不安全的文档步骤，区分字符串契约与真实 runtime 证据。

允许文档：packages/pi-chat-exchange/docs/independent-install.md、tunnel-setup.md、README.md、pi-extension/README.md；必要时最小新 releaseguide，避免重复 semantic contract。安全步骤：精确盘点 installation/source/resource；只停止已确认由 Manager 所有的实例；独立验证 STOPPED；通过现有 deactivate 正常释放受影响 binding；确认所有目标资源使用者停止使用，不做机器全部 Session 批量停止；若 unknown/other install/shared resource 无法证明，则 STOP，不删除目录。退出相关 Host，再 native Pi remove exact source。保留 profile/credential/Store/history。缺 ACK 不是重试许可；不自动 Recovery/deletion/takeover。Native package-manager 已负责物理 npm removal，不能再增加第二套 npm delete/uninstall 权限。文档不无条件声称技术上能证明全局不存在使用者。Rollback 检查 Store compatibility，保留 version artifact/lock，绝不 downgrade/delete Store。

<a id="task-2--package020-metadata-and-materials"></a>

## 任务 2：package0.2.0 元数据和材料

> **修正（取代下文 `removeprivate` 指令）。** 先前删除该 package `private` 的决定已撤回。评审发现，在 license 和 rights-owner authority 仍缺失时，这会移除 npm 自身的机械发布拒绝。用户实际提供现有 license authority 前，保留 `private: true`。Version 0.2.0、`repository` 和 public `publishConfig` 作为明确未启用的候选元数据保留。Package 为 private 时，`npm pack` 及自有 loopback managed-install 路线都可工作，因此准备候选元数据无需解除拒绝。不加 prepublish hook，不改 root Changesets 文件；`privatePackages.version: false` 使排队中的 ACK entry 保持不活跃。License pending 时，manifest predicate 断言 `private === true`。

先对当前 version/material 不匹配运行 RED。package.json version0.2.0；按用户批准的 npm candidate，仅该 package removeprivate 或 false（已撤回，见上方修正）；适当时 public publishConfig registry/access、准确 description、有依据的 repository metadata；若 Pi manifest 即入口则无需 export，避免无必要 package API。不加 install/prepare/prepack consumer hook；build 仍在作者侧。直接声明的 pin 不变。只有 frozen lock 机械要求时，才更新 CE importer lock 的 version 相关元数据；不升级依赖。实际提供 authority 并验证前，license approval 保持 PENDING。不得捏造 LICENSE。

增加 CHANGELOG.md 和 docs/releases/0.2.0.md，release note 标为 DRAFT/UNRELEASED；首发只认证 Pi1.3+Node24.21+macarm64，24.22 runtime 为历史结果、不是候选认证，Linux 为 experimental/unverified，cloud NOTVERIFIED。加入 managed npm command 的精确 pin/Node/npm 选择、upgrade/remove/reinstall 和 asset/hash producer record；GitHub asset fallback 不是 URL direct Pi/Git monorepo 路线。不笼统声称 public version 已存在。按需加入 files whitelist 材料条目及 validator/docs closure 测试。内部 license audit/evidence 不进 tarball，除非明确需要 thirdparty NOTICES。适当更新写死0.1.1 的 consumer artifact 示例及 version-derived 回归。正式 producer package:pi-extension 输出经过验证的预构建候选，消费者不 build。GREEN 后提交逻辑候选材料及测试。

<a id="task-3--native-managed-npm-real-lifecycle-opt-in-regression"></a>

## 任务 3：native managed-npm 真实生命周期 opt-in 回归

优先小范围扩展现有 test/package/installed-host.test.ts 和 installed-host.py/guardian 支持设施；只有确能改善隔离时才加独立 mode 文件，不复制整个 harness。全部新 process 自有、有界 timeout、显式 opt-in；不新增用来隐藏 default 的 skip。Test registry 仅通过 loopback 提供真实0.2.0候选 metadata、SRI/archive bytes。不做 npm publish，即使 local 也不做。只在 install 阶段允许精确 registry dependency download；runtime 无网络。Managed install 必须真实执行 Pi install npm:@zieglar/pi-chat-exchange@0.2.0，不以 pi-e 或 local directory 替代。配置 private npm registry/env 及批准 npm executable，不改 global config；审计 Pi --legacy-peer-deps 差异。控制 versioncheck/telemetry/provider env。真实 Pi 存储精确 native package source；dependency 位于物理 managed tree，扫描 CJS/fileURL/全部 realpath，排除 source/workspace link/hardlink。候选0.2制品必须完整，不通过补拷缺失文件修复。

真实 version/install/list、Host loading 和 first setup 使用合成 doctor/config/save/convert/new/register/reloadactivate/deactivate；当前 selected pair 必须经过真实生产 parser；完整 mutex proof 前不得提前 PASS；使用复制批准 Node 及 sandbox 自有 ps guard。随后显式关闭自有资源，native Pi remove exact source；验证 unregister 和 managed physical package removal，其他独立 fixture source/session 不受影响，profile/Store/credential/history 保留。从 test registry 重新安装相同 exact0.2.0；真实 Host load/first configuration 或 retained config rehydration 必须明确声明，验证不静默 autotakeover。复用有效 binding 若 fail-closed，则如实报告，不伪造 identity。

Safeuninstall 的真实 Tunnel lifecycle 只使用测试设施已允许的 synthetic trusted fixture client，不用已安装 client，也不启动付费/真实 Tunnel。证明自有 stop/normal release，以及 external owner/other Session/shared resource/UNKNOWN 负例没有破坏性动作；不为测试另建生产 uninstall script。现有测试可能已证明 manager owner refusal；运行相关定向测试及真实 workflow 证据。区分真实 Pi runtime/managed package install 与 synthetic client/registry，不声称 public npm/cloud 成功。

若 managed Pi 机制不兼容，保留失败并报告最小诊断；不得 fallback 到 local dir 却标为 managed PASS。只用新 configuration fixture resource，绝不用当前用户真实 profile。只复制自有 private TMP 的 Store 并清理。日志不含原始 secret；synthetic key 明确标注。

<a id="task-4--fixed-candidate-verification-and-local-commit"></a>

## 任务 4：固定候选验证及本地提交

使用全新私有 git archive base，加精确授权 working file；通过复制 Node 物理安装 frozen dependency，禁用 script。保留首次失败；真实 RED 与 fixture/env error 分开。Build/check/typecheck；定向 lifecycle/docs/package/defaultguard；带 CE_DEFAULT_CLIENT_GUARD=1 和现有4项排除的完整相关默认测试串行运行；新 heavy file 不能默认执行或静默新增 skip，须一致更新 explicit guard/config pin/isolation constant/test；插件测试实际7次，允许 warm cache；正式 pack inventory/hash；managed 新 tar 真实 Host smoke + first config/uninstall/reinstall；现有 tar physical route 继续保持 PASS。记录精确 command/exit/version/source identity、deps lock/SRI/artifact tree/module origin、pinned ps、当前自有 cleanup 和 retention limit。不发布。只提交本地授权范围，冻结干净 HEAD 后停止写入。父会话独立验证固定候选和四 lane 后，才能提出最终建议。

<a id="task-5--parent-final-review--result"></a>

## 任务 5：父会话最终评审及 RESULT

Writer 完成、父会话检查真实 diff 后，固定目标（basef6fb..candidate），确认前后干净，启动4条独立源码 lane：A diff/privacy/docs/materials；B frozen authority/process ownership/permission/shared resource；C native-npm proof/uninstall negative/durable+lastPASS/coverage；D minimal convention/no second Authority。独立 verifier 从精确 commit 的新 archive 执行必需 gate；不得将旧 artifact PASS 标成新结果。将只读 lane 的 license audit 证据与用户 authority 对照；若缺 LICENSE，报告 publication blocker，不捏造。RESULT 包含 changed file/commit、safeuninstall 的真实/fixture 限制、managed npm actual、0.2 material status（必要时 license PENDING）、test/review evidence、剩余 cloud E2E/license。只有确认硬性条件关闭才建议 MergeGate；ReleaseGate 需单独 cloud/license approval 后才就绪。不 merge/publish。
