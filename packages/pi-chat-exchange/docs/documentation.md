# Documentation index and maintenance

English | [简体中文](documentation.zh-CN.md)

Start with [Getting started](getting-started.md) to install **CE0.2.1**, prepare Native, authorize one pair and attempt a first exchange. Every user-facing Markdown document has an English default and a Simplified Chinese counterpart. License texts remain verbatim. Historical notes retain their dated scope; they are not current installation or support promises.

## P0: start using CE

| Need | English | 简体中文 |
|---|---|---|
| Understand capabilities and limits | [README](../README.md) | [首页](../README.zh-CN.md) |
| Install, configure and try a first exchange | [Getting started](getting-started.md) | [快速开始](getting-started.zh-CN.md) |
| Use a dedicated Host or Registry tarball | [Installation](independent-install.md) | [独立安装](independent-install.zh-CN.md) |

## P1: complete a specific task

| Need | English | 简体中文 |
|---|---|---|
| Inspect/install/repair Native | [Native management](native-management.md) | [Native 管理](native-management.zh-CN.md) |
| Configure Tunnel, grants and lifecycle | [Tunnel setup](tunnel-setup.md) | [Tunnel 设置](tunnel-setup.zh-CN.md) |
| Use the separate Desktop stdio route | [ChatGPT installation](chatgpt-installation.md) · [plugin guide](../plugin/pi-chat-exchange/README.md) | [ChatGPT 安装](chatgpt-installation.zh-CN.md) · [插件指南](../plugin/pi-chat-exchange/README.zh-CN.md) |
| Register multiple Pi Sessions | [Multi-session usage](multi-session-usage.md) | [多 Session](multi-session-usage.zh-CN.md) |

## P2: look up commands, configuration or errors

| Reference | English | 简体中文 |
|---|---|---|
| Pi commands, tools, payload/ACK and policy | [Extension reference](../pi-extension/README.md) | [扩展参考](../pi-extension/README.zh-CN.md) |
| Runtime requirements and measured scope | [Runtime support](runtime-support.md) | [运行时支持](runtime-support.zh-CN.md) |
| Profile/environment and configuration precedence | [Tunnel configuration](tunnel-setup.md#配置模型与生成文件) | [Tunnel 配置](tunnel-setup.zh-CN.md#配置模型与生成文件) |
| Refusal handling and maintenance | [Operations](operations.md) · [Tunnel troubleshooting](tunnel-setup.md#故障排查先定位层再进行最小修复) | [运维](operations.zh-CN.md) · [Tunnel 排障](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复) |
| Detached client lifecycle and process ownership | [Background Manager](tunnel-manager-background.md) | [后台 Manager](tunnel-manager-background.zh-CN.md) |

## P3: engineering, safety and release history

| Reference | English | 简体中文 |
|---|---|---|
| Components and authority | [Architecture](architecture.md) | [架构](architecture.zh-CN.md) |
| Storage and permissions | [Storage contract](storage-contract.md) · [Storage security](storage-security.md) | [存储契约](storage-contract.zh-CN.md) · [存储安全](storage-security.zh-CN.md) |
| Ownership and ACK | [Ownership contract](ownership-contract.md) · [ACK contract](delivery-ack-contract.md) | [所有权契约](ownership-contract.zh-CN.md) · [ACK 契约](delivery-ack-contract.zh-CN.md) |
| Frozen protocol and phase history | [Protocol v2](protocol-v2.md) | [协议 v2](protocol-v2.zh-CN.md) |
| Native artifacts, trust and release procedure | [Native SQLite](native-sqlite.md) · [Native release CI](native-release-ci.md) | [Native SQLite](native-sqlite.zh-CN.md) · [Native 发布 CI](native-release-ci.zh-CN.md) |
| Versions and historical qualification | [Changelog](../CHANGELOG.md) · [0.2.0 record](releases/0.2.0.md) | [变更记录](../CHANGELOG.zh-CN.md) · [0.2.0 记录](releases/0.2.0.zh-CN.md) |
| License notices | [Licenses](licenses.md) | [许可证](licenses.zh-CN.md) |

The installation page separates current0.2.1 steps from its historical0.2.0 record. Storage/Ownership/protocol/security references preserve frozen or phase-scoped material and later amendments. Read their scope/supersession notes before applying an older requirement. Real Cloud transport and a complete ChatGPT ↔ Pi exchange remain unverified; installation, automated tests and manual message evidence have distinct scopes.

## Maintain both languages

Each page links its counterpart near the top. Update both versions in the same change. Prefer matching-language links, and preserve incoming fragments with explicit anchors when headings change. English and Chinese must agree on prerequisites, commands, argument schemas, permissions, refusal handling and verification limits; natural translation need not follow sentence boundaries.

Verify commands against implementation/tests, npm metadata against `package.json` and the actual Registry, and Native trust against `src/storage/native-compat.ts` and fixed release evidence. Package publication is independent of a Native Release and does not itself grant trust to a new binary. Editing repository documents does not change already-published0.2.1 tarball bytes. Detailed documents and translations remain on GitHub; the npm archive includes only the English basic README.

Use humanizer on English prose and qu-ai-wei on Chinese prose as embedded editorial passes. Preserve commands, code, keys, versions, SHA, paths, error codes, URLs and safety meanings. Do not invent features or increase evidence strength for smoother wording.

## Validate a documentation change

- Check every actual Public Markdown file has a counterpart and reciprocal navigation.
- Resolve local files and fragments; map public GitHub repository links to the intended file.
- Compare command/JSON blocks and technical identifiers across languages, explaining historical differences.
- Check current version/runtime/default-driver facts and scoped platform/client evidence.
- Review Setup grants, exact recipient labels, payload exposure, ACK reception-only semantics, unknown outcomes and safe Stop.
- Scan changed content for private paths, credentials, payloads and internal-only records.
- Preserve dated evidence and frozen contracts; edit current guidance without rewriting history.
- Review the fixed documentation candidate and run the repository-required checks before export/push.

Documentation validation does not prove Cloud transport, authorize real operations or publish a package.
