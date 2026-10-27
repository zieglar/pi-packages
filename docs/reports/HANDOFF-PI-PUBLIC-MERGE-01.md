# HANDOFF-PI-PUBLIC-MERGE-01 / POSTMERGE-01 — Public Merge Record & Post-merge CI Diagnosis

## Handoff ID / 状态

- HANDOFF-PI-PUBLIC-MERGE-01 — 合并已完成（补录本报告）。
- HANDOFF-PI-PUBLIC-POSTMERGE-01 — 只读诊断与就绪评估完成。

## Verdict

**ACCEPT WITH FOLLOW-UP。** 合并本身在权威性、完整性与可追溯性上全部达标；两项遗留均不影响已合并内容的正确性：合并提交自身未触发 main CI（机制 UNKNOWN），且 npm 首次发布仍缺少独立的发布授权与所有者许可确认。

## Baseline（本轮核验）

| 项 | 值 |
| --- | --- |
| 私有仓库 | `~/Code/pi-packages-dev`，`main...origin/main [ahead 114]`，HEAD `cde532a0f37031ddc1019a2a890e3d92b9501332`，仅 `.herdr-web-ui/`、`AGENTS.md` 未跟踪 |
| 公开仓库 | `~/Code/pi-packages`，remote `https://github.com/zieglar/pi-packages.git` |
| 公开 main（远端） | `d104c9eea634d8876f14e45f323ef9d0cec92569` |
| 验证分支 | `verify/ce-public-ci-03` @ `86e0efa21645f429aa014b4d5fe2ac68d95434ad`（保留） |
| 代码漂移 | 无 |

## 合并前后 SHA

| 角色 | SHA |
| --- | --- |
| 合并前 public main（parent #1） | `6a3338dde60a5d36f07594159b8efe97f45f8f57` |
| 原始验证提交（parent #2，已保留） | `86e0efa21645f429aa014b4d5fe2ac68d95434ad` |
| **Merge commit = 当前 public main** | **`d104c9eea634d8876f14e45f323ef9d0cec92569`** |

合并方式：**普通 merge commit**（双亲），`merged_by: zieglar`，`merged_at: 2026-10-27T14:13:21Z`。未使用 squash / rebase / force push；未创建 Tag / Release；未执行 npm publish；未删除验证分支。

## PR 与 CI 证据

- PR **#1** → `MERGED`：<https://github.com/zieglar/pi-packages/pull/1>（1 个提交，8 文件，97+/10−）
- 权威 CI：run **40516082116**，`pull_request`，conclusion **success**
  - Runner：`ubuntu-latest` → Ubuntu 24.04.5 LTS，image `ubuntu-24.04` `20261025.353.1`，runner `2.338.0`
  - Architecture：**x64**（Node 24.21.0 linux-x64）
  - Job `validate` `122230255384`：Install / Build / Typecheck / Check packages / Test / Check diff hygiene 全 success
  - 检出对象：临时合并提交 `0daaecb` = `Merge 86e0efa… into 6a3338dd…`

## Tree equality

`origin/main^{tree}` == `86e0efa^{tree}` == **`3cb9d74f956a9eae5fe14b5e0ad3ceafbffa9bfa`**。

因 base 自分支创建后未移动，PR CI 实际测试的树与当前 public main 的树**完全相同**，故已合并内容确已在原生 Linux x64 验证。

## 8 文件完整性

旧 main → 新 main 的差异恰为 8 文件、97 插入 / 10 删除，`git diff --summary` 为空（无模式位、无新增/删除/改名）：

| 文件（均在 `packages/pi-chat-exchange/`） | +/− |
| --- | --- |
| `scripts/debug-plugin/launch` | 5/1 |
| `test/host-regression/harness-cleanup.test.ts` | 24/1 |
| `test/host-regression/support/pty-driver.py` | 6/2 |
| `test/package/support/durable-env.test.py` | 22/1 |
| `test/plugin/debug-stdio.test.ts` | 18/1 |
| `test/runtime/executables.test.ts` | 8/2 |
| `test/tunnel/extension-manager.test.ts` | 6/1 |
| `test/tunnel/portability.test.ts` | 8/1 |

8/8 文件与私有 HEAD **逐字节一致**（SHA-256 比对 MATCH）。`86e0efa` 经 `git merge-base --is-ancestor` 确认为 main 的祖先。

## 合并后 CI 未触发：事实与诊断

**事实**：`d104c9e` 的 check-runs 总数 = 0；工作流 `CI`（id `398191690`）历史 `total_count = 2`，即 PR 成功运行 `40516082116` 与合并前的旧 main 失败运行 `40499683066`，无第三次运行；观察至 14:37Z（合并后 24 分钟）仍无新运行。

**只读证据**：

| 检查 | 结果 |
| --- | --- |
| `.github/workflows/ci.yml` 触发器 | `on: pull_request` + `push: branches: [main]`；无 `workflow_dispatch` |
| 工作流状态 | `state: active` |
| Actions 仓库设置 | `enabled: true`，`allowed_actions: all`；默认 workflow 权限 `read` |
| 仓库状态 | public，`archived: false`，`disabled: false`，`fork: false` |
| 仓库 `pushed_at` | `2026-10-27T13:33:14Z` —— **未随 14:13:21Z 的合并前进** |
| 仓库事件流 | 仅 `PullRequestEvent(merged)` @14:13:21Z；**无 PushEvent** |
| 合并执行身份 | 用户 `zieglar`（本地 PAT 经 `gh`），非工作流 token |

**分类结论**：**Workflow 未触发**（未产生 push event）。逐项排除：

- *非被禁用*：工作流 `active`，Actions `enabled`。
- *非被跳过*：不存在 `skipped`/`cancelled` 结论的运行；`total_count` 与运行列表完全对账。
- *非触发但不可见*：工作流运行总数与可见列表一致。
- *非 `GITHUB_TOKEN` 抑制规则*：该规则仅适用于工作流内使用 `GITHUB_TOKEN` 产生的事件；本次合并由用户 PAT 发起，规则不适用。

**根因机制：UNKNOWN。** 可观测证据只能证明「合并对 `refs/heads/main` 的更新未被记录为 push 事件」（`pushed_at` 未前进 + 事件流无 PushEvent），无法从只读接口判定 GitHub 侧具体原因。未使用空提交、再次 push 或修改 workflow 制造验证结果。

## Tests executed / Results（本轮未新跑测试）

沿用 CI-04 的原生 Linux x64 结果（对象树与当前 main 相同）：

| 指标 | 结果 |
| --- | --- |
| Test Files | 167 passed / 1 skipped（168） |
| Tests | **2741 passed / 0 failed / 26 skipped（2767）** |
| Unhandled errors | 0 |
| Duration | 212.37s |

重点域全部通过：PTY（`harness-cleanup` ✓19、`failure-path` ✓14、`guardian-cleanup` ✓3）、RPC/stdin（`debug-stdio` ✓2）、Node 准入（`executables` ✓44/4skip）、Tunnel（`extension-manager` ✓13、`portability` ✓3）、lease 时序（`lease-lock-wait` ✓7）、reconcile 超时（`reconcile-session-mutex` ✓24，2.96s）、环境隔离（`distribution` ✓30）。

## Review evidence

CI-02 固定增量双审查：reviewer 发现并闭环 1 项 HIGH（macOS Xcode python3 shim 注入导致的探针回归）；security-reviewer **PASS**，绑定 `durable-env.test.py` SHA-256 `6984d16d15ab9942cd1c9c75a6b8896a156ffa02b9da30e7a970ca69deaa0cbf`。CI-04 原生 CI 构成独立执行性验证。本轮与合并轮均无代码增量。

## 发布前就绪评估（只读）

| 项 | 观察 |
| --- | --- |
| 包名 / 版本 | `@zieglar/pi-chat-exchange` **0.2.0** |
| License / 清单 | MIT（`Copyright (c) 2026 zieglar`），`LICENSE`、`README.md`、`CHANGELOG.md`、`docs/releases/0.2.0.md` 均在仓库内 |
| manifest | `type: module`，`engines.node: 24.21.0 \|\| 24.22.1`，`publishConfig: {access: public, registry: registry.npmjs.org}`；无 `main`/`types`/`bin` 字段；非 `private` |
| 发布白名单 | 20 项显式 `files` 条目（`pi-extension/*.ts`、`dist/**/*.js`、`native/tunnel-keychain.swift`、两个 `scripts/*.mjs`、指定 docs、`CHANGELOG.md`、`docs/releases/0.2.0.md`） |
| **本次合并对 tarball 的影响** | **零**。8 个合并文件（`test/**`、`scripts/debug-plugin/launch`）**全部不在白名单内** → 发布产物逐字节未变 → **既有 npm pack 与安全审计证据对当前 public main 仍然适用** |
| 注册表状态 | `npm view` → **E404**，该包从未发布过（本次将是首次发布） |
| 冻结契约脚本 | 白名单内 `scripts/reconcile-session-process-mutex.mjs`（public main SHA-256 `ad5ebac52cb85cfc7364f305c8643d9cbe3ae065a8dd6e3d656b9412e5647e13`）已含冻结发布契约：`O_CREAT\|O_EXCL\|O_NOFOLLOW` 0600 写 pending → 逐级 fsync → 完整重校验 → `renameSync` 为唯一提交点 → 固定 `publication uncertain; manual review required; no retry` 拒绝 |

**发布前就绪：BLOCKED**（阻塞项均为流程/授权，非代码缺陷）：

1. **发布授权缺失** —— 本轮明确不授权 Tag / Release / npm publish；首次发布需独立授权与发布者身份确认。
2. **所有者许可依据需所有者确认** —— `CHANGELOG.md` 0.2.0 声明「CE 自有代码为所有者授权 MIT、第三方许可证据完整、已移除 `private: true`」；该声明来自仓库内文本，本轮**未**取得独立的所有者许可确认记录，仍按未闭环处理。
3. **public main 无自有绿色 CI 记录** —— 与发布产物无关（树已验证），但作为发布门禁的可审计信号缺失。

## 剩余风险 / Blockers

1. public main 缺少自有 CI 运行；仓库最近一次 `push main` 运行仍是合并前的失败记录 `40499683066`，对外观感可能误导。
2. 合并未触发 push 事件的机制 **UNKNOWN**；同样情形可能在后续 main 推进时重现，影响发布门禁的自动化可信度。
3. 已接受残留（CI-02 记录）：Linux 上恰为 `UV_USE_IO_URING=0` 的泄漏不可检出（无敏感载荷，可忽略）；建议后续将 `UV_USE_IO_URING: '1'` 加入 `durable-env.test.py` 的 poison 集合作防御加固。
4. 既有非阻塞项：`test/support/default-client-guard.ts` 的嵌套 `vi.mock` Vitest 弃用警告；直跑 Python 探针产生 `support/__pycache__`。

## 证据

- `~/Code/Pi-Project-Evidence/public-repo/merge-01/`（10 文件 + `SHA256SUMS`）：合并后 PR/commit/check-runs/main 指针、main delta patch 与 stat、历史。
- `~/Code/Pi-Project-Evidence/public-repo/postmerge-01/`（14 文件 + `SHA256SUMS`）：仓库元数据、Actions 权限与默认 workflow 权限、工作流清单与全量运行、仓库事件流、合并 check-runs、main ref、PR 合并元数据、公开 `ci.yml`、main 上的 `package.json`、合并文件清单、tarball 包含性核对、`summary.md`。
- 上游轮次证据保留于 `../ci-03/`、`../ci-04/`。
- 证据目录不含凭据、token 或运行时数据。

## Next action

等待**独立的 npm 发布授权**。在授权前不执行 Tag、Release、npm publish，也不改动 public 代码或 workflow。建议在发布授权中同时明确：所有者许可确认的记录方式，以及是否需要为 public main 补一次可审计的 CI 运行（其手段需另行授权，本轮未执行）。
