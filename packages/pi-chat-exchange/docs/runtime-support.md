# Runtime support and evidence

English | [简体中文](runtime-support.zh-CN.md)

The published npm package `@zieglar/pi-chat-exchange@0.2.0` declares Node `24.21.0 || 24.22.1` and Pi `1.3.0`. Its distribution qualification covered Node `24.21.0`, Pi `1.3.0` and macOS arm64. Node `24.22.1` was admitted but was not part of that distribution qualification. Cloud transport was `NOT_VERIFIED` in that lane. A published package and an admitted runtime are not evidence of successful cloud use.

## Current source

Current-source `package.json` declares Node `>=24.20.0 <=24.22.1`. The Node driver separately checks a candidate runtime, SQLite >=3.51.3, readable source identity, compile safety and shared behavior probes. Internal candidate detection for majors 24/25/26 does not declare all such versions supported. Node `24.19.0` and `25.9.0` are refused after reproduced transaction-close crashes; `24.12.0` and `25.2.1` contain affected SQLite `3.50.4`. Node `26.12.1` remains an isolated preview, outside the formal engines declaration.

Pi host and MCP child qualify independently. `CE_NODE_PATH` chooses the child only; restart Pi under a qualified Node to change its host runtime. A version label or successful UI load does not establish Store admission. The Store also enforces local filesystem policy, ownership, private permissions, symlink restrictions, WAL/FULL and integrity/migration rules. In-memory probes do not establish disk locking or crash/power-loss durability.

## Native and platform scope

Native `ce-sqlite-v0.1.0` uses ABI `1` and bundled SQLite `3.54.1`, with immutable release source `a8386aafd657c84825b2905847f34a43d5b91e1e`. Native admission checks the actual module, Node-API >=8, SQLite identity, compile options and behavior. Production pins remain `null`, so default prepare/load refuses unpinned binaries. Default selection is `node-sqlite`; Rust selection never silently falls back.

| Platform | Native artifact/conformance | Hosted Native Store integration |
|---|---|---|
| macOS arm64 | Verified | Verified |
| Linux x64 GNU | Verified | Verified |
| macOS x64 | Verified | Not established |
| Linux arm64 GNU | Verified | Not established |

The Store allowlist is macOS arm64 / Linux x64. This matrix does not expand npm 0.2.0 certification or prove all Pi/ChatGPT clients, cloud connections or power-loss behavior. Automated tests, release verification and manual use have separate scopes.

For installation and refusal handling, see [getting started](getting-started.md), [operations](operations.md) and [Native SQLite](native-sqlite.md). Runtime facts come from `package.json`, `src/storage/runtime.ts`, `src/storage/native-compat.ts`, `src/runtime/executables.ts` and the runtime/conformance tests. Check actual loaded code before applying source-only claims to a published artifact.
