# Runtime support and evidence

English | [简体中文](runtime-support.zh-CN.md)

The published npm package `@zieglar/pi-chat-exchange@0.2.0` is unchanged. Its historical distribution qualification covered Node `24.21.0`, Pi `1.3.0` and macOS arm64, with cloud transport `NOT_VERIFIED`. Current-source Native behavior and the Host minimum below do not expand that published artifact’s qualification.

## Current source

Current-source `package.json` declares Node `>=22.19.0`, matching the actual installed Pi 1.3.0 Host manifest. This is a Host minimum, not a promise that every Node 22 or later build, Node 25 or Node 26 is qualified.

Native is the target default driver. With no selection file, CE selects `rust-native` at `NATIVE_COMPAT.defaultVersion` (currently `0.1.0`). `node-sqlite` is retained only as an explicitly selected, lazily loaded, nonproduction compatibility driver. Native load or trust failure fails closed; Node is never a fallback.

Native uses bundled SQLite `3.54.1`, independently of `process.versions.sqlite`. Admission checks Node-API >=8, the actual module, ABI, target, trusted cache, SQLite identity, compile options and behavior. The built-in `node:sqlite` version/known-defect restrictions apply only to explicit compatibility selection. Driver-specific hard constraints remain in force, including the SQLite safety floor and shared probes.

The following results were rerun on local Darwin arm64 against the current Native-default candidate. CI-list denotes the selected CI test list executed locally, not hosted CI.

| Runtime | Local Native evidence |
|---|---|
| Node 22.19.0 | Real Native status and CI-list 209/209; native-default 9/9 |
| Node 24.22.2 | Full Rust suite: 1030 passed, 4 skipped; CI-list 209/209 |
| Node 24.19.0 / 25.9.0 | Earlier run: 1009 passed, 2 failed, 4 skipped; failures are Node-driver-only tests |
| Node 25.2.1 | Current run: 1027 passed, 3 failed, 4 skipped; failures are explicit Node-driver tests and a built-in SQLite lock-fixture stderr expectation |
| Node 26.12.1 | Scenario probes only: real Store, zero `node:sqlite` calls; no full suite |

Pi 1.3.0 installed-Host first runs passed on Node 22.19.0, 24.22.2, 25.2.1, 25.9.0 and 26.12.1: each resolved the real Native binary, had zero `node:sqlite` resolutions, and passed installation, Host load, first run and profile/policy/mutex/store checks. These are isolated offline runs; cloud transport and Native remove/reinstall remain unverified. The new Linux x64 Native CI job specifies Node 22.19.0 / 24.22.2, but its hosted execution is UNVERIFIED. These local results do not establish all-version compatibility, cloud qualification or production enablement.

Pi Host and MCP child qualify independently. `CE_NODE_PATH` selects only the child; changing the Host requires restarting Pi. Store filesystem policy, ownership, private permissions, symlink restrictions, WAL/FULL, integrity and migration checks still apply. In-memory probes do not establish disk locking or crash/power-loss durability.

## Native and platform scope

Native `ce-sqlite-v0.1.0` uses ABI `1` and bundled SQLite `3.54.1`, with immutable release source `a8386aafd657c84825b2905847f34a43d5b91e1e`. Native admission checks the actual module, Node-API >=8, SQLite identity, compile options and behavior. Production pins remain `null`, so default prepare/load refuses unpinned binaries. Native default and production pins must ship as one publish unit after separate pin authorization. With pins still null, the default build cannot be released and production is not enabled.

| Platform | Native artifact/conformance | Hosted Native Store integration |
|---|---|---|
| macOS arm64 | Verified | Verified |
| Linux x64 GNU | Verified | Verified |
| macOS x64 | Verified | Not established |
| Linux arm64 GNU | Verified | Not established |

The Store allowlist is macOS arm64 / Linux x64. This matrix does not expand npm 0.2.0 certification or prove all Pi/ChatGPT clients, cloud connections or power-loss behavior. Automated tests, release verification and manual use have separate scopes.

For installation and refusal handling, see [getting started](getting-started.md), [operations](operations.md) and [Native SQLite](native-sqlite.md). Runtime facts come from `package.json`, `src/storage/runtime.ts`, `src/storage/native-compat.ts`, `src/runtime/executables.ts` and the runtime/conformance tests. Check actual loaded code before applying source-only claims to a published artifact.
