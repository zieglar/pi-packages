# HANDOFF-PI-PUBLIC-CI-02 — Native Linux Validation & Remaining Failures

## Handoff ID / 状态

HANDOFF-PI-PUBLIC-CI-02 — **BLOCKED**（技术工作完成；原生 Linux x64 验证无法获得，剩余两项仿真超时需原生复核）。

## Verdict

**BLOCKED。** 唯一非时序失败已根因定位并以最小测试修复闭合（双平台验证、双审查通过、SHA 绑定）；其余失败全部归因为仿真环境时序并留有原始原生 CI 通过证据。未获得任何原生 Linux x64 环境（Codespaces 需交互式 scope 授权，返回 403；本机 arm64；无可用远程主机），按交接要求不将仿真容器视为原生验证。

## Baseline / Changed files / Commit

- 基线门 PASS：`main @ 0748a00c0bd1fcb9524ec6ed5101699515b5f79e`，upstream `origin/main`，ahead 111 / behind 0，worktree clean；既有未跟踪 `AGENTS.md`、`.herdr-web-ui/` 未触碰。Public 仓库 `~/Code/pi-packages` 未修改。
- 本轮变更（相对 0748a00，单文件 +22/−1）：`packages/pi-chat-exchange/test/package/support/durable-env.test.py`，SHA256 `6984d16d15ab9942cd1c9c75a6b8896a156ffa02b9da30e7a970ca69deaa0cbf`。
- 本轮提交：`655487865bdb7054f8908cf9828d24afe475c4c0`（本地 commit，未 push）。
- 证据：`.git/handoff-evidence/HANDOFF-PI-PUBLIC-CI-02/`（12+ 文件，SHA256SUMS 覆盖）。

## 六项失败 + 三个 unhandled 的逐项根因与处置

CI-01 候选全量默认运行（2735/6/26/3）逐项：

| # | 失败 / unhandled | 根因（分类） | 处置 |
| --- | --- | --- | --- |
| 1 | distribution「durable validators … private environment」env 不含 UV_USE_IO_URING 断言失败 | **Linux 平台差异（验证内核）**：Node 24.21.0 在无 io_uring 内核上自注入 `UV_USE_IO_URING=0`（实证：`io_uring_setup`=ENOSYS；`env -i` 下仍出现该变量；显式 `=1` 不被覆盖；镜像/exec 环境无此变量）。GitHub 原生 runner（io_uring 可用）不注入——原始公开运行该文件通过。非实现缺陷、非泄漏。 | 测试可移植性修复：新增 Node 对照子进程钉死自注入（仅 `UV_USE_IO_URING='0'` 可作为相对 Python 对照的额外项），探针期望环境 = Python 对照 + 该钉死项。调用方环境泄漏检测与 launcher env/cwd 断言逐字不变；审查者变异验证 8/8 泄漏哨兵仍 fail-closed。 |
| 2 | distribution「native inventory」5s 超时（全量并发下） | 仿真时序（Rosetta x86 慢）；单独串行与并发均通过；原始原生 CI 通过。 | 不改代码；随 #1 修复后该文件 30/30（串行+并发）。 |
| 3 | reconcile-session-mutex「refuses each single wrong expectation」5s 超时（串行亦超） | 仿真时序；诊断性 20s 预算下 24/24 通过（未提交任何超时/断言改动）；原始原生 CI 通过。 | 不改代码；需原生复核。 |
| 4–6 | lease-lock-wait C/D/E「initiated before expiry」时间戳断言 | 仿真并发调度抖动；CI-01 串行全过；本轮全量并发运行中 C/D/E 通过而子测 A 失败（失败子测跨运行漂移）→ 非确定性调度敏感，非确定性缺陷。 | 不改代码；lease ownership / fencing 语义未触碰；需原生复核。 |
| 7–9 | 3 个 unhandled（lease 清理期子进程结果断言） | #4–6 失败的级联清理错误。 | 两轮修正后全量运行 unhandled 均为 0。 |

## 原生 Linux x64 环境证据

**未获得。** 尝试与排除：`gh codespace list` → HTTP 403（需 codespace scope + 仓库 admin，须用户交互授权 `gh auth refresh -s codespace`）；`~/.ssh/config` 无具名主机；本机 Darwin arm64；UTM/QEMU 属仿真。本轮全部 Linux 证据来自 OrbStack **仿真 x86_64** 容器（node:24.21.0-bookworm，镜像 `b795e77f6c25`，uid1000、umask022、Btrfs /tmp、无宿主挂载、验证前断网、合成不可信 toolcache、无批准默认 Node 回退）——按交接要求明示其非原生属性。

## Tests executed / Results

| 执行 | 结果 / 证据 |
| --- | --- |
| macOS 宿主直跑修正版 durable-env（TMPDIR realpath 归一） | `Ran 1 test … OK`（审查预测的 4 处 Xcode-shim 失败消除）；`py_compile` OK |
| Linux 候选 distribution.test.ts（修正后） | 串行 30/30；单独并发 30/30（dist-serial-fixed / dist-parallel-fixed / dist-final） |
| 候选 build / typecheck / check | 全部通过（ci02-build.log） |
| 候选全量默认（修正前版本，node_env 对照） | 2739 / 2 failed / 26 skipped / 0 unhandled（ci02-full.json） |
| 候选全量默认（最终 expected_env 版本） | **2739 通过 / 2 失败 / 26 跳过 / 0 unhandled**（ci02-full-final.json）；2 失败 = lease 子测 A（时序族）+ reconcile 超时（#3/#4–6 族） |
| 未运行（无增量） | 7 文件定向套件、lease 串行、reconcile 20s 诊断 —— 沿用 CI-01 证据；已排除的安装类/真实客户端通道保持排除，未启用 |

跳过项与 CI-01 报告一致（26 项平台/前置条件跳过，无新增跳过）。

## Review evidence

- **public-ci2-review（reviewer）**：发现 HIGH——v1 以 `node_env` 为精确目标在 macOS（Xcode python3 shim 注入 SDKROOT/CPATH/LIBRARY_PATH/MANPATH，探针经 Python 子进程继承）必败 4 处；Linux 容器因两环境相等未暴露。给出最小修正 `expected_env`。返工三条件（采纳修正 + macOS 复跑 + 无 io_uring Linux 复跑）全部满足并留证。
- **public-ci2-security（security-reviewer）**：**PASS**，绑定 v2 SHA256 `6984d16d…`；中途察觉文件变更并复审两版本，确认 v2 严格收紧且消除 v1 唯一残留（Xcode-shim 值未钉死问题）。变异验证：8/8 泄漏哨兵 fail-closed；白名单扩张上界恰为 `{UV_USE_IO_URING:'0'}`；canary 秘密零输出；`verify_durable` 权威边界不变。已接受残留：Linux 上恰好泄漏 `UV_USE_IO_URING=0`（值等于运行时自默认、无敏感载荷）不可检出——评估为可忽略；建议后续把 `UV_USE_IO_URING:'1'` 加入 poison（follow-up，未纳入本轮以保持 SHA 审查边界）。
- 模型路由披露：两位审查者请求 `openai-codex/gpt-6.1-sol`，实际运行 `anthropic/claude-opus-5`（与 CI-01 方向相反；两轮合计两家族均参与，各自为独立全新上下文，非同家族自我确认）。审查者平台为 macOS，Linux 结论以父级证据为准（已在限制栏声明）。

## Remaining risks / Blockers

1. **原生 Linux x64 验证缺失（硬阻塞）**：需在原生 x64（GitHub runner 等价：默认并发、默认 5s 超时、批准 Node 24.21.0、受信本地测试存储）对候选全量 `pnpm test` 通过。解除方式（任一）：授权 Codespaces（`gh auth refresh -s codespace`，仓库 admin）；或提供任意原生 x64 Linux 主机；或在获得授权的公开仓库受控导出后由公开 CI 运行验证（导出本身仍需先解除本阻塞的授权决策）。
2. 仿真下剩余 2 项失败（reconcile 超时、lease 子测时序）预期在原生环境消失（原始公开运行该两文件通过），但未证实。
3. 已接受残留：`UV_USE_IO_URING=0` 精确值泄漏在 Linux 上不可检出（可忽略；follow-up 加固建议）。
4. 既有事项不变：Vitest 嵌套 `vi.mock` 警告（未来版本将报错）；`support/__pycache__` 直跑副产物（基线既有）。

## READY_FOR_PUBLIC_SYNC

**NO**（BLOCKED）。

## 精确 Public 导出 delta

导出补丁：`.git/handoff-evidence/HANDOFF-PI-PUBLIC-CI-02/export.patch`，SHA256 `07af548d7ba9a8727cb483a85c1137e718422a45ce8aff9f0decceceb9f3587f`，= `git diff 9e673bf5..6554878 -- packages/pi-chat-exchange`，已通过针对公开 SHA `6a3338dd` 归档的 `git apply --check`（容器 /candidate2）。共 8 个文件，全部位于 `packages/pi-chat-exchange/`：

1. `scripts/debug-plugin/launch`
2. `test/host-regression/harness-cleanup.test.ts`
3. `test/host-regression/support/pty-driver.py`
4. `test/plugin/debug-stdio.test.ts`
5. `test/runtime/executables.test.ts`
6. `test/tunnel/extension-manager.test.ts`
7. `test/tunnel/portability.test.ts`
8. `test/package/support/durable-env.test.py`

明确排除：本报告 `docs/reports/HANDOFF-PI-PUBLIC-CI-02.md`、CI-01 报告、`.git/handoff-evidence/` 全部证据、私有根配置与 lockfile。不 push、不 tag、不发布；Public 仓库本轮零改动。
