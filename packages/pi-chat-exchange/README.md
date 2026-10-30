# Pi Chat Exchange

English | [简体中文](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/README.zh-CN.md)

Pi Chat Exchange (CE) lets ChatGPT and Pi exchange durable messages through explicit tools. Use it to pass a question, plan or result between the two applications while choosing which messages each side may read. Sending a message does not authorize a task or prove completion.

<a id="当前能力与典型用法"></a>

## Features

- SQLite-backed messages, scoped idempotency keys and audit evidence.
- Authorized inbox discovery, separate metadata/payload access, and optional reception receipts (ACKs).
- Explicit Pi Session binding and multi-session registration.
- Secure MCP Tunnel management and a separate ChatGPT Desktop stdio connection.
- Rust Native SQLite with pinned trust and explicit installation/readiness commands.

## Requirements and support

Use **Pi 1.3.0**, **Node >=22.19.0** and a Store-supported platform: **macOS arm64 or Linux x64 GNU**. Filesystem, ownership and runtime admission checks still apply. Other Native artifacts do not establish Store support; Windows Native is unsupported and WSL2 integration remains unverified.

Version **0.2.1** is published on npm. An actual Registry installation passed isolated Pi 1.3.0 / Node 22.19.0 loading and persistence checks on macOS arm64. Linux x64 Native checks passed 227/227 on Node 22.19.0 and 24.22.2. **Real Cloud transport and the complete ChatGPT ↔ Pi exchange remain unverified.** See [runtime support](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/runtime-support.md) for the tested matrix and limits; the engine range is not exhaustive qualification.

This working tree prepares local candidate **0.2.2**. Explicit `CE_TUNNEL_CLIENT_PATH` delegates trust to a user-managed client installation, including group-writable Homebrew ancestors; automatic discovery stays strict. Installation writers may replace a program that can run as you and read Tunnel credentials. Local admission/Doctor evidence covers **0.0.16**; official **0.0.18 is not CE runtime-qualified**. Install the candidate tarball with npm into a dedicated prefix, then register the installed package directory with Pi; see Getting started. This is not a Registry installation. The npm command below still selects published 0.2.1 and its old admission rules.

<a id="安装-pi-扩展"></a>
<a id="选择连接方式"></a>

## Quick start

With Pi already installed, run in your **system terminal**:

```sh
pi install npm:@zieglar/pi-chat-exchange@0.2.1
pi list
pi
```

In the **Pi TUI**, run `/ce-native status`. If the trusted driver is missing, run `/ce-native install`, then exit and restart Pi. Check `/ce-native verify` reports `READY` before messaging. Native binaries are not bundled in npm; CE never downloads them automatically or falls back to `node:sqlite`.

Continue with **[Getting started: installation to your first exchange](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/getting-started.md)**. It covers the separately trusted Tunnel client, parent environment, explicit Setup messaging grants, `/reload` → activate → Start, exact recipient labels, payload reads and safe Stop. Setup Save alone does not authorize messaging; activation does not start transport. The [Desktop stdio guide](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/chatgpt-installation.md) describes the separate local connection.

Before upgrading an existing installation, stop the owned Tunnel and verify `STOPPED`, release affected local bindings, then exit affected Pi hosts. Preserve the Store and credentials; do not delete ownership or lock files to force an upgrade.

<a id="多项目多-session"></a>
<a id="边界与验证"></a>

## Limits and safe operation

CE does not automatically schedule tasks or drain inboxes. A shared ChatGPT endpoint does not isolate conversations. Payload reads and ACKs require their own grants; payload text is untrusted data and may enter model history.

ACK records reception only, not delivery, reading, processing or task completion. CE provides no exactly-once delivery/execution guarantee. `DELIVERY_UNKNOWN != CANCELLED`; missing ACK or timeout does not authorize blind retry or a new-key resend. Keep the original Message ID/key and inspect evidence first.

Closing Manager or exiting Pi does not stop the detached Tunnel client. Use `/ce-tunnel stop`, then `/ce-tunnel status` to verify `STOPPED`. Keep credentials and capabilities out of messages, screenshots and reports.

<a id="阅读导航"></a>

## Documentation

- [Native management](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-management.md) and [Native SQLite](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-sqlite.md).
- [Tunnel setup and troubleshooting](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/tunnel-setup.md).
- [Multiple Sessions](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/multi-session-usage.md), [Pi tools](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/pi-extension/README.md) and [ACK contract](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/delivery-ack-contract.md).
- [Operations / source development](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/operations.md). The prebuilt npm install needs no repository or compiler.
- [Independent Host / tarball installation](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/independent-install.md), with current0.2.1 alternatives and a separate historical0.2.0 record.
- [Architecture](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/architecture.md), [storage security](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/storage-security.md) and [bilingual documentation index](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/documentation.md).

## License

[MIT](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/LICENSE), Copyright (c) 2026 zieglar. Dependencies retain their own licenses; see the [license audit](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/licenses.md).
