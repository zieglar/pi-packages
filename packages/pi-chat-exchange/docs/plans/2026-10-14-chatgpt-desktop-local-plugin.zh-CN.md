[English](./2026-10-14-chatgpt-desktop-local-plugin.md) | [简体中文](./2026-10-14-chatgpt-desktop-local-plugin.zh-CN.md)

> 历史计划（2026-10-14）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="chatgpt-desktop-local-plugin-implementation-plan"></a>

# ChatGPT Desktop 本地插件实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 生成经过验证、可安装的 ChatGPT Desktop 本地插件 ZIP，复用现有绑定 Endpoint 的 stdio MCP server。

**架构：** 现有 MCP server 保持不变，增加可移植 Agent Plugins 软件包及确定性打包器。打包器构建并内置编译后的 server 和生产依赖闭包；操作员 binding 配置保留在外部，包内只提供脱敏模板。

**技术栈：** TypeScript、Node.js 24、pnpm、Vitest、Agent Plugins 1.0 manifest、MCP stdio。

---

<a id="task-1-lock-the-portable-package-contract-with-failing-tests"></a>

### 任务 1：用失败测试锁定可移植软件包契约

**文件：**

- 创建：`test/plugin/local-plugin-package.test.ts`
- 稍后创建：`plugin/pi-chat-exchange/plugin.json`
- 稍后创建：`plugin/pi-chat-exchange/mcp.json`
- 稍后创建：`plugin/pi-chat-exchange/config/binding.example.json`

**步骤 1：** 编写测试，要求可移植 schema、稳定身份、`${PLUGIN_ROOT}` stdio launcher、固定外部操作员配置位置、文档中的四个预期工具名，以及不存在形似凭证的字符串。

**步骤 2：** 运行 `pnpm vitest run test/plugin/local-plugin-package.test.ts`。

**预期：** FAIL，原因是插件目录不存在。

**步骤 3：** 增加最小 manifest、脱敏模板和插件 README。

**步骤 4：** 重新运行定向测试。

**预期：** PASS。

<a id="task-2-add-a-deterministic-package-builder"></a>

### 任务 2：增加确定性软件包构建器

**文件：**

- 创建：`scripts/package-local-plugin.mjs`
- 修改：`package.json`
- 修改：`test/plugin/local-plugin-package.test.ts`
- 如需要，为生成的插件暂存目录和归档创建 `.gitignore` 条目。

**步骤 1：** 扩展测试，调用打包器并断言暂存软件包包含编译后的入口、运行时软件包元数据、生产依赖，且没有符号链接、源码测试、真实配置或秘密。

**步骤 2：** 运行定向测试，确认因打包器不存在而失败。

**步骤 3：** 使用参数向量子进程调用和文件系统 API 实现最小打包器，不使用 shell 插值。构建现有软件包，物化生产依赖，复制可移植文件，检查目录树，并在插件根目录之外创建 ZIP。

**步骤 4：** 重新运行定向测试并确认通过。

<a id="task-3-verify-the-packaged-stdio-server"></a>

### 任务 3：验证打包后的 stdio server

**文件：**

- 修改：`test/plugin/local-plugin-package.test.ts`

**步骤 1：** 增加打包制品测试：启动暂存 stdio 入口、初始化 MCP、列举工具，确认 `ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`，调用无害 `ping`，然后正常关闭。

**步骤 2：** 针对故意缺失的暂存软件包运行测试，确认预期失败。

**步骤 3：** 用打包器构建制品并重新运行测试。

**预期：** PASS，发现四个工具，`ping` 返回 reachable。

<a id="task-4-replace-stale-installation-guidance"></a>

### 任务 4：替换过时安装指导

**文件：**

- 修改：`docs/chatgpt-installation.md`
- 修改：`docs/phase-0-evidence.md`
- 修改：`README.md`

**步骤 1：** 依据当时最新的 OpenAI 官方文档，只更新过时的传输/软件包主张。记录本地 marketplace/手动 Desktop 安装、外部 binding-config 复制、插件重启/缓存行为及人工端到端验收流程。

**步骤 2：** 在用户执行前，将 Desktop 安装和真实 ChatGPT 调用明确标为 `NOT_RUN`。

<a id="task-5-final-verification-and-review"></a>

### 任务 5：最终验证和评审

**文件：**

- 评审全部变更文件。

**步骤 1：** 运行软件包专用测试。

**步骤 2：** 运行现有 `test/bin/stdio-messaging.test.ts`。

**步骤 3：** 运行 `pnpm run verify`。

**步骤 4：** 运行打包命令并检查 ZIP 成员列表，确认只有一个顶层 `pi-chat-exchange/` 目录，且没有敏感或无关文件。

**步骤 5：** 检查 `git diff --check`、`git diff --stat`、`git status`；确认已有未跟踪 `mise.toml` 未改动，core 权限文件没有变化。

**步骤 6：** 没有单独授权，不得 commit 或 push。
