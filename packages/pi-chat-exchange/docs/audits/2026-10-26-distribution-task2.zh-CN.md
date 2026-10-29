[English](2026-10-26-distribution-task2.md) | [简体中文](2026-10-26-distribution-task2.zh-CN.md)

> 历史证据记录。以下命令、结果和限制描述当时的阶段，不代表当前支持或发布资格。

# 分发修复：Task 2 和 scoped 路径语法证据

基线：`fix/ce-distribution-fix` 上的 Task1 提交 `349116b65da1a20c6260394b4f2fd70a3afb5c0b`；用户批准的有限扩展仅允许 `@` 成为普通命令路径字符。

## 语法变更（唯一产品修改）

`src/tunnel/profile.ts` 的 `COMMAND_PATH`：`/^\/[A-Za-z0-9_./ -]+$/` → `/^\/[A-Za-z0-9_./@ -]+$/`。绝对路径、规范化、引号、argv token、选项段、凭证形状和展开防护逐字节不变。未触及其他合同。

TDD：`grammar-scoped-red` 中 3 项 scoped 正向往返为 RED（node/script/binding，含带引号且包含空格的 scoped 路径），4 组负向测试原已通过；`grammar-scoped-green` 的全部 43 项 profile 测试为 GREEN；`grammar-neighbors` 的 18 项 setup-profile/portability 测试为 GREEN。

## 最终固定制品验证（获准复制的 Node v24.21.0、隔离冻结依赖）

最终归档：`zieglar-pi-chat-exchange-0.1.1.tgz`，SHA256 `34e612534e6b746a49c63c508fcd8f05aacad8e85251812fa827d1465fe484a0`。

- `final-targeted`：74 项通过、0 项失败（profile、setup-profile、portability、distribution、guardian-cleanup）。
- `final-smoke`：真实 npm 安装最终归档和独立 Pi 1.3.0，正式 `pi install`/`pi list`，真实 PTY：doctor（client=CE_EXECUTABLE_UNTRUSTED 安全诊断）、Setup 首次保存（掩码凭证、Advanced Messaging 授权和路由变更确认）、`/ce-tunnel convert`、`/new`、`/ce-tunnel register pi/distribution`、`/reload`、`/ce-tunnel activate`（明确从默认 Cancel 改变焦点）、`/ce-tunnel deactivate`。宿主退出码 0；证据 `<final-installed-host-evidence>`（其 `archive-sha256.txt` 记录最终 SHA256 `34e612…`；预文档制品的等价较早通过记录保留于 `<earlier-installed-host-evidence>`），result.json 为 PACKAGE_INSTALL/REAL_HOST_LOAD/FIRST_RUN=PASS、CLOUD_TRANSPORT=NOT_VERIFIED。没有执行客户端、启动 Tunnel，或业务消息/read/ACK。
- `final-build`、`final-check`、`final-typecheck`：退出码 0。
- 中间首次失败均保留：`smoke-first-save`/`smoke-full`（activate 确认默认焦点和措辞）及 `<initial-installed-host-evidence>`（实际观察到激活成功，但断言匹配文本错误）。没有修改证据使其变绿。

## 监督进程

外层运行器通过 `supervised_pty.py` 将生命周期委托给已提交的 guardian/anchor；guardian 清理回归（`guardian-cleanup.test.ts`）证明，无需 Python finally，driver SIGKILL 和外层超时死亡均能达到已确认的 groupDead/anchorReaped 屏障。最终 smoke 屏障：successful=true，退出码 0。

已知首次失败残留（未解决，待运维处理）：修正前监督程序运行留下的 8 组合成 anchor 仍存活；只读存活复查保存在 `guardian-residue-liveness-readonly.json`（8 组仍均标识其夹具根目录）。没有发送信号的权限（无自有 handle/nonce 通道）；没有向它们发送信号。不计为清理 PASS。

## 分发制品/测试

增加 `package:pi-extension` 脚本通道；默认 `pnpm test` 排除重型通道（没有 opt-in 环境变量时若进入则明确失败）。打包校验器现在要求 npm dry-run 清单包含 native/operator 资产（3 项排除测试 RED→GREEN）。正式消费者/生产者指南：`docs/independent-install.md`；README/tunnel-setup/pi-extension README 增加指引，命令与已执行 smoke 一致。

完整默认套件、插件测试和独立固定 SHA 评审仍由父会话负责。
