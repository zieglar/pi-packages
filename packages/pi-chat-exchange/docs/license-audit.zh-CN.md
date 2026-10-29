[English](license-audit.md) | [简体中文](license-audit.zh-CN.md)

> 历史许可证审计。以下权限和发布限制记录 2026-10-27 阶段，不代表当前发布状态。

> 发布更新（2026-10-29）：`@zieglar/pi-chat-exchange@0.2.0` 已发布。下文发布限制属于当时审计权限边界。历史资格为 Node 24.21.0 / Pi 1.3.0 / macOS arm64；该制品云分发仍为 `NOT_VERIFIED`。当前源码 [`package.json`](../package.json) 的 engine 范围为 `>=24.20.0 <=24.22.2`，与资格验证是不同主张。

# CE 0.2.0 许可证审计（仅 repo）

交接：`<license-audit-handoff>`；上游证据在 `<license-audit-follow-up>` 扩充。证据采集于 2026-10-27。

## 权限和发布决定

所有者仅授权 CE 自有代码采用 MIT：Copyright (c) 2026 zieglar。根目录没有覆盖全仓的许可证（docs/licensing.md）。本次变更前，仓库根目录和 CE 包均无 LICENSE/NOTICE/copyright 声明。检查现有源码和消费者负载，未发现复制/派生第三方声明。历史计划中此前缺少权限的描述继续保留为历史，不是当前发布步骤。

`@narumitw/pi-tui-kit@0.66.0` 是第三方，不是所有者代码。全部依赖 byte/pin、name/version/export 和锁文件不变。

已移除 `private: true`（达到所有者授权条件）。两个此前证据缺口通过三个不同来源的精确版本证据层闭合，记录于 `<retained-license-evidence>/upstream/`（R1 增补在 `upstream/r1/`，摘要在 `upstream/r1/99-DIGESTS.txt`）：

1. npm package manifest 声明许可证。`@earendil-works/pi-tui@1.3.0`（SHA-256 1ef7b630…42ef5d）和 `@earendil-works/pi-coding-agent@1.3.0`（SHA-256 ae2785e8…d3c0）的 registry 元数据和归档内 `package.json` 都声明 `license: MIT`。保留归档已证明与 registry 制品精确一致：sha1/sha512 匹配 `dist.shasum`/`dist.integrity`。声明不等于 copyright 或 permission notice。
2. npm tarball 内许可证正文缺失：两项的 `tar -tzf | grep -Ei '(^|/)(licen[cs]e|copying|notice)'` 均退出 1。这是上游打包遗漏。
3. 上游仓库存在许可证正文。github.com/earendil-works/pi 的轻量 tag `v1.3.0` 经 `git ls-remote` 解析、`git rev-parse` 再确认指向 `71023aec1546d6d677a65669c5665c0927ce0dd0`；monorepo 根 `LICENSE`（git blob `b0a8e9b8…`）包含完整 MIT License、`Copyright (c) 2025 Mario Zechner` 和 MIT permission notice，原样保存为 `upstream/r1/upstream-pi-v1.3.0-ROOT-LICENSE.txt`（SHA-256 0457f5bc…13c48）。

第三层对精确版本的适用性可由机器核验，无需推断：该提交的 `packages/tui/package.json` 和 `packages/coding-agent/package.json` 精确声明 `@earendil-works/pi-tui@1.3.0`、`@earendil-works/pi-coding-agent@1.3.0` 及 `license: MIT`；两个归档 manifest 的 `repository.directory` 指向对应路径；递归搜索在该 tag 两个包目录下均无 license/copying/notice 文件，因此适用 monorepo 根 `LICENSE`。registry tarball 中非构建文件（README、coding-agent CHANGELOG、schema 文件清单）与 `v1.3.0` 相同路径逐字节一致。`author` 字段 Mario Zechner 仅作为元数据记录，不替代任何 copyright 或 permission notice。

分类从证据不足变为已验证兼容：缺正文是上游打包遗漏，不是条款不兼容；除根 LICENSE 原文外没有编造 copyright 行。原始证据不足记录逐字节保留在 `evidence/audit.json`；重新分类另行带时间戳记录在 `evidence/audit-supplement.json`。已记录但未调和：`v1.3.0` 发布提交作者为 Armin Ronacher，而 LICENSE copyright holder 和 `author` 字段为 Mario Zechner；未从源码重建编译 `dist/`。CE tarball 未捆绑其代码，因此该制品目前不触发 CE 侧 notice 义务；重分发已安装树或未来捆绑代码仍需重新审计。当时本轮未授权 push/tag/publish/Release/merge，需要另行权限。

## 精确依赖范围和证据

沿 installed dependencies 和 optionalDependencies 遍历四个直接 runtime pin：100 个唯一 name/version，无缺失必需依赖。Host peer 单独检查，不混同 CE bundled code。可选 peer `@cfworker/json-schema` 未安装。其他 peer 解析到已枚举 runtime 项或独立 Host。Host dependency tree 属于独立 host 分发，不属于 CE runtime-dependency 重分发。

保留的 pnpm 安装使用与 repo 逐字节一致的 pnpm-lock.yaml，SHA-256 `47ff210cafb44a9ac38184fda6504bfb3af6c5deb81d7add7077d40a5461a82d`。作者测试引用离线现有依赖，没有下载或修改依赖。`pnpm list --prod --depth Infinity --json`、遍历 edge、精确安装路径、LICENSE 文件名/hash、原样许可证正文和每版本 `npm view <name>@<version> license --json` stdout/stderr 保存在 `<retained-license-evidence>/`。仅获取 registry 元数据。首次查询在联网前失败，因为 npm 禁止 user/global config 同时使用 /dev/null；原始输出均保留在 `registry-first-attempt/`，显式独立 config 重跑后 101 项全部成功。

## Notice 推理

MIT 是保留 copyright 和 permission notice 的许可授予，不要求把依赖 copyright 改成 CE copyright。ISC 和 BSD-2/3-Clause notice 同样随依赖副本保留；Apache-2.0 grok-mermaid 保留自己的 LICENSE 和适用 NOTICE（package root 无 NOTICE）。这些是兼容且独立的依赖许可证，没有重新许可为 CE MIT。除两个 @earendil-works 项外，已安装依赖均带自身 notice；这两项精确版本制品省略正文，属于上游打包遗漏，详见三层证据。TypeScript build 生成 CE module，采用外部 bare import；npm pack 不捆绑依赖实现/资产。因此 CE tarball 目前没有第三方代码副本需要额外 CE notice。未来若捆绑或重分发已安装树，须保留各项适用 license/copyright/NOTICE，并重新审计制品。

已验证兼容表示此非捆绑分发有 registry 声明和许可证正文证据（已安装正文；两个 @earendil-works 项则有精确版本 registry tarball 声明、上游 v1.3.0 tag 根 LICENSE 正文及已证明的适用性）；需要补充声明用于实际捆绑/重分发副本缺 notice 的情况（本次未发现）；确认不兼容需要实际冲突条款（未发现）。证据不足分类现为空。

## 逐项矩阵

| 精确项目 | Registry 许可证 | 已安装 license/notice 文件 | 分类 |
|---|---|---|---|
| `@earendil-works/pi-coding-agent@1.3.0` | MIT | **缺失**（tarball）: 经 tag 验证 `v1.3.0` 根 LICENSE： MIT, (c) 2025 Mario Zechner | 已验证兼容（上游文本省略注记） |
| `@earendil-works/pi-tui@1.3.0` | MIT | **缺失**（tarball）: 经 tag 验证 `v1.3.0` 根 LICENSE： MIT, (c) 2025 Mario Zechner | 已验证兼容（上游文本省略注记） |
| `@hono/node-server@2.1.3` | MIT | LICENSE | 已验证兼容 |
| `@modelcontextprotocol/sdk@1.30.1` | MIT | LICENSE | 已验证兼容 |
| `@narumitw/pi-tui-kit@0.66.0` | MIT | LICENSE | 已验证兼容 |
| `@sinclair/typebox@0.34.52` | MIT | license | 已验证兼容 |
| `accepts@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `ajv@8.20.0` | MIT | LICENSE | 已验证兼容 |
| `ajv-formats@3.0.1` | MIT | LICENSE | 已验证兼容 |
| `body-parser@2.3.0` | MIT | LICENSE | 已验证兼容 |
| `bytes@3.1.2` | MIT | LICENSE | 已验证兼容 |
| `call-bind-apply-helpers@1.0.2` | MIT | LICENSE | 已验证兼容 |
| `call-bound@1.0.4` | MIT | LICENSE | 已验证兼容 |
| `content-disposition@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `content-type@1.0.5` | MIT | LICENSE | 已验证兼容 |
| `content-type@2.1.0` | MIT | LICENSE | 已验证兼容 |
| `cookie@0.7.2` | MIT | LICENSE | 已验证兼容 |
| `cookie-signature@1.2.2` | MIT | LICENSE | 已验证兼容 |
| `cors@2.8.6` | MIT | LICENSE | 已验证兼容 |
| `cross-spawn@7.0.6` | MIT | LICENSE | 已验证兼容 |
| `debug@4.4.3` | MIT | LICENSE | 已验证兼容 |
| `depd@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `diff@9.0.0` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `dunder-proto@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `ee-first@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `encodeurl@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `es-define-property@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `es-errors@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `es-object-atoms@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `escape-html@1.0.3` | MIT | LICENSE | 已验证兼容 |
| `etag@1.8.1` | MIT | LICENSE | 已验证兼容 |
| `eventsource@3.0.7` | MIT | LICENSE | 已验证兼容 |
| `eventsource-parser@3.1.1` | MIT | LICENSE | 已验证兼容 |
| `express@5.2.1` | MIT | LICENSE | 已验证兼容 |
| `express-rate-limit@8.7.0` | MIT | license | 已验证兼容 |
| `fast-deep-equal@3.1.3` | MIT | LICENSE | 已验证兼容 |
| `fast-uri@3.1.8` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `finalhandler@2.1.1` | MIT | LICENSE | 已验证兼容 |
| `forwarded@0.2.0` | MIT | LICENSE | 已验证兼容 |
| `fresh@2.0.0` | MIT | LICENSE | 已验证兼容 |
| `function-bind@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `get-east-asian-width@1.6.0` | MIT | license | 已验证兼容 |
| `get-intrinsic@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `get-proto@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `gopd@1.2.0` | MIT | LICENSE | 已验证兼容 |
| `grok-mermaid@0.2.3` | Apache-2.0 | LICENSE | 已验证兼容 |
| `has-symbols@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `hasown@2.0.4` | MIT | LICENSE | 已验证兼容 |
| `highlight.js@11.12.0` | BSD-3-Clause | LICENSE | 已验证兼容 |
| `hono@4.13.13` | MIT | LICENSE | 已验证兼容 |
| `http-errors@2.0.1` | MIT | LICENSE | 已验证兼容 |
| `iconv-lite@0.7.3` | MIT | LICENSE | 已验证兼容 |
| `inherits@2.0.4` | ISC | LICENSE | 已验证兼容 |
| `ip-address@10.7.3` | MIT | LICENSE | 已验证兼容 |
| `ipaddr.js@1.9.1` | MIT | LICENSE | 已验证兼容 |
| `is-promise@4.0.0` | MIT | LICENSE | 已验证兼容 |
| `isexe@2.0.0` | ISC | LICENSE | 已验证兼容 |
| `jose@6.2.12` | MIT | LICENSE.md | 已验证兼容 |
| `json-schema-traverse@1.0.0` | MIT | LICENSE | 已验证兼容 |
| `json-schema-typed@8.0.2` | BSD-2-Clause | LICENSE.md | 已验证兼容 |
| `marked@18.0.11` | MIT | LICENSE | 已验证兼容 |
| `math-intrinsics@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `media-typer@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `merge-descriptors@2.0.0` | MIT | license | 已验证兼容 |
| `mime-db@1.54.0` | MIT | LICENSE | 已验证兼容 |
| `mime-types@3.0.2` | MIT | LICENSE | 已验证兼容 |
| `ms@2.1.3` | MIT | license.md | 已验证兼容 |
| `negotiator@1.1.0` | MIT | LICENSE | 已验证兼容 |
| `object-assign@4.1.1` | MIT | license | 已验证兼容 |
| `object-inspect@1.13.4` | MIT | LICENSE | 已验证兼容 |
| `on-finished@2.4.1` | MIT | LICENSE | 已验证兼容 |
| `once@1.4.0` | ISC | LICENSE | 已验证兼容 |
| `parseurl@1.3.3` | MIT | LICENSE | 已验证兼容 |
| `path-key@3.1.1` | MIT | license | 已验证兼容 |
| `path-to-regexp@8.4.2` | MIT | LICENSE | 已验证兼容 |
| `pkce-challenge@5.0.1` | MIT | LICENSE | 已验证兼容 |
| `proxy-addr@2.0.8` | MIT | LICENSE | 已验证兼容 |
| `qs@6.16.0` | BSD-3-Clause | LICENSE.md | 已验证兼容 |
| `range-parser@1.3.0` | MIT | LICENSE | 已验证兼容 |
| `raw-body@3.0.2` | MIT | LICENSE | 已验证兼容 |
| `require-from-string@2.0.2` | MIT | license | 已验证兼容 |
| `router@2.2.0` | MIT | LICENSE | 已验证兼容 |
| `safer-buffer@2.1.2` | MIT | LICENSE | 已验证兼容 |
| `send@1.2.1` | MIT | LICENSE | 已验证兼容 |
| `serve-static@2.2.1` | MIT | LICENSE | 已验证兼容 |
| `setprototypeof@1.2.0` | ISC | LICENSE | 已验证兼容 |
| `shebang-command@2.0.0` | MIT | license | 已验证兼容 |
| `shebang-regex@3.0.0` | MIT | license | 已验证兼容 |
| `side-channel@1.1.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-list@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-map@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `side-channel-weakmap@1.0.2` | MIT | LICENSE | 已验证兼容 |
| `statuses@2.0.2` | MIT | LICENSE | 已验证兼容 |
| `toidentifier@1.0.1` | MIT | LICENSE | 已验证兼容 |
| `type-is@2.1.0` | MIT | LICENSE | 已验证兼容 |
| `unpipe@1.0.0` | MIT | LICENSE | 已验证兼容 |
| `vary@1.1.2` | MIT | LICENSE | 已验证兼容 |
| `which@2.0.2` | ISC | LICENSE | 已验证兼容 |
| `wrappy@1.0.2` | ISC | LICENSE | 已验证兼容 |
| `zod@4.6.5` | MIT | LICENSE | 已验证兼容 |
| `zod-to-json-schema@3.25.2` | ISC | LICENSE | 已验证兼容 |

## 制品和剩余发布门禁

新 tarball 含 87 个文件（69 个 dist JS），包含 CE LICENSE、编译 runtime、Pi entry 和 consumer docs。全部归档文件与 CE build/source tree 逐字节比较，未发现捆绑第三方代码/资产。精确清单和 SHA-256 记录于交接报告，没有嵌入制品本身。此前未捆绑的发现不是许可证违规。

排队中的 `.changeset/ce-e2b-ack-mcp.md` 和硬编码 `0.2.0.md` 字面值延期到后续 version PR，本轮未修改。支持认证仍为 Pi 1.3.0 / Node 24.21.0 / macOS arm64（24.22.1 仅历史）。此前 E2E 证据验证过 cloud transport，但未为此新制品重跑或认证；现有草稿 cloud NOT_VERIFIED 标签仍是保守的制品特定门禁。本次变更时许可证证据已闭合；本 delta 独立评审和所有明确 release/publish 授权（push、tag、npm publish、GitHub Release、merge to main）仍需完成。
