[English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

# Getting started

## 1. What is Pi Chat Exchange?

Pi Chat Exchange (CE) lets ChatGPT and Pi exchange durable messages through explicit tools. ChatGPT calls the local MCP server through Secure MCP Tunnel; both endpoints use the same private SQLite Store. You choose when to send, discover or read a message. A message does not authorize a task or prove its completion.

This guide covers the **0.2.2 local release candidate** and one ChatGPT ↔ Pi pair. The current published npm version is **0.2.1**; its immutable package does not include the explicit Homebrew path fix. Install the reviewed local tarball below for this candidate. The separate [Desktop stdio connection](chatgpt-installation.md) does not need Tunnel. The [compatibility matrix](../compatibility/README.md) records 0.0.19 macOS arm64 legacy-identity manual bidirectional Cloud E2E separately from Linux x64 synthetic lifecycle checks. **Real namespaced Cloud and 0.0.18 remain NOT_VERIFIED.** Independent latest monitoring and actual same-run publication integration remain NOT_VERIFIED.

Managed profiles explicitly set `MCP_STDIO_FAILURE_POLICY=exit`, overriding an inherited restart policy. With 0.0.19, an MCP child failure exits the client instead of restarting the child. CE does not respawn it, take over ownership or retry messages; inspect ownership and use explicit operator recovery before restarting. Compatibility is limited to the exact matrix entries, including historical older-client scope.

## 2. Requirements

- Pi **1.3.0**, with its `pi` command available in your system terminal. Use an interactive Pi TUI for Setup and confirmation dialogs.
- Node **>=22.19.0** for both Pi and its MCP child. Tested versions and limits are in [runtime support](runtime-support.md); the version range is not proof that every later release has been tested.
- **macOS arm64 or Linux x64 GNU**, with a local filesystem accepted by the Store. Other Native artifacts do not establish Store support. Windows Native is unsupported; WSL2 integration is unverified. Keep any WSL Store on its Linux filesystem, not `/mnt/c`.
- A separately installed `tunnel-client` that you trust. Install the official latest stable from the [official Tunnel installation guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [official releases](https://github.com/openai/tunnel-client/releases), then check its exact version/source against the [compatibility matrix](../compatibility/README.md). Pinned CI 0.0.19 is a regression target, not an installation requirement or proof for later versions. CE does not install, upgrade or audit the client.
- A Tunnel, its authorized credential, and a ChatGPT workspace/account eligible for that Tunnel. Cloud permissions and current UI steps follow the [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). CE does not create these cloud resources.

Use non-sensitive text for the first exchange. Extensions run with your user permissions; review the package before installing it. Keep credentials out of prompts, shell history, screenshots and messages.

## 3. Install

**System terminal**, outside Pi:

```sh
node --version
pi --version
npm install --prefix /absolute/path/to/ce-rc-prefix --omit=dev --ignore-scripts /absolute/path/to/zieglar-pi-chat-exchange-0.2.2.tgz
pi install /absolute/path/to/ce-rc-prefix/node_modules/@zieglar/pi-chat-exchange
pi list
```

Replace both paths with your reviewed artifact and a dedicated installation prefix. Then `pi install` registers the installed package directory, not the `.tgz` itself. Success: `pi list` shows that directory, and its installed manifest is `@zieglar/pi-chat-exchange` version `0.2.2`. This is a local artifact installation, **not a Registry installation**. Do not compile in the consumer or also load it with `-e`. Published 0.2.1 remains available as `npm:@zieglar/pi-chat-exchange@0.2.1`, with its older client admission policy.

Before launching Pi for this guide, set these variables in the **same system terminal**. Replace the two executable paths with trusted, normalized absolute paths on your machine:

```sh
export CE_NODE_PATH=/trusted/node-install/bin/node
export CE_TUNNEL_CLIENT_PATH=/opt/homebrew/bin/tunnel-client
export CE_TUNNEL_BACKGROUND_ALLOW=1
pi
```

`CE_NODE_PATH` selects the MCP child; Pi itself must already run under the supported Node. The background opt-in permits a later explicit Start and does not start anything. Setting variables in a child shell inside Pi cannot update the parent Pi process. Leave `CE_TUNNEL_OFFLINE_TEST` unset for ordinary use.

Setting `CE_TUNNEL_CLIENT_PATH` is your explicit trust delegation to that external program and its installation writers. CE accepts group-writable ancestor directories in this mode, without an extra confirmation/database; automatic discovery remains strict. Other effective writers may replace the program, and malicious client code can run as you and read the Tunnel credential. This does not remove check-to-execution races. File/world-write, owner, macOS ACL and project-path refusals still apply. Use your actual absolute client path; the Homebrew example is not a whitelist.

If you already have CE configuration or a running Tunnel, follow the existing-installation precautions in step 5 before changing it. For a dedicated Host prefix, tarball installation or source development, use the [advanced documentation](#10-advanced-documentation).

## 4. Prepare Native

**Pi TUI**:

```text
/ce-native status
```

If the state is `MISSING`, explicitly install the pinned Native driver:

```text
/ce-native install
```

Success: the command reports that the trusted version was installed and selected. **Exit Pi normally, then restart it from the prepared system terminal.** Installation requires a Pi restart; `/reload` alone is not the documented substitute. In the restarted Pi TUI:

```text
/ce-native verify
/ce-tunnel doctor
```

Success: Native reports `READY` / `CE_NATIVE_READY`. Doctor separately reports host Node, MCP child Node and client path trust without starting the client or testing cloud authentication. Resolve missing/untrusted executable diagnostics before Start; see [client path diagnostics](tunnel-setup.md#client-安装与只读诊断).

Native is the only default persistence driver. If it is missing or untrusted, Pi and management commands remain available, while Store, messaging and Tunnel Start refuse. CE never automatically downloads, repairs, upgrades or falls back. For `UNTRUSTED` or other states, use [Native management](native-management.md); do not delete the Store or select a compatibility driver to bypass a refusal.

## 5. Configure Tunnel

Keep using the **same Pi Session** from Setup through activation and the first exchange. A new Session is a different identity.

For an existing installation, first `/ce-tunnel stop`, then `/ce-tunnel status` and verify `STOPPED`. If the current Pi Session holds an old CE binding, `/ce-tunnel deactivate` and confirm normal release before changing configuration. `UNKNOWN` is not stopped; investigate it using [Tunnel troubleshooting](tunnel-setup.md). Skip these cleanup actions on a fresh installation with no existing binding or transport.

**Pi TUI**:

```text
/ce-tunnel setup
```

1. Enter the real Tunnel ID and, if required, Organization ID. Enter the authorized credential only in the masked input. Existing installations can choose **Keep existing credential**.
2. At Review, choose **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi) → Authorize messaging for this session**.
3. Check the displayed current Pi Session and endpoint pair: `chatgpt/main` ↔ `pi/main`. This action grants sending between these endpoints and enables **payload read and ACK on both sides**. It replaces an Advanced recipient list with the Pi endpoint. Proceed only if those grants are intended.
4. Choose **Back · Review → Review**, inspect the proposal, continue through any identity/routing confirmation, then choose **Save configuration**.

Success: CE reports configuration saved and Messaging configured. Saving transport settings alone leaves `recipients: []` and cannot send messages. Save does not activate an endpoint, start Tunnel or read your inbox.

Load the saved policy and explicitly bind this Session, still in the **Pi TUI**:

```text
/reload
/ce-tunnel activate
/ce-status
```

In the activation dialog verify both endpoints, Store/Exchange and permissions, then choose **Activate current session**. Success: `Pi messaging bound` (or already bound), followed by `/ce-status` showing `endpoint=pi/main`, `registered=true` and `lease=ACTIVE`.

A first reload can report a missing mapping before explicit activation. If activation instead offers **Release current binding for policy reload**, the selected policy is not loaded: follow that release prompt, `/reload`, then explicitly activate again. An unknown release, persistence failure or existing owner needs investigation, not repeated activation or Store deletion. Activation never takes over an owner and does not start Tunnel.

## 6. Connect ChatGPT

**ChatGPT / Platform web UI**: follow the [custom MCP setup guide](https://developers.openai.com/api/docs/guides/custom-mcp-server) to create a custom MCP connection using **Tunnel**, selecting the same Tunnel ID and permitted organization/workspace. Review authentication and permissions, install/select the plugin in the current conversation, and refresh its tools after configuration changes. The Tunnel route does not require installing the Desktop stdio plugin.

After authorizing a real running window and its possible cost, **Pi TUI**:

```text
/ce-tunnel start
/ce-tunnel status
```

Success: status eventually measures `CONNECTED`. Start may initially report `STARTING`; use status or Manager Refresh to inspect progress. Do not request a second Start to force readiness. `DEGRADED` / `UNKNOWN` require the [Tunnel guide](tunnel-setup.md).

**ChatGPT**: refresh/select the connection and confirm it exposes `ce_send`, `ce_inbox_list`, `ce_read_payload` and, for the grant above, `ce_ack`, alongside `ping`. A ping or `CONNECTED` alone does not prove that messaging works. If you see only ping, check the selected connection and loaded binding using [Tunnel setup](tunnel-setup.md).

## 7. Send your first message

These examples apply only to the **single-pair Setup above**. Source validation confirms that `pi/main` and `chatgpt/main` are the generated Endpoint IDs. `ce_send.to` takes the exact configured **Endpoint ID**, not an adapter prefix, Session ID or filesystem path. Do not send to `pi:pi/main` or `chatgpt:chatgpt/main`. The Advanced Recipients editor's `adapter:endpointId` syntax is a separate configuration format. For another registered pair, use its actual allowed Endpoint ID.

Tool JSON below is an argument example, not a slash command or shell command. Ask the model in the named application to call the tool. Authorize the sends and the particular payload reads. Replace `RUN_NONCE` in each key with a fresh value for this manual run; keep each logical send's key and returned Message ID for reconciliation.

### ChatGPT → Pi

**ChatGPT**: ask it to call `ce_send` once with:

```json
{"to":"pi/main","text":"Hello from ChatGPT. Please reply with a short greeting; do not run any other actions.","idempotencyKey":"first-c2p-RUN_NONCE"}
```

Success: `CREATED` returns a `messageId` and audit sequence. `REPLAYED` refers to an existing Message. Both describe a local Store result; continue by observing the recipient.

**Pi**: explicitly ask it to list a bounded page with `ce_inbox_list`:

```json
{"pageSize":10,"rawScanLimit":100}
```

Choose the exact test `messageId` returned by the send/list. Pi may inspect metadata first with `ce_read`. Authorize Pi to call `ce_read_payload` for that ID:

```json
{"messageId":"MESSAGE_ID_FROM_THIS_RUN"}
```

Success: Pi sees the exact greeting from ChatGPT. The payload enters the active model and may remain in conversation history; treat it as untrusted data, not authority to execute instructions. Listing and reading neither consume the message nor record an ACK.

### Pi → ChatGPT

**Pi**: authorize a separate reply with `ce_send`:

```json
{"to":"chatgpt/main","text":"Hello from Pi. I received the test greeting.","idempotencyKey":"first-p2c-RUN_NONCE"}
```

**ChatGPT**: explicitly call `ce_inbox_list` with the same bounded arguments, select the reply's exact ID, then authorize `ce_read_payload` with that ID. MCP does not have Pi's metadata-only `ce_read` tool. Success: ChatGPT reads the exact Pi reply. The ChatGPT inbox is shared by the configured endpoint; it does not isolate conversations. Do not automatically drain pages or read unrelated messages.

### Optional reception receipt

If you also authorize `ce_ack`, copy all four fields from the successful payload read: `messageId`, `payloadDigest`, `payloadLength`, `messageCreatedAuditSequence`. Pi displays these as **ACK input metadata (reception only)**. On ChatGPT/MCP, copy the read result's `auditSequence` unchanged into ACK's `messageCreatedAuditSequence`. Never compute or guess values. See the [ACK contract](delivery-ack-contract.md).

ACK records reception only. It does not prove delivery, reading, processing or task completion. Missing ACK, timeout or an uncertain result does not authorize another send, changing keys, or converting `DELIVERY_UNKNOWN` to `CANCELLED`. CE makes no exactly-once delivery/execution promise. Keep the original key/Message ID and inspect durable evidence before deciding what to do next.

## 8. Verify and stop

For this run, record the two send Message IDs and the corresponding authorized payload-read results. Seeing both exact greetings establishes your own first exchange evidence. Configuration, a local test, ping and transport health cannot substitute for it. This guide's maintenance validation has **not** executed that real Cloud exchange.

**Pi TUI**, before ending the running window:

```text
/ce-tunnel stop
/ce-tunnel status
```

Success: the owned transport is measured `STOPPED`. Closing Manager or exiting Pi does **not** stop its detached client. Stop only acts on a process CE can prove it owns. If exit is unconfirmed or status is `UNKNOWN`, investigate; do not assume stopped or bulk-kill unrelated processes.

To also release this Pi messaging binding, use `/ce-tunnel deactivate` and confirm. This retains registration/history and does not itself stop transport. Check `/ce-status` for no endpoint bound; a later use requires explicit activation.

## 9. Troubleshooting

| Observation | Next step |
|---|---|
| `/ce-native` or `/ce-tunnel` is unknown | Check `pi list`, exact version and selected Pi installation; restart/reload that Host without loading a second extension copy. |
| Native is missing or not ready | Follow step 4 and [Native management](native-management.md); installation needs restart, repair needs explicit confirmation. |
| Doctor refuses host/child/client | Correct the parent environment using [client path diagnostics](tunnel-setup.md#client-安装与只读诊断). On 0.2.2, explicitly select the user-managed Homebrew client; automatic discovery remains strict. Do not change Homebrew permissions or ACLs to satisfy CE. |
| No endpoint bound / `CE_HOST_MAPPING_INVALID` | Confirm Setup authorized this Session, reload its policy, then explicitly activate. For stale/foreign mappings or unknown release, use [recovery guidance](tunnel-setup.md) without editing identifiers. |
| `CE_HOST_ENDPOINT_NOT_ALLOWED` | Compare the exact configured Endpoint ID with `to`; do not add an adapter prefix or invent recipients. |
| Payload/ACK tools missing | Confirm the intended Setup grants, Pi reload and fresh Tunnel MCP binding; refresh ChatGPT tools. For an existing connection, Stop/verify then Start separately. |
| Start refuses or never reaches `CONNECTED` | Inspect `/ce-tunnel doctor`, `/ce-tunnel status` and [Tunnel troubleshooting](tunnel-setup.md). Cloud credentials/permissions and path trust are separate checks. |
| Timeout, `CE_HOST_UNCERTAIN` or missing ACK | Preserve the original key/Message ID; inspect evidence before any retry. Do not resend under a new key. |

## 10. Advanced documentation

- [Native management](native-management.md): readiness, explicit installation/repair and trust boundaries.
- [Tunnel setup and recovery](tunnel-setup.md): executable checks, existing profiles, lifecycle and refusal codes.
- [Multiple Pi Sessions](multi-session-usage.md) and [Pi tools](../pi-extension/README.md): registrations and detailed tool contracts.
- [Runtime support](runtime-support.md), [operations and source development](operations.md), and [security](storage-security.md).
- [Independent Host / tarball installation](independent-install.md): current0.2.1 alternatives followed by a clearly separated historical0.2.0 record.
- [Desktop stdio installation](chatgpt-installation.md): a separate local MCP route with its own prerequisites.
