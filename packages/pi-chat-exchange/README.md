# Pi Chat Exchange

English | [简体中文](README.zh-CN.md)

Pi Chat Exchange (CE) lets ChatGPT and Pi exchange durable messages through explicit tools. It stores messages, provides an authorized inbox, separates metadata from payload access, and records reception receipts (ACKs). Sending a message does not authorize its execution or prove task completion.

<a id="当前能力与典型用法"></a>

## Features

- SQLite-backed messages with scoped idempotency keys and audit evidence.
- Independent permissions for sending, discovering messages, reading payloads and recording ACKs.
- Stable endpoints for individual Pi sessions, with explicit registration, activation, deactivation and revocation.
- Secure MCP Tunnel management, plus a separate Desktop stdio plugin path.
- A built-in `node:sqlite` driver and an explicitly selected Rust Native driver in the current source tree.

CE does not provide automatic task scheduling, inbox draining or exactly-once delivery/execution. `DELIVERY_UNKNOWN != CANCELLED`; a missing ACK does not justify retrying an operation.

## Requirements and support

The published npm package is **`@zieglar/pi-chat-exchange@0.2.0`**. Its historical distribution qualification covers **Node 24.21.0 / Pi 1.3.0 / macOS arm64**. Cloud transport was **NOT_VERIFIED** in that qualification. The current source declares Node **`>=24.20.0 <=24.22.1`**, with additional runtime/SQLite checks; source qualification does not change the published artifact.

| Platform | Current Native evidence | Scope |
|---|---|---|
| macOS arm64 | Artifact/conformance and Store integration | Does not certify every client or cloud workflow |
| Linux x64 GNU | Artifact/conformance and Store integration | Does not extend npm 0.2.0 distribution certification |
| macOS x64 | Artifact/conformance only | Store integration not established |
| Linux arm64 GNU | Artifact/conformance only | Store integration not established |

The Store allowlist remains macOS arm64 / Linux x64. Runtime admission also checks SQLite behavior, filesystem safety and ownership. See [Native SQLite](docs/native-sqlite.md) and [runtime qualification](docs/runtime-support.md).

<a id="安装-pi-扩展"></a>

## Installation and upgrades

Use an approved Node executable to run Pi **1.3.0**, then install the exact published version:

```sh
node --version
pi install npm:@zieglar/pi-chat-exchange@0.2.0
pi list
```

This is Pi's managed npm source syntax; it is not a standalone `ce` command. Extensions run with your user permissions. Review the package and its source before installation. Registry publication proves availability, not successful cloud setup on your machine.

For a prebuilt tarball or a dedicated host prefix, follow [independent installation](docs/independent-install.md). Before upgrading, stop the owned Tunnel, confirm `STOPPED`, deactivate affected bindings, and exit affected Pi hosts. Preserve the Store and credentials; check schema compatibility before rollback. Never delete ownership or lock files to force an upgrade.

<a id="选择连接方式"></a>

## Quick start

Start Pi under the approved Node runtime. In the interactive session:

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Setup must explicitly grant messaging to the current session under Advanced · Messaging. Saving transport settings alone does not authorize messaging. A first reload can refuse a missing mapping; explicitly activate after setup. Activation does not start transport.

A real Tunnel needs a separately trusted client, a configured ChatGPT connection, the parent process opt-in `CE_TUNNEL_BACKGROUND_ALLOW=1`, and an explicit `/ce-tunnel start`. Follow [getting started](docs/getting-started.md) and [Tunnel setup](docs/tunnel-setup.md). The Desktop stdio route has separate [installation steps](docs/chatgpt-installation.md).

## Configuration

Use the setup UI to write private configuration. `CE_TUNNEL_PROFILE` selects an absolute profile **file** path, `CE_NODE_PATH` selects the MCP child's qualified Node executable, and `CE_TUNNEL_CLIENT_PATH` selects a trusted absolute client executable. Neither child selection nor a version label qualifies the already running Pi host.

Payload reads and ACKs require separate grants. Keep credentials in the operator-owned credential files; do not place them in messages, screenshots or issue reports. See [configuration and commands](docs/getting-started.md) and the [Pi extension reference](pi-extension/README.md).

<a id="多项目多-session"></a>

## Commands and message workflow

| Command/tool | Purpose |
|---|---|
| `/ce-status` | Inspect the current Pi/CE identity and ownership state |
| `/ce-tunnel doctor` | Inspect installation/runtime qualification without starting transport |
| `/ce-tunnel start`, `/ce-tunnel stop`, `/ce-tunnel status` | Explicitly manage and inspect the owned transport |
| `/ce-tunnel sessions`, `register`, `convert`, `revoke` | Manage session registration under the documented policy |
| `/ce-tunnel activate`, `/ce-tunnel deactivate` | Bind or normally release the current session |
| `ce_send`, `ce_inbox_list`, `ce_read` | Send, discover and inspect message metadata |
| `ce_read_payload`, `ce_ack` | Separately authorized payload access and reception receipt |

For a received message, discover its ID, read metadata, request payload access only when needed, and record an ACK only under its separate grant. A reply is a new Message. ACK means reception receipt; it does not establish delivery, read, processing or completion. See [multi-session usage](docs/multi-session-usage.md) and the [ACK contract](docs/delivery-ack-contract.md).

## Architecture and responsibilities

Wayforge owns governed tasks, policy, recovery and completion authority. CE owns message delivery/lifecycle rules, durable evidence and reconciliation. Pi owns sessions, runtime and provider transport. CE's adapters use the same Host/Storage authority; tool labels and model claims cannot grant permissions.

Recovery markers are not locks or fencing tokens. Changing models must not replay a task that has already produced effects. See [architecture](docs/architecture.md) for component responsibilities and the distinction between implemented messaging tools and the broader protocol model.

## SQLite Native driver

The independent immutable Native Release is [**`ce-sqlite-v0.1.0`**](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0), with ABI **1**, bundled SQLite **3.54.1**, and source SHA **`a8386aafd657c84825b2905847f34a43d5b91e1e`**. It is separate from npm 0.2.0 and its binaries are not bundled in npm.

Current production Native trust pins remain **`null`**. Publication does not enable the driver: default prepare/load refuses unpinned assets, and the default stays `node-sqlite`. An operator-supplied manifest is a separate executable-code trust decision. There is no silent fallback after choosing Rust. See [Native preparation and verification](docs/native-sqlite.md).

<a id="边界与验证"></a>

## Security and troubleshooting

Configured, Pi-bound, connected and demonstrated message exchange are different states. Transport health does not prove message authority. Unknown outcomes remain unknown until evidence resolves them; do not retry blindly, take over an owner or delete the Store.

Start with [operations and troubleshooting](docs/operations.md). Share error codes and redacted metadata, never payloads, credentials, capabilities or full raw logs. Detailed boundaries are in [protocol v2](docs/protocol-v2.md), [ownership](docs/ownership-contract.md), [storage](docs/storage-contract.md) and [storage security](docs/storage-security.md).

<a id="阅读导航"></a>

## Development and contribution

From the repository root, with the qualified Node runtime and pnpm **12.9.1**:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

The extension imports `dist/`. Rebuild after source edits; `/reload` does not compile TypeScript. Optional client and real-host tests need their documented prerequisites and are separate from default tests. Follow [development and release operations](docs/operations.md) and the [bilingual documentation guide](docs/documentation.md).

The npm Trusted Publishing workflow is implemented locally but has not been pushed or verified through a hosted OIDC publish. The maintainer reports its npm publisher connection configured. This is distinct from the published npm 0.2.0 artifact and the verified Native Release.

## License

[MIT](LICENSE), Copyright (c) 2026 zieglar. Dependencies retain their own licenses; see the [license audit](docs/licenses.md).
