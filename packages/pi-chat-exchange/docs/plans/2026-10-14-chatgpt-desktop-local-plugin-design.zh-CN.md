[English](./2026-10-14-chatgpt-desktop-local-plugin-design.md) | [简体中文](./2026-10-14-chatgpt-desktop-local-plugin-design.zh-CN.md)

> 历史计划（2026-10-14）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="chatgpt-desktop-local-plugin-design"></a>

# ChatGPT Desktop 本地插件设计

<a id="goal"></a>

## 目标

将现有 `mcp-stdio` 入口打包为可安装的 ChatGPT Desktop 本地插件，不改变协议、存储、Endpoint 权限或 MCP 工具行为。

<a id="chosen-approach"></a>

## 选定方案

使用可移植的 Agent Plugins 1.0 布局。纳入版本控制的插件源码只包含 manifest、已脱敏的操作员配置模板、打包元数据和文档。确定性打包脚本构建现有软件包，将编译后的运行时和生产依赖复制到被忽略的暂存目录，验证归档内容，再生成 ZIP。

安装后的插件必须能从 ChatGPT Desktop 插件缓存运行，因此不采用指回仓库的 wrapper。也不复制 MCP 源码：现有 `src/bin/mcp-stdio.ts` 仍是唯一实现及权限边界。

<a id="package-shape"></a>

## 软件包结构

```text
pi-chat-exchange/
  plugin.json
  mcp.json
  config/binding.example.json
  server/launch.mjs
  server/dist/**
  server/node_modules/**
  server/package.json
  README.md
```

`mcp.json` 启动 `node ${PLUGIN_ROOT}/server/launch.mjs`。launcher 将固定的操作员所有路径 `~/.config/pi-chat-exchange/mcp-binding.json` 传给现有入口。软件包绝不包含真实 Store 路径、Endpoint 身份、接收方身份、capability、token 或其他秘密。用户将模板复制到已安装插件缓存之外，再在本地替换占位符。

launcher 只为操作员诊断及自动化软件包验证接受规范化的绝对 `--config`；分发的 `mcp.json` 不提供此覆盖项。

构建还生成包含已打包插件的本地 marketplace，使 Desktop 应用无需公开提交或网络 Tunnel 即可发现并安装自包含制品。

<a id="safety-boundaries"></a>

## 安全边界

- 不修改 `src/protocol`、`src/core`、`src/storage`、`src/host` 或 `src/control`。
- 现有绝对路径和严格 schema 验证仍具有权威性。
- 插件不从环境变量读取身份或配置。
- 软件包验证拒绝符号链接、形似秘密的内容、开发文件和意外顶层条目。
- `stdout` 仍专用于 MCP frame；启动诊断仍写入 `stderr`。

<a id="verification"></a>

## 验证

自动化测试先证明软件包缺失或无效，再验证可移植 manifest、脱敏模板、暂存服务入口、依赖闭包、ZIP 布局、工具发现及无害 `ping`。随后运行现有定向 stdio 测试，以及软件包的契约/类型/构建/测试检查。

在 ChatGPT Desktop 中实际安装是独立的人工验收步骤。本地自动化验证不代表 Desktop UI 已加载插件。
