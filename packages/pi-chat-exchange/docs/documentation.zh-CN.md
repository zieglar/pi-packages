# 文档索引与维护

[English](documentation.md) | 简体中文

新用户从[快速开始](getting-started.zh-CN.md)安装 **CE0.2.1**、准备 Native、授权配对并尝试首次交换。每份用户可见 Markdown 都有英文默认页和简体中文对应页，许可证原文不翻译。历史说明保留当时范围，不作为当前安装或支持承诺。

## P0：开始使用 CE

| 需求 | English | 简体中文 |
|---|---|---|
| 了解能力与限制 | [README](../README.md) | [首页](../README.zh-CN.md) |
| 安装、配置并尝试首次交换 | [Getting started](getting-started.md) | [快速开始](getting-started.zh-CN.md) |
| 使用专用 Host 或 Registry tarball | [Installation](independent-install.md) | [独立安装](independent-install.zh-CN.md) |

## P1：完成具体任务

| 需求 | English | 简体中文 |
|---|---|---|
| 检查、安装或修复 Native | [Native management](native-management.md) | [Native 管理](native-management.zh-CN.md) |
| 配置 Tunnel、权限和生命周期 | [Tunnel setup](tunnel-setup.md) | [Tunnel 设置](tunnel-setup.zh-CN.md) |
| 使用独立 Desktop stdio 路线 | [ChatGPT installation](chatgpt-installation.md) · [plugin guide](../plugin/pi-chat-exchange/README.md) | [ChatGPT 安装](chatgpt-installation.zh-CN.md) · [插件指南](../plugin/pi-chat-exchange/README.zh-CN.md) |
| 注册多个 Pi Session | [Multi-session usage](multi-session-usage.md) | [多 Session](multi-session-usage.zh-CN.md) |

## P2：查命令、配置或错误

| 参考 | English | 简体中文 |
|---|---|---|
| Pi 命令、工具、payload/ACK 与策略 | [Extension reference](../pi-extension/README.md) | [扩展参考](../pi-extension/README.zh-CN.md) |
| 运行时要求与实测范围 | [Runtime support](runtime-support.md) | [运行时支持](runtime-support.zh-CN.md) |
| Profile、环境变量及配置优先级 | [Tunnel configuration](tunnel-setup.md#配置模型与生成文件) | [Tunnel 配置](tunnel-setup.zh-CN.md#配置模型与生成文件) |
| 拒绝处理与维护 | [Operations](operations.md) · [Tunnel troubleshooting](tunnel-setup.md#故障排查先定位层再进行最小修复) | [运维](operations.zh-CN.md) · [Tunnel 排障](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复) |
| Detached client 生命周期与进程所有权 | [Background Manager](tunnel-manager-background.md) | [后台 Manager](tunnel-manager-background.zh-CN.md) |

## P3：工程、安全与发布历史

| 参考 | English | 简体中文 |
|---|---|---|
| 组件与权限归属 | [Architecture](architecture.md) | [架构](architecture.zh-CN.md) |
| 存储与授权 | [Storage contract](storage-contract.md) · [Storage security](storage-security.md) | [存储契约](storage-contract.zh-CN.md) · [存储安全](storage-security.zh-CN.md) |
| Ownership 与 ACK | [Ownership contract](ownership-contract.md) · [ACK contract](delivery-ack-contract.md) | [所有权契约](ownership-contract.zh-CN.md) · [ACK 契约](delivery-ack-contract.zh-CN.md) |
| 冻结协议及阶段历史 | [Protocol v2](protocol-v2.md) | [协议 v2](protocol-v2.zh-CN.md) |
| Native 制品、信任与发布流程 | [Native SQLite](native-sqlite.md) · [Native release CI](native-release-ci.md) | [Native SQLite](native-sqlite.zh-CN.md) · [Native 发布 CI](native-release-ci.zh-CN.md) |
| 版本与历史资格 | [Changelog](../CHANGELOG.md) · [0.2.0 record](releases/0.2.0.md) | [变更记录](../CHANGELOG.zh-CN.md) · [0.2.0 记录](releases/0.2.0.zh-CN.md) |
| 许可证声明 | [Licenses](licenses.md) | [许可证](licenses.zh-CN.md) |

安装页将当前0.2.1 步骤与历史0.2.0 记录分开。Storage、Ownership、协议和安全参考保留冻结或阶段资料及后续修订，使用旧要求前先看适用范围与取代说明。真实 Cloud transport 和完整 ChatGPT ↔ Pi 交换仍未验证；安装、自动测试、手动消息各有独立证据范围。

## 双语维护

各页在顶部链接对应语言，同一变更同时更新两种语言。优先链接同语言页面，标题变化时用显式锚点保留入站链接。两种语言须保持前提、命令、参数 schema、权限、拒绝处理和验证边界等价，自然翻译无需逐句对应。

命令以实现/测试为准，npm metadata 以 `package.json` 和实际 Registry 为准，Native 信任以 `src/storage/native-compat.ts` 和固定发布证据为准。npm 发布独立于 Native Release，不能单凭发布就信任新二进制。仓库文档编辑不改变已发布0.2.1 tarball 字节。完整文档和译文在 GitHub，npm 归档只含英文基础 README。

将 humanizer 和 qu-ai-wei 分别作为英中文案整理的内嵌步骤。保留命令、代码、key、版本、SHA、路径、错误码、URL 和安全含义，不为语言流畅新增功能或提高证据强度。

## 文档变更验证

- 核对实际 Public Markdown 清单、语言对应页和双向导航。
- 检查本地文件与锚点，将公开 GitHub 仓库链接映射到预期文件。
- 比较两种语言的命令/JSON 和技术标识，说明历史差异。
- 核对当前版本、运行时、默认驱动及平台/client 证据范围。
- 检查 Setup 授权、精确 recipient label、正文暴露、ACK 接收语义、未知结果和安全 Stop。
- 扫描变更中的私有路径、凭据、正文和内部记录。
- 保留日期化证据与冻结契约，修正当前指南时不改写历史。
- 审查固定文档候选，Export/Push 前执行仓库要求的检查。

文档验证不证明 Cloud transport，不授予真实操作或包发布权限。
