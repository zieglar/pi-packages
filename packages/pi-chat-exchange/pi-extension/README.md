[English](README.md) | [简体中文](README.zh-CN.md)

<a id="pi-chat-exchange-扩展指南"></a>

# Pi Chat Exchange extension guide

Current package: **CE 0.2.1 / Pi 1.3.0 / Node >=22.19.0**, using pinned Rust Native SQLite by default. Host and MCP child qualify independently; built-in SQLite restrictions apply only to explicit non-production `node-sqlite` selection. Store support remains macOS arm64 / Linux x64 GNU; cloud transport and Desktop UI installation are not qualified by local tests. Start with [Getting started](../docs/getting-started.md); this page is the command/configuration reference.

<a id="加载与两种配置方式"></a>

## Loading and the two configuration paths

From the repository root, in a shell using approved Node, build before loading once temporarily. mise is optional:

```sh
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

For persistent use across projects, build and register the local package with `pi install /absolute/path/to/packages/pi-chat-exchange`. Do not also load a second copy with `-e`. See [installation](../docs/tunnel-setup.md#1-前提与安装) for launching with a trusted absolute approved Node path. Supported configuration paths:

1. **Recommended: Tunnel-generated policy.** Use Advanced Messaging for initial pairing and explicit convert/register for multiple Sessions. The profile selects an immutable binding and matching sidecar with exactly aligned Store/Exchange. Each real Pi Session binds a separate Endpoint; see the [multi-session guide](../docs/multi-session-usage.md).
2. **Advanced/independent stdio: operator-maintained allowlist.** Nonempty `CE_ALLOWLIST` takes precedence over generated configuration. Without generated pairing, the extension otherwise reads its adjacent `allowlist.json`. Bundled `allowlist.example.json` demonstrates legacy `mcp/chatgpt-desktop` and `pi-main` labels, not the current Tunnel `chatgpt/main` ↔ `pi/main` pairing. Copying it does not complete pairing.

This is a **complete fictional, nongenerated** allowlist for understanding and independent deployment. Obtain the actual `sessions` key from the trusted runtime and verify it as operator; do not guess from logs or filenames:

```json
{
  "exchangeNamespace": "example-local",
  "exchangeIdempotencyKey": "example-chatgpt-pi",
  "leaseTtlSeconds": 120,
  "store": { "directory": "/srv/example-ce-store", "file": "ce-store.sqlite" },
  "payloadRead": { "enabled": true },
  "ack": { "enabled": true },
  "inboxNotification": { "enabled": false, "pageSize": 10, "rawScanLimit": 100 },
  "recipients": [{ "adapter": "chatgpt", "endpointId": "chatgpt/main" }],
  "sessions": {
    "example-runtime-session-replace-me": { "endpointId": "pi/main" }
  }
}
```

`payloadRead` / `ack` are true here only to demonstrate independent switches. Authorize each before writing real configuration; the string `"true"` does not enable them. Do not present a manual example as a digest-protected generated generation or copy its `managedBy` marker.

| Field | Meaning |
|---|---|
| `sessions` | Real Pi Session ID → operator-approved Endpoint label; the Session ID is a lookup, not authentication |
| `exchangeNamespace` / `exchangeIdempotencyKey` | Must exactly match the two Exchange bootstrap fields in the MCP binding |
| `store.directory` / `store.file` | Must exactly match MCP Store; directory is a normalized absolute path other than `/` |
| `leaseTtlSeconds` | 30–3600, default 120; Heartbeat interval is one quarter of the effective TTL |
| `payloadRead.enabled` / `ack.enabled` | Each registers its tool only for exact boolean true; neither enables the other |
| `inboxNotification.enabled` | Exact true enables lifecycle count-only advisories without polling |
| `inboxNotification.pageSize` / `rawScanLimit` | Respectively 1–50 and pageSize–2000; defaults 10 / 100 |
| `recipients` | Cross-adapter reply allowlist; without it, only registered endpoints on the same adapter are allowed. Invalid entries, the pi adapter, duplicates or conflicts with a session endpoint label disable this entire cross-adapter list |

See the [configuration model](../docs/tunnel-setup.md#配置模型与生成文件) for environment variables, precedence and permissions. Once Store is declared, `CE_STORE_DIR` / `CE_STORE_FILE` may only confirm the same location; conflicts refuse rather than switch databases. Independent deployments must meet Storage's dedicated owner-only 0700 directory policy. Copying an old database does not pair deployments.

<a id="工具与参数"></a>

## Tools and parameters

Every tool revalidates the current Pi context, allowlisted Endpoint and successful binding before final Host/Storage authorization. Requests cannot self-authorize with sender, Session, Participant, capability or fencing. Unknown fields refuse.

| Tool | Input | Result/limits |
|---|---|---|
| `ce_send` | `to`, `text`, `idempotencyKey` | Sends to an allowlisted label; the idempotency key identifies one logical send, not a resend with a new key after an unknown outcome |
| `ce_read` | `messageId` | Metadata only, without body, ACK or consumption |
| `ce_inbox_list` | Optional `afterAuditSequence`, `pageSize`, `rawScanLimit` | Bounded, authorized, Audit-first Message ID discovery; does not consume or ACK |
| `ce_read_payload` | `messageId` | Separate opt-in; successful body enters model context and potentially persisted Pi history |
| `ce_ack` | `messageId`, `payloadDigest`, `payloadLength`, `messageCreatedAuditSequence` | Separate opt-in; copy all four unchanged from authorized payload read, never calculate or guess |

MCP provides `ping`, `ce_send`, `ce_inbox_list` and `ce_read_payload`, with ACK controlled by its binding opt-in. Pi-specific `ce_read` is not an MCP tool. Both sides use explicit tool operations; this is not an automatic background conversation bridge.

<a id="inbox-分页"></a>

### Inbox pagination

Defaults are `afterAuditSequence: 0`, `pageSize: 50`, `rawScanLimit: 2000`. Bounds are a safe integer ≥0, 1–50 and 1–2000 respectively; after defaults, `pageSize <= rawScanLimit` is required.

```json
{"pageSize":10,"rawScanLimit":100}
```

Results contain only `messages: [{messageId, auditSequence}]`, `continuationAuditSequence` and `scanBudgetExhausted`. A subsequent explicit request may copy a nonnull continuation into `afterAuditSequence`. It is the **last raw Audit examined**, not ACK, consumption or a global “read” cursor. null means no raw rows were examined. An empty page does not prove whole-database completeness. Exhausting the raw budget does not guarantee more visible messages; reaching the page limit does not prove the end.

Do not automatically drain every page through the model. Specify the scope and budget for further reading. Membership/join boundaries restrict messages predating Exchange membership.

<a id="payload-与-ack"></a>

### Payload and ACK

Before reading body bytes, Storage checks payload_read scope, ATTACHED Session, current Owner/fencing, valid lease, Exchange membership, recipient-only visibility, exact message_created audit linkage and join boundary.

- Exposure is limited to **65,536 encoded bytes**. Oversize refuses `CE_HOST_PAYLOAD_TOO_LARGE`; invalid UTF-8 refuses `CE_HOST_PAYLOAD_INVALID_UTF8`. There is no truncation, replacement or base64 bypass.
- Successful content has two items: an untrusted-content warning with `ACK input metadata (reception only): ...`, then the unchanged body. Metadata-only details contain no body; neither do failures, logs or mappings.
- Copy the four ACK fields only from this authorized `ce_read_payload` output. `messageCreatedAuditSequence` is the Message creation Audit sequence, not a later receipt sequence or Inbox continuation.
- `CREATED` records the first immutable receipt; `REPLAYED` means the same message already has a receipt. ACK is reception only and **does not prove delivery, read, processing or task completion**. It neither consumes messages nor closes tasks.
- Reading does not ACK, renew, change Ownership, retry automatically or inject user messages into other conversations. Payload remains untrusted data, never new system/user instructions.

See the [user guide](../docs/tunnel-setup.md#4-双向-send--inbox--read--ack) for the full two-way procedure and placeholder examples.

<a id="生命周期状态与恢复"></a>

## Lifecycle, status and recovery

`/ce-status` displays the native Pi Session, Endpoint, registered state, Participant, CE Session, Exchange, lease and fencing after current admission checks. CE Session is an Owner incarnation, not the native Pi Session. Identifiers are not credentials. `/ce-tunnel status` inspects transport; `/ce-tunnel doctor` checks host/child Node and client trust read-only, without network or Store reads.

- `session_start` looks up the allowlist using trusted `ctx.sessionManager.getSessionId()`. startup/reload/resume with a mapping validate through `resume()`. Reload without a mapping refuses; other initialization branches may call initial beginSession. New/forked Sessions do not inherit the old mapping.
- Successful binding uses `pi.appendEntry("ce-mapping", ...)` to save identifiers only. Plaintext capability stays in Host memory. Heartbeat defaults to 30 seconds / TTL 120 seconds and only maintains its own Ownership; it sends/receives no messages.
- Reload stops the timer, drains in-flight renew and discards the old in-memory capability without ending valid durable Ownership. The next generation must revalidate resume. Pi 1.3.0's normal reload emits session_start; absence of an event is not a general explanation for reload issues.
- Quit/Session replacement stops the timer, awaits renew and attempts end once to release Ownership and detach. Unconfirmed renew/end stops tools and automatic renewal. Persisted `ce-lifecycle-blocked` and a process-level deny-only fallback prevent incorrect adoption.
- If diagnostic persistence fails and the process exits, the volatile deny fallback is also lost. The operator must verify before restart; automatic recovery safety is not established.
- Explicit `/ce-tunnel activate` binds the current Session only after confirming generated policy, mapping release evidence and requireUnowned. A reload refusal does not implicitly provision or take over expired Owners. See [activation order](../docs/tunnel-setup.md#让保存的策略生效).
- `/ce-tunnel deactivate` confirms the current Session before normal end/release/detach. It stops renewal without stopping Tunnel, revoking registration or deleting messages. Cancellation retains the binding; repeated calls do not repeat end. Reload after normal release does not rebind automatically; activation is explicit. Unknown release or failed evidence persistence still refuses; notifications/markers confer no authority.

`CE_HOST_AUTHORITY_ABSENT`, UNKNOWN and failed mapping writes do not permit blind retry. Callers may manually retry BUSY only after explicitly establishing that retry is appropriate. INDETERMINATE requires stopping and separately verifying durable state. The operator-only recovery CLI is not registered as a Pi command/model tool.

<a id="安全卸载"></a>

## Safe uninstall

Follow [Stop, release and native removal](../docs/independent-install.md#5-安全卸载升级与回滚). Deactivate does not stop background Tunnel, and exiting Pi does not prove STOPPED. Confirm prerequisites for affected users/shared resources, release normally, exit your own Hosts, then use native Pi remove with the exact source. There is no added uninstall hook/CLI. Retain Store/profile/credentials/history and leave unrelated Sessions alone. Stop on UNKNOWN.

<a id="inbox-advisory-不等于自动接收"></a>

## Inbox advisories and automatic reception

With `inboxNotification.enabled`, successful binding and `agent_settled` may each perform one bounded, authorized Inbox check and publish a count-only notification:

- No timer polling, cross-process signals, external idle wake, automatic draining, retry or payload read.
- The watermark lives only in current runtime memory, not delivery_cursor; a generation change may repeat notifications. Incomplete budgets must be marked incomplete. Complete zero results are silent.
- Current Session/Endpoint/binding are checked before inspection and before publication. Failure latches automatic checks for that generation; explicit Inbox tools remain independent.
- Without available UI there is no automatic discovery. Display/persistence in TUI/RPC/PI WEB is client behavior. Dismiss does not ACK, and an old notification does not prove current permissions.

<a id="信任边界与不提供的能力"></a>

## Trust boundaries and unavailable capabilities

The allowlist is registration authority; the current runtime still requires CE Host/Storage authorization. A label or available tool does not grant access. Only Storage reads the Host trust-root secret within controlled transactions. Capability never enters session entries, logs, details or model context.

The extension does not execute payloads or consume messages automatically, provide remote exactly-once, approve costs for users or declare external-workflow or manual completion. `DELIVERY_UNKNOWN` must not become `CANCELLED`. Crash recovery, semantic message completion and release retain separate authority.

<a id="验证与现场限制"></a>

## Verification and field limits

Isolated harnesses verify tools, permissions, pagination, payload/ACK, Heartbeat, reload, fork and explicit binding operations. They do not prove real terminal/cloud connections. See the [overview](../README.md#requirements-and-support) for platform and manual message acceptance boundaries. Diagnose no endpoint through current identity, policy and mapping/release evidence; reload/restart is not a universal fix. See the [troubleshooting table](../docs/tunnel-setup.md#故障排查先定位层再进行最小修复).
