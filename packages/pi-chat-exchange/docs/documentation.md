# Maintaining bilingual documentation

English | [简体中文](documentation.zh-CN.md)

Every CE Markdown document has an English default (`name.md`) and a Simplified Chinese counterpart (`name.zh-CN.md`). This includes package/extension/plugin READMEs, user guides, contracts, release notes, changelog and retained plans/audits. License texts remain verbatim. Historical documents describe their dated scope; they are not current installation or support promises.

## Navigation and coverage

| Task | English | 简体中文 |
|---|---|---|
| Product overview | [README](../README.md) | [README](../README.zh-CN.md) |
| Installation, configuration, commands | [Getting started](getting-started.md) | [入门](getting-started.zh-CN.md) |
| Components and lifecycle | [Architecture](architecture.md) | [架构](architecture.zh-CN.md) |
| Native release, pins, platforms | [Native SQLite](native-sqlite.md) | [Native SQLite](native-sqlite.zh-CN.md) |
| Security, troubleshooting, development, release | [Operations](operations.md) | [运维](operations.zh-CN.md) |
| Detailed transport setup | [Tunnel setup](tunnel-setup.md) | [Tunnel 设置](tunnel-setup.zh-CN.md) |
| Sessions and grants | [Multi-session usage](multi-session-usage.md) | [多 Session](multi-session-usage.zh-CN.md) |
| Desktop stdio | [ChatGPT installation](chatgpt-installation.md) | [ChatGPT 安装](chatgpt-installation.zh-CN.md) |
| Storage and authorization | [Storage](storage-contract.md) · [Ownership](ownership-contract.md) · [ACK](delivery-ack-contract.md) | [Storage](storage-contract.zh-CN.md) · [Ownership](ownership-contract.zh-CN.md) · [ACK](delivery-ack-contract.zh-CN.md) |

Each page links its language counterpart near the top. Update both versions in the same change. English links normally target English pages and Chinese links target Chinese pages; clearly label deliberate cross-language references. Preserve incoming fragment links when translating headings, using explicit anchors where needed.

## Facts and translation

Verify commands, environment variables and schemas against source/tests. Use `package.json` for npm metadata, actual Release/ref/workflow evidence for release claims, and `src/storage/native-compat.ts` for consumer pins. Keep publication, automated tests, Store integration and manual use separate. A package version is not a Native tag; a successful release does not promote a trust pin.

Keep the same prerequisites, refusal conditions, evidence limits and next steps in both languages. Technical identifiers such as `Message`, `Endpoint`, `Session`, `Ownership`, `ACK` and `DELIVERY_UNKNOWN` retain their source spelling when translation would obscure meaning. Translate surrounding explanations, not configuration keys or error codes. Recovery markers do not confer authority. No exactly-once promise, blind retry or model-switch replay may be introduced by editing.

The published npm package's `files` allowlist is unchanged by this documentation work. Repository documentation may be broader than the tarball; check pack inventory before making claims about bundled translations. Do not imply that editing this tree changes previously published npm 0.2.0 bytes.

## Editorial review

Apply humanizer to the completed English draft, then qu-ai-wei to the Chinese draft after translation. Use a technical reference voice. Preserve fenced code, inline code, commands, paths, configuration keys, versions, SHA, URLs, error codes and safety semantics throughout this prose-only pass. Do not add promotion, invented cases, first-person experiences or artificial colloquialisms.

Compare protected spans against the draft after editing, then review the entire pair for factual drift. Neither skill is a translator, fact source or release authority. No third-party script is needed for this editorial step.

## Validation checklist

- Check every CE document has its language counterpart and reciprocal links.
- Resolve relative files and fragment links from the page containing them.
- Compare code blocks and technical identifiers across each pair; explain intentional historical differences.
- Check examples against actual CLI/config definitions; syntax checks do not prove external connections.
- Check package/Native versions, exact release source and platform evidence scopes.
- Inspect changed prose for credentials, payloads, private paths and internal-only records.
- Review the diff for Markdown-only changes. Public export must contain only approved public documentation and retain earlier local exports.

Source changes require the repository's normal code checks. Documentation-only verification does not prove runtime, cloud or publication behavior.
