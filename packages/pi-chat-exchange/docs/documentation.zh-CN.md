# 双语文档维护

[English](documentation.md) | 简体中文

每份 CE Markdown 文档都提供默认英文（`name.md`）和简体中文（`name.zh-CN.md`）。范围包括包/扩展/插件 README、用户指南、契约、release notes、changelog，以及保留的 plans/audits。许可证文本保持原文。历史文档保留当时范围，不能作为当前安装或支持承诺。

## 导航与覆盖

| 任务 | English | 简体中文 |
|---|---|---|
| 产品概览 | [README](../README.md) | [README](../README.zh-CN.md) |
| 安装、配置、命令 | [Getting started](getting-started.md) | [入门](getting-started.zh-CN.md) |
| 组件与生命周期 | [Architecture](architecture.md) | [架构](architecture.zh-CN.md) |
| Native Release、pin、平台 | [Native SQLite](native-sqlite.md) | [Native SQLite](native-sqlite.zh-CN.md) |
| 安全、排障、开发、发布 | [Operations](operations.md) | [运维](operations.zh-CN.md) |
| 详细传输设置 | [Tunnel setup](tunnel-setup.md) | [Tunnel 设置](tunnel-setup.zh-CN.md) |
| Session 与授权 | [Multi-session usage](multi-session-usage.md) | [多 Session](multi-session-usage.zh-CN.md) |
| Desktop stdio | [ChatGPT installation](chatgpt-installation.md) | [ChatGPT 安装](chatgpt-installation.zh-CN.md) |
| 存储与授权 | [Storage](storage-contract.md) · [Ownership](ownership-contract.md) · [ACK](delivery-ack-contract.md) | [Storage](storage-contract.zh-CN.md) · [Ownership](ownership-contract.zh-CN.md) · [ACK](delivery-ack-contract.zh-CN.md) |

每页顶部附近链接到另一语言版本，两种语言应在同一变更中更新。英文链接通常指向英文，中文链接通常指向中文；有意跨语言引用时需明确标注。翻译标题时保留已有 fragment 链接，必要时增加显式 anchor。

## 事实与翻译

依据源码和测试核对命令、环境变量和 schema。npm 元数据以 `package.json` 为准，发布声明依据实际 Release/ref/workflow 证据，消费者 pin 依据 `src/storage/native-compat.ts`。分别说明发布、自动化测试、Store 集成和人工使用。包版本不是 Native tag，发布成功也不会晋升 trust pin。

中英文保留相同的前提、拒绝条件、证据限制和后续步骤。`Message`、`Endpoint`、`Session`、`Ownership`、`ACK` 和 `DELIVERY_UNKNOWN` 等标识在翻译可能引起歧义时保留源码拼写。翻译周边解释，不翻译配置键和错误码。恢复标记不授予权威，编辑不能引入 exactly-once 承诺、盲目重试或模型切换后的任务重放。

本次文档工作不改变 npm 包的 `files` allowlist。仓库文档范围可能大于 tarball；声称随包附带译文前先检查 pack 清单。修改当前源码树不会改变已经发布的 npm 0.2.0 字节。

## 语言审校

英文草稿完成后应用 humanizer，中文翻译完成后应用 qu-ai-wei，使用技术参考文档语体。自然语言审校期间，保留 fenced code、inline code、命令、路径、配置键、版本、SHA、URL、错误码和安全语义。不要增加宣传、虚构案例、第一人称经历或刻意口语化表达。

审校后对照草稿检查受保护片段，再通读双语文档检查事实漂移。两个 Skill 均不充当翻译器、事实来源或发布权威；该环节不需要第三方脚本。

## 验证清单

- 检查每份 CE 文档都有语言对应版本和双向链接。
- 从所在页面解析相对文件和 fragment 链接。
- 比较每对文档的代码块和技术标识，解释有意保留的历史差异。
- 对照实际 CLI/config 定义检查示例；语法检查不证明外部连接。
- 核对 npm/Native 版本、精确发布来源和平台证据范围。
- 检查改动中是否包含凭据、正文、Private 路径和仅内部记录。
- 检查 Diff 仅涉及 Markdown。Public 导出只能包含批准公开的文档，且保留先前本地导出。

源码变更仍需常规代码检查。文档验证不证明运行时、云连接或发布行为。
