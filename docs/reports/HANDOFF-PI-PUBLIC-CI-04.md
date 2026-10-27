# HANDOFF-PI-PUBLIC-CI-04 — PR Trigger & Native Linux Validation

## Handoff ID / 状态

HANDOFF-PI-PUBLIC-CI-04 — **完成**（原生 Linux x64 CI 全绿；PR 保持 OPEN 未合并）。

## Verdict

**ACCEPT。** 验证 PR 触发的 GitHub Actions 在原生 `ubuntu-24.04` / x64 runner 上全部通过：build、typecheck、check、diff hygiene 及完整默认测试套件（2741 通过 / 0 失败 / 26 跳过 / 0 unhandled）。CI-01 与 CI-02 中所有 PTY、Node、RPC、lease 时序问题在原生环境全部消失，证实此前仿真容器下的残留失败属环境/时序而非实现缺陷。CI 通过不等于已发布，合并授权仍待用户单独决定。

## Baseline（核验通过）

- Public `main`：`6a3338dde60a5d36f07594159b8efe97f45f8f57`（**运行后复核仍为该 SHA，未变**）
- 验证分支：`verify/ce-public-ci-03` @ `86e0efa21645f429aa014b4d5fe2ac68d95434ad`，本地=远端，worktree clean
- 私有 `main`：`4100ebdaea36848fdaf05b889c50f7af8a4b4440`（本轮未改代码）
- 创建前无任何既有 PR

## PR / Commit / Branch

- PR：<https://github.com/zieglar/pi-packages/pull/1> — 标题 `test: validate CE public export on native Linux CI`，base `main`，head `verify/ce-public-ci-03`
- 状态：**OPEN，未合并**（`mergedAt: null`、`closedAt: null`、`mergeStateStatus: CLEAN`）；描述已声明仅用于 CI 验证、禁止自动合并或发布
- 验证提交：`86e0efa21645f429aa014b4d5fe2ac68d95434ad`（8 文件，97+/10−，全部位于 `packages/pi-chat-exchange/`，与私有 HEAD 逐字节一致）

## 原生 Linux x64 CI 证据

| 项 | 值 |
| --- | --- |
| Run URL | <https://github.com/zieglar/pi-packages/actions/runs/40516082116> |
| Run ID / attempt | `40516082116` / 1 |
| Event | `pull_request`（关联 PR #1） |
| Workflow | `.github/workflows/ci.yml` |
| Job | `validate` — ID `122230255384`，conclusion **success** |
| Runner | `GitHub Actions 1000000292`，label `ubuntu-latest` |
| OS / Image | Ubuntu **24.04.5 LTS**，image `ubuntu-24.04` ver `20261025.353.1`，runner `2.338.0` |
| Architecture | **x64**（Node `24.21.0 - x64`，`node-24.21.0-linux-x64.tar.gz`） |
| head_sha | `86e0efa21645f429aa014b4d5fe2ac68d95434ad` |
| 实际检出 | 临时 merge commit `0daaecb` = `Merge 86e0efa… into 6a3338dd…`（`refs/remotes/pull/1/merge`） |

**Merge-commit 关系（按要求记录）**：`pull_request` 事件检出的是 GitHub 生成的临时合并提交 `0daaecb`，内容等价于「验证提交 `86e0efa` 合入 base `6a3338dd`」。因 base 自分支创建后未移动，该临时提交的树与 `86e0efa` 的树一致，故测试覆盖的正是本候选代码。`Check diff hygiene` 步骤以 `BASE_SHA=6a3338dde60a5d36f07594159b8efe97f45f8f57` 运行 `git diff --check BASE_SHA...HEAD` 并通过。

## Tests executed / Results

所有步骤 success（1–11 及 post 步骤）：Set up job、Checkout、Set up Node.js、Activate pinned pnpm、Verify package manager、Install（frozen lockfile）、**Build**、**Typecheck**、**Check packages**、**Test**、**Check diff hygiene**。

| 指标 | 结果 |
| --- | --- |
| Test Files | **167 passed / 1 skipped（168）** |
| Tests | **2741 passed / 0 failed / 26 skipped（2767）** |
| Unhandled errors | **0** |
| Duration | 212.37s |

CI-01/02 关注项在原生环境逐项通过：

| 关注域 | 原生结果 |
| --- | --- |
| PTY / Guardian | `harness-cleanup.test.ts` ✓ 19 tests（133.7s）、`failure-path.test.ts` ✓ 14 tests、`guardian-cleanup.test.ts` ✓ 3 tests |
| RPC / debug stdin | `debug-stdio.test.ts` ✓ 2 tests（含新增纯 shell stdin 回归） |
| Node 可执行准入 | `executables.test.ts` ✓ 44 tests / 4 skipped（macOS ACL 跳过） |
| Tunnel 状态与 Profile | `extension-manager.test.ts` ✓ 13、`portability.test.ts` ✓ 3 |
| lease 时序 | `lease-lock-wait.test.ts` ✓ 7 tests（48.3s）——仿真下的 A/C/D/E 抖动消失 |
| reconcile 超时 | `reconcile-session-mutex.test.ts` ✓ 24 tests（2.96s，远低于默认 5s） |
| 环境隔离（UV_USE_IO_URING） | `distribution.test.ts` ✓ 30 tests——原生 io_uring 可用，钉死逻辑兼容 |

26 跳过项与历史一致（平台/前置条件），无新增跳过、无删除测试、无放宽断言或加长超时。

## Review evidence

沿用 CI-02 固定增量审查：reviewer 发现并闭环一个 HIGH（macOS Xcode shim 环境回归），security-reviewer **PASS** 并绑定 `durable-env.test.py` SHA256 `6984d16d…`；两轮合计覆盖 anthropic 与 openai-codex 两家族（模型路由不一致已在各轮披露）。本轮无代码增量，原生 CI 结果构成对 8 文件候选的独立执行性验证。

## Risks / Blockers

1. 无阻塞。候选在原生目标环境全绿。
2. 已接受残留（CI-02 记录，不影响本轮结论）：Linux 上恰好泄漏 `UV_USE_IO_URING=0` 不可检出（无敏感载荷，可忽略）；建议后续将 `UV_USE_IO_URING:'1'` 加入 poison 作防御加固。
3. 既有非阻塞事项：Vitest 嵌套 `vi.mock` 弃用警告；`support/__pycache__` 直跑副产物。
4. 程序性提醒：`pull_request` CI 验证的是临时 merge commit；若 base `main` 后续推进，合并前应重新验证。

## 证据

`~/Code/Pi-Project-Evidence/public-repo/ci-04/`（8 文件 + `SHA256SUMS`）：`run.json`、`jobs.json`、`logs.zip`、`job-log.txt`、`run-summary.json`、`pr.json`、`remote-main-after.json`。关键校验：`logs.zip` = `887ce0d5244dadcdb296c1d57396d727df0f0d3fae5187625ba5d4be3401c15f`，`job-log.txt` = `95ffc31906f4ec944c2de85e803cc2c7a48c8c8930b0d6555116321211243e26`。CI-03 证据保留于 `../ci-03/`。

## READY_FOR_PUBLIC_MAIN_REVIEW

**YES**（仅表示可进入 main 合并评审；**不代表已发布**，且本轮未合并）。

## Next action

等待用户单独授权合并 Public `main`。PR #1 保持 OPEN 且未关闭。合并前建议确认 base 未移动（若已移动则重跑 CI）。本轮未执行且不授权：merge、push、tag、release、npm publish。
