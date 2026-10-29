[English](2026-10-25-distribution-task1.md) | [简体中文](2026-10-25-distribution-task1.zh-CN.md)

> 历史证据记录。以下主张、命令、测试结果和限制描述记录时的阶段，不代表当前支持范围或发布资格。

# 分发修复：Task 1 实现证据

基线：`affc05d024d0bef4254eaf14de7d521815c720ea`，独立的 `fix/ce-distribution-fix` 工作树。已批准计划为 `docs/plans/2026-10-25-distribution-fix.md`。

证据保留在 `/private/tmp/ce-distribution-fix/implementation/`：精确的环境白名单、复制的 Node v24.21.0、禁用脚本的冻结作者依赖安装，以及 `commands.jsonl`/`evidence/*.log`。此前的安装修订证据均未覆盖。

- 有效 RED：`distribution-native-red-corrected.log`，1 项失败、4 项被过滤；在原有 gitignore 回退机制下，构建成功后的原生打包缺少 `package/dist/bin/mcp-stdio.js`。
- 保留了更早的测试框架失败：初始夹具漏掉 `.gitignore`；隔离 PATH 最初也缺少 npm 的 bin 链接（`ENOENT`）。这两项均不计为产品 RED。缺少校验器的测试最初报告 MODULE_NOT_FOUND，也不计为产品 RED。
- GREEN：`distribution-green-expanded.log`，7 项通过，0 项失败。覆盖 dist/root/入口/传递模块缺失、符号链接根目录拒绝、原生清单及无消费者钩子。
- `typecheck-task1`、`task1-build`、`task1-check`、`task1-author-pack`：退出码均为 0。源码侧编辑器无法解析此工作树中刻意未安装的 node_modules；真实的冻结隔离 `tsc` 才是类型检查证据。
- 现有 Vitest guard-hoisting 警告仍在；未运行运行时或客户端测试。

显式作者命令会在完整工作区构建，校验本地运行时导入和原生 npm 清单，再禁用脚本打包。消费者获得 JS 运行时、Pi TS 入口模块、原生辅助程序、运维脚本和公开文档；不包含消费者 tsconfig/build 合同、source maps、开发测试、node_modules 或私有状态。单独运行 `npm pack` 不是受支持的作者校验命令。

宿主提供的依赖警告评审：本次修复保持依赖锁定不变。编译后的 ESM 会通过 secure-input 直接导入 `@earendil-works/pi-tui`，也会在 Pi TS 加载器之外直接导入 TypeBox value helpers。直接删除这些依赖或改成可选 peer 可能破坏独立 Node ESM 解析。独立安装必须保留实际运行时依赖。Pi 1.3.0 警告如实记录；去重或 peer 重设计需要单独证据，也不是修复已证实的 dist 缺失所必需的。依赖和锁文件版本均未改变。

这只是实现证据。已安装宿主和首次运行验证属于 Task 2；完整测试套件、插件测试和固定 SHA 独立评审仍由父会话负责。不作云传输声明。
