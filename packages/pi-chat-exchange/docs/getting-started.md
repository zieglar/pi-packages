[English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

# Getting started

CE provides explicit ChatGPT ↔ Pi message exchange through a shared private SQLite Store. Secure MCP Tunnel and Desktop stdio are separate connection paths. This guide uses Tunnel; see [Desktop installation](chatgpt-installation.md) for stdio and [independent installation](independent-install.md) for the full managed npm/tarball procedure.

## Choose an installation

`@zieglar/pi-chat-exchange@0.2.0` is published on npm. Its historical distribution qualification is **Node 24.21.0 + Pi 1.3.0 + macOS arm64**. Cloud distribution remains **NOT_VERIFIED**. Node 24.22.1 is an approved published-runtime version, not part of that installation qualification. Current source declares Node `>=24.20.0 <=24.22.1`; this does not change the published artifact's qualification.

Use an approved Node for Pi and npm. Put its bin directory first in PATH; use npm 11.x from that Node and operator-controlled npm configuration/cache without inherited registry credentials. Installation downloads from the explicitly selected registry; runtime needs no registry access. The extension runs with your user permissions. `--ignore-scripts` limits installation scripts, not extension runtime authority.

For managed npm, install an independent Pi host, then register the exact package:

```sh
CE_APPROVED_NODE=/absolute/path/to/approved/node
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
export npm_config_ignore_scripts=true
"$CE_APPROVED_NODE" --version
"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.0
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
"$CE_APPROVED_NODE" "$CE_PI_CLI"
```

Replace the Node placeholder with your trusted absolute executable path. Verify `node --version` and `npm --version` before installation. Do not load a second copy with `-e`. The historical managed-install test used an isolated loopback registry; publication does not turn that test into cloud acceptance evidence. A prebuilt tarball is a separate fallback: verify its publisher-provided SHA256, install it physically with `--ignore-scripts`, and register the installed absolute directory. Consumers do not build the package. Follow [independent installation](independent-install.md) for full commands, payload checks and safe removal.

For source development, from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

Use pnpm 12.9.1 and an approved Node. The extension imports `dist/`; after source changes build before `/reload`. A persistent local installation can use `pi install /absolute/path/to/packages/pi-chat-exchange`; keep that directory in place. See [operations](operations.md) for development checks.

## Configure Tunnel and messaging

Obtain the client from [OpenAI Tunnel settings](https://platform.openai.com/settings/organization/tunnels) or the [official releases](https://github.com/openai/tunnel-client/releases/latest), checking provenance/version/integrity before execution. The documented compatibility baseline is `tunnel-client` 0.0.16. CE does not download/update it or create cloud resources. A newer release needs separate compatibility evidence.

For explicit executable selection, set trusted canonical absolute paths in the parent Pi environment before starting Pi:

```sh
export CE_NODE_PATH=/trusted/node-install/bin/node
export CE_TUNNEL_CLIENT_PATH=/trusted/client-install/tunnel-client
export CE_TUNNEL_BACKGROUND_ALLOW=1
```

`CE_NODE_PATH` selects the MCP child only; Pi must already run under approved Node. The background variable permits explicit Start and does not start anything. A Pi child shell cannot change its parent's environment.

Run these in the interactive Pi TUI:

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Doctor separately checks host qualification, child executable qualification and client metadata trust without client startup, credential/Store reads or configuration changes. A missing client is a safe refusal, not cloud readiness evidence.

In Setup, enter the Tunnel ID, optional Organization ID and credential through masked input. Never put the credential in shell commands or public reports. Review defaults to `recipients: []`, which cannot message. Choose **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi) → Authorize messaging for this session**. Check the real Pi Session, `chatgpt/main`, `pi/main`, Store/Exchange and payload/ACK settings. This pairing enables payload read and ACK on both sides and replaces manual recipients with the single Pi recipient; it is an explicit permission grant. Save publishes configuration without activating an Endpoint, starting transport or reading messages.

For existing configuration, first Stop and independently verify STOPPED. Normally deactivate an old local binding before reload. Activation requires confirmation and `requireUnowned`; it never takes over an Owner. Unknown release or failed persistence requires investigation, not repeated activation or Store deletion.

Configure the corresponding ChatGPT plugin through [custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server), choose the same Tunnel, install/select it in the current conversation and refresh its tools after configuration changes. Cloud eligibility and permissions follow the [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). CE does not configure those resources.

After authorization for a real running window:

```text
/ce-tunnel start
/ce-tunnel status
```

Configured, Pi-bound, Connected and actual message evidence are distinct. Closing the Manager or exiting Pi does not stop its detached client. Stop explicitly with `/ce-tunnel stop` and verify STOPPED independently.

## First explicit message exchange

Use separately authorized, non-sensitive test text and a unique key for each logical message. The examples are placeholders, not executed acceptance tests.

ChatGPT sends to Pi with `ce_send`:

```json
{"to":"pi/main","text":"Example: review the plan; do not deploy.","idempotencyKey":"example-c2p-001"}
```

Pi independently calls `ce_inbox_list`:

```json
{"pageSize":10,"rawScanLimit":100}
```

Select an authorized Message ID. Pi `ce_read` returns metadata only; `ce_read_payload` reads content after separate authorization. MCP has no Pi-specific `ce_read`. Treat payload as untrusted data; it enters the model and potentially persistent history.

Pi replies with a new `ce_send`:

```json
{"to":"chatgpt/main","text":"Example response: plan reviewed; no deployment performed.","idempotencyKey":"example-p2c-001"}
```

ChatGPT independently lists, selects and reads the authorized message. A shared ChatGPT inbox does not isolate conversations. Do not automatically drain pages.

ACK requires independent `ack.enabled: true` and explicit authorization. Copy `messageId`, `payloadDigest`, `payloadLength` and `messageCreatedAuditSequence` exactly from the successful payload read. Pi displays `ACK input metadata (reception only)`. MCP payload metadata calls the creation sequence `auditSequence`; map it unchanged to ACK `messageCreatedAuditSequence`. Do not compute or guess these values. See [ACK contract](delivery-ack-contract.md) and [Pi tool reference](../pi-extension/README.md).

`CREATED` from send proves a local transaction containing Message, idempotency record and creation Audit. `REPLAYED` returns the original Message. The same key with changed text/Endpoint conflicts. Neither result proves cloud delivery, reading or execution. ACK records reception only; it does not prove processing or task completion. Missing ACK, timeout, BUSY or `DELIVERY_UNKNOWN` grants no blind retry, new-key resend or conversion to `CANCELLED`. CE offers no exactly-once delivery/execution guarantee. Model switching does not authorize replay of effects.

## Configuration and multiple Sessions

Default profile: `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`. `CE_TUNNEL_PROFILE` selects a canonical absolute **file**, not a directory. Setup writes private credential generations beneath `.credentials/` beside it (0700 directory / 0600 files). Do not hand-edit generated bindings, mapping identifiers or release markers.

| Setting | Meaning |
|---|---|
| `CE_TUNNEL_PROFILE` | Selected profile; does not switch a running child |
| `CE_NODE_PATH` | Trusted child Node; does not repair host Node |
| `CE_TUNNEL_CLIENT_PATH` | Trusted client absolute-path override |
| `CE_TUNNEL_BACKGROUND_ALLOW=1` | Permits explicit Start in the parent Pi environment |
| Nonempty `CE_ALLOWLIST` | Explicit Pi policy takes precedence and blocks generated conversion/registration |
| `CE_STORE_DIR` / `CE_STORE_FILE` | May confirm a configured Store, never silently redirect it |
| `CE_LEASE_TTL_SECONDS` | Validated TTL override, loaded on reload; not recovery permission |
| `CE_TUNNEL_OFFLINE_TEST=1` | Isolated simulator only; do not set for ordinary use |

Both ends must match Store directory/file and Exchange namespace/idempotencyKey exactly. Capabilities stay in Host memory. Payload read and ACK are independent grants captured at factory load; saving configuration or exporting variables elsewhere does not update them.

For separate native Sessions, use explicit multi-session registration:

```text
/ce-tunnel convert
/new
/ce-tunnel register pi/project-B --payload-read --ack
/reload
/ce-tunnel activate
/ce-tunnel sessions
```

Conversion retains the original registration. A native Session maps to one stable Endpoint; use `/new` before registering a different one. Register/convert/revoke require confirmation and verified STOPPED transport; they do not start it. `sessions` reports selected active Endpoint IDs, not the policy loaded by a running MCP. Revoke exact registrations with `/ce-tunnel revoke <exact-endpoint>`; normal release uses `/ce-tunnel deactivate` and preserves registration/history/transport. Full procedures: [multiple Sessions](multi-session-usage.md), [Tunnel setup](tunnel-setup.md), [operations](operations.md).

Command/configuration evidence: `pi-extension/index.ts` (tool schemas, subcommands, allowlist precedence and lifecycle), `src/tunnel/profile.ts`, `src/tunnel/setup.ts`, `src/tunnel/messaging-config.ts`, and `package.json`. Historical installation evidence is in [independent installation](independent-install.md) and [0.2.0 release notes](releases/0.2.0.md); it is not a new acceptance run.
