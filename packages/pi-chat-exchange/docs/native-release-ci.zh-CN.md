[English](native-release-ci.md) | [简体中文](native-release-ci.zh-CN.md)

# Native SQLite CI 与发布流程（仅仓库）

中间件 0.1.0 / ABI 1 使用已入库 Cargo.lock 和捆绑 SQLite 3.54.1。下述流程由工作流和发布 helper 定义；本地测试本身不能证明 Hosted CI、OIDC 签名或发布成功。

## 已验证发布边界

不可变发布 `ce-sqlite-v0.1.0`（ABI 1、SQLite 3.54.1）已从源码 `a8386aafd657c84825b2905847f34a43d5b91e1e` 发布。历史验证下载了资产并检查其 attestation。Hosted Native Store 集成覆盖 macOS arm64、Linux x64；macOS x64、Linux arm64 仅有产物及 conformance 证据。这些结果不证明广泛云兼容或端到端兼容。

`src/storage/native-compat.ts` 中生产哈希仍为 null。`src/storage/sqlite-driver-selection.ts` 默认 `node-sqlite`，Native 失败后绝不 fallback；`src/storage/native-artifact.ts` 拒绝未固定资产。发布不会默认启用 Native。

独立 npm 工作流仍为本地未推送工作，没有 hosted OIDC 证明。所有者报告 publisher 连接已配置，这不属于 hosted 发布结果。npm `@zieglar/pi-chat-exchange@0.2.0` 已独立于该 Native 发布而发布。

## 测试层及权限

四个产物目标均构建并运行 Native 加载、scalar/BLOB/error/lifecycle/authorizer/defensive conformance。仅 `aarch64-apple-darwin`、`x86_64-unknown-linux-gnu` 跑 schema-v7 Store cross-driver 测试。macOS x64、Linux arm64 仅为产物目标，不将其 Store 测试报告为兼容或已验收。生产 Store allowlist 不变。

构建 job 仅有 contents read。独立 `attest` job 仅在 `zieglar/pi-packages` main 手动 dispatch、全部构建成功后运行。拥有 contents read、attestations write、id-token write，无 release write。检查模块版本、ABI、target、source commit buildId、SQLite 版本，汇总 SHA256SUMS 和 manifest，再用固定的官方 `actions/attest` 为每个实际二进制及元数据/校验文件生成构建来源证明。签名 bundle 与精确同组文件保留。PR、pull_request_target、workflow_run 均不能进入这些特权 job。

Release 为独立 environment 门控 job，要求 `publish=true`、公共仓库和 main。拥有 contents write，无 OIDC 签名权限。仅下载同一 run 的 attested 集合，用 `gh attestation verify` 针对仓库、工作流、main ref、精确 source SHA 验证每个 subject bundle，并在写 tag/Release 前检查 SHA256SUMS。校验清单本身也是 attested subject，因此即使清单与替换资产内容相符，也不能接受清单替换。`--bundle` 使用该 run 自己的签名 bundle 离线验证，无需凭证。

## 发布所用凭证

两种凭证严格分用：

- **发布凭证**（`GH_TOKEN`，即带 `contents: write` 的工作流 `GITHUB_TOKEN`）执行全部版本相关读取和全部写入：tag/Release 存在性、environment/branch-policy 读取、tag 创建、draft 创建、发布。
- **管理凭证**（`CE_RELEASE_ADMIN_TOKEN`）仅做需要 repository administration read 的仓库控制读取：`GET /repos/{owner}/{repo}/immutable-releases` 及 tag ruleset 端点（`GET .../rulesets`、`GET .../rulesets/{id}`）。绝不写入，也不做版本相关读取。

`GET /repos/{owner}/{repo}/immutable-releases` 无凭证返回 401，`contents: write` token 返回 403，因此单凭 `contents: write` 工作流 token 无法检查前置条件。Tag ruleset 详情只在认证响应中暴露 bypass 保护字段，也用管理凭证读取。environment 对象及 deployment branch policies 是普通仓库读取，继续用发布凭证。

管理凭证由所有者配置为仅限此仓库的 fine-grained PAT，权限 **Administration: Read-only**（隐含 Metadata read）。作为 `native-sqlite-release` 的 **environment secret** 保存，仅声明该 environment 的 release job 可读，build/attest 不接收。缺秘密时在任何 API 调用前拒绝。管理凭证只读仓库管理，不能创建 tag、release、asset。

发布凭证绝不等同管理凭证：若值相同则拒绝，以免把只读前置读取静默变为提升权限的发布。

## 自动发布门禁（无人为审批点击）

`native-sqlite-release` environment **无 required reviewer**。无人工批准事件，也无独立双人发布审查。授权来自具写权限行为者在 `main` 显式 `workflow_dispatch`，加受保护 job 内的强制检查：

1. 操作员必须声明精确提交 SHA（`publish_sha`）。缺失、畸形或不等于 dispatch SHA 均拒绝，避免意外发布无关或更新 main head。
2. 不可变发布必须启用（实时读管理端点）。
3. 必须有有效 `ce-sqlite-v*` tag ruleset，阻止更新及删除，无 bypass actor 或调用方 bypass。
4. environment 必须 `can_admins_bypass=false`，仅允许 `main` 部署。
5. 该版本 tag、Release 均不存在；仅真实 HTTP 404 证明缺失。
6. 发布集必须恰为固定八文件清单；全部 SHA256SUMS 与磁盘字节一致；七个 attestation subject 均针对仓库、签名工作流、source ref、精确 SHA 验证成功。

任何检查失败均不创建 tag 或 Release。

## 版本不可变性

`scripts/native-release.mjs` 同时检查 tag/Release 端点。仅有效 HTTP404 视为缺失；权限、传输、解析失败均拒绝。已存在 tag 或 Release（含 draft）拒绝且不写入。helper 要求启用仓库不可变发布，原子创建指向精确 build SHA 的新 tag ref，使用 `--verify-tag` 建含全部已验证资产的 draft，再发布。绝不强制更新 tag、覆盖资产、删除失败 draft 或重试不确定操作。中断可能留下 tag/draft，须人工审查；重跑拒绝该版本。

工作流串行化只是补充，不是仓库保护机制。代码不能启用或证明 tag ruleset。管理员须配置并验证：

- 公共仓库不可变发布。发布 draft 须锁定 tag 及资产集；设置禁用或不可读则拒绝。
- 有效 `ce-sqlite-v*` ruleset，禁止更新/删除，creation/bypass 限于获批发布路径。确保目标 token 能建新 tag，不能移动 tag。
- main 和 `native-sqlite-release` environment 保护/审查，含 deployment branch 限制。记录的自动门禁无 required reviewer，保护配置应与此一致。仅命名 environment 不能建立这些设置。
- Artifact Attestations 所需 GitHub plan/可见性/权限。

历史发布前观察：2026-10-28 只读公共 API 报告不可变发布禁用（`enabled=false`、`enforced_by_owner=false`），无 ruleset。当时未改变管理员配置。该观察早于上方已验证发布，不描述当前设置；这些设置仍为未来发布的外部前置条件。

## 未来获授权发布的流程

1. 仅显式授权后 push，记录精确远端提交，再以 publish=false dispatch。检查四个 Hosted 构建、Native conformance、支持的 Store 子集，以及官方 attestation 身份/摘要。
2. 独立验证每个下载文件：`gh attestation verify FILE --repo zieglar/pi-packages --signer-workflow zieglar/pi-packages/.github/workflows/native-release.yml --source-ref refs/heads/main --source-digest COMMIT_SHA`。校验清单也须验证。本地 mocked-gh 测试仅证明拒绝/控制流，不证明签名真实性。
3. 单独获授权发布前确认仓库设置及版本缺失。发布精确 attested 集，验证不可变 Release 和 tag SHA，再以独立锚定 pins 在隔离 cache 测实际 GitHub 下载及离线加载。
4. 生产兼容哈希在另行审查信任 pin 更新前保持 null。与二进制同处下载的 Release 校验和或本地构建成功均不授权信任新字节。

本地有界检查：`node --test scripts/test/native-release.check.mjs scripts/test/native-release.auth.test.mjs`、`node scripts/check-native.mjs`、YAML/shell 静态验证。此仅 CI 变更无需完整存储矩阵或 Rust 重建。发布 helper 及本仓库流程按既有包文件列表排除在 npm payload 外。
