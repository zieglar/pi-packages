[English](tunnel-setup.md) | [简体中文](tunnel-setup.zh-CN.md)

<a id="chatgpt--pitunnel-用户指南配置与排障"></a>

# ChatGPT ↔ Pi: Tunnel guide, configuration and troubleshooting

This is the Secure MCP Tunnel path; it does not require the Desktop stdio plugin. For Desktop alone, use the [Desktop stdio guide](chatgpt-installation.md). For daily-use distribution, use the published exact npm version or prebuilt tarball in the [independent installation guide](independent-install.md), without the repository build below. All examples are placeholders, not active configuration.

<a id="1-前提与安装"></a>

## 1. Prerequisites and installation

| Component | Requirement |
|---|---|
| Pi | 1.3.0; setup/confirmation uses the interactive TUI |
| Pi host / MCP child Node | Development candidate declares **>=24.20.0 <=24.22.2**; each must pass SQLite >=3.51.3, platform/compile safety and shared behavioral probes. No exact SQLite/source ID pin. 24.19.0 and 25.9.0 refuse after reproduced native crashes. Published npm 0.2.0 is unchanged |
| Repository build tools | pnpm 12.9.1; package installation supplies UI dependencies |
| Tunnel client | Current compatibility baseline `tunnel-client` 0.0.16; trusted absolute path or discovery in controlled system directories |
| Store platforms | Allowlist: macOS arm64 / Linux x64. This local regression used macOS arm64. Node 26.12.1 is isolated preview only; this does not qualify future versions, Linux or every client |

<a id="安装和加载扩展"></a>

### Install and load the extension

From the repository root in a shell using approved Node. mise is optional; do not change global Node to fix one Session.

```sh
node --version
pnpm install --frozen-lockfile
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

For persistent use across projects, build then `pi install /absolute/path/to/packages/pi-chat-exchange`. Run Pi normally from each project afterward. This local package references the original directory; do not move it or also load it with `-e`. Inspect declarations with `pi list`. The entrypoint imports bundled `dist/` without compiling source at runtime. After source changes, build before `/reload` in each affected Session or stale `dist/` may still run.

If shell Pi does not start under approved Node, invoke its installed JavaScript entrypoint with a trusted local absolute executable. Replace every path first:

```sh
CE_NODE_PATH="/trusted/node-install/bin/node" \
CE_TUNNEL_CLIENT_PATH="/trusted/client-install/tunnel-client" \
CE_TUNNEL_BACKGROUND_ALLOW=1 \
"/trusted/node-install/bin/node" "/absolute/installed-pi/dist/cli.js" \
  -e "/absolute/path/to/packages/pi-chat-exchange/pi-extension/index.ts"
```

`CE_NODE_PATH` **selects only the MCP child**, not the running Pi host. `CE_TUNNEL_BACKGROUND_ALLOW=1` permits explicit Start without connecting automatically. Export in a Pi child shell cannot change the parent Pi environment. Never put credentials in this command.

<a id="client-安装与只读诊断"></a>

### Client installation and read-only diagnostics

Get the platform-specific client through [OpenAI Tunnel settings](https://platform.openai.com/settings/organization/tunnels) or [official releases](https://github.com/openai/tunnel-client/releases/latest). Verify provenance, version and publisher-provided integrity information before execution. Latest does not automatically mean compatible. CE does not download, install or update the client, or create cloud Tunnels.

In Pi:

```text
/ce-tunnel doctor
```

Doctor separately reports the current host, independently selected child Node and client path trust. It does not start the client, read credentials/Store, change profile or establish cloud authentication/readiness. Child inspection checks the current resolver candidate, not the saved profile command or actual running child identity. Check existing profiles in Review/Details; explicitly migrate only after verified STOPPED if needed. Use fixed diagnostics to distinguish Node qualification, missing client and client trust refusal.

- Explicit `CE_TUNNEL_CLIENT_PATH` / `CE_NODE_PATH` must be trusted normalized absolute paths. Invalid explicit overrides must not be hidden by other candidates.
- System candidates come only from `/usr/local/bin`, `/usr/bin`, `/bin`, `/opt/homebrew/bin`, not project PATH. Node also checks the current process executable and historical mise installation location; mise is not required.
- Ownership/permissions are checked for the executable and every ancestor of original and resolved symlink paths. Project paths, `node_modules`, writable files/ancestors and untrusted symlink chains refuse. macOS accepts only absent/deny-only ACLs; unknown/failed inspection refuses.
- **Homebrew installation does not prove path trust.** Group/other-writable wrapper or Cellar ancestors refuse even if the final binary is not writable. Do not relax permissions, bypass symlink checks or execute it to “prove trust”. Choose a separately installed executable meeting the entire chain requirement and set its absolute override. Diagnostics do not move Homebrew files or clear ACLs.

Missing/untrusted clients never spawn. You can inspect Node, read docs and prepare configuration first, but that does not authorize Start.

<a id="准备云端配置与-chatgpt-连接"></a>

### Prepare cloud configuration and the ChatGPT connection

1. In [Platform Tunnel settings](https://platform.openai.com/settings/organization/tunnels), verify the target Tunnel, owning Platform organization and permitted ChatGPT workspace. Creation/management requires appropriate Manage permissions; the runtime key/user needs Use permissions. See the [official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Do not recreate existing resources to troubleshoot.
2. Obtain the full Tunnel ID (local shape: `tunnel_` plus at least 8 alphanumerics), Organization ID if needed (`org-...`) and an authorized Tunnel credential. These are not CE Sessions/capabilities. Enter keys only in the wizard's masked input. Local syntax checks do not establish cloud permissions.
3. Following the [official custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server), open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **+ → Add custom MCP server**, name it, choose **Connection: Tunnel** and the same target. Configure authentication, review risks, then **Create as a plugin**. Current official documentation governs organization/client eligibility. CE does not configure cloud plugins.
4. Install the plugin and select it with `@` in the current conversation. After configuration changes, refresh tools in plugin details and verify tools actually available in that conversation. Tunnel CONNECTED does not replace this check. Desktop marketplace installation is not required for this path.

<a id="2-首次设置与-messaging-授权"></a>

## 2. Initial setup and Messaging authorization

Run `/ce-tunnel setup`, or `/ce-tunnel` → **Set Up Tunnel**:

1. Enter Tunnel ID, Organization ID when needed and masked credential. For existing configuration choose **Keep existing credential**, without re-entering or reading the old key.
2. Review initially generates basic transport configuration with `recipients: []`, which **cannot communicate**.
3. Review → **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi)** → **Authorize messaging for this session**.
4. Check the current real Pi Session, ChatGPT Endpoint `chatgpt/main`, initial Pi Endpoint `pi/main`, Store/Exchange and payload/ACK. This convenience pairing enables payload read / ACK on both sides and replaces manual recipients with the sole Pi recipient. It is not implicitly minimal permission. Authorize different permissions through explicit configuration procedures.
5. Only final **Save** publishes the configuration generation. It does not activate Endpoints, start Tunnel or read/write messages. Replacing an existing pairing needs additional explicit confirmation.

Different projects/Sessions use separate registrations instead of overwriting `pi/main` in turn; see [multi-session usage](multi-session-usage.md).

<a id="让保存的策略生效"></a>

### Apply the saved policy

Before editing existing configuration, explicitly Stop and verify transport STOPPED. Unknown locks, active readers and external instances do not count as stopped. The wizard does not Stop automatically.

1. If an old CE binding is held, `/ce-tunnel deactivate` and confirm normal release of the current local binding. This neither stops transport nor revokes registration. The older activate policy-not-loaded branch also only releases the old mapping and requests reload; it does not switch permissions.
2. `/reload` loads the selected generation. Unbound/released mappings do not provision automatically; `CE_HOST_MAPPING_INVALID` does not mean delete Store.
3. `/ce-tunnel activate`; confirm the current real Session, both Endpoints, Store/Exchange and permissions. Binding is explicit requireUnowned. An already valid matching binding is a no-op. It never takes over an existing Owner, including expired Owners.
4. Check identity and Owner lease/fencing with `/ce-status`, then separately `/ce-tunnel start` to load the selected MCP configuration.

Skip step 1 on initial configuration without an old binding. Stop and verify on UNKNOWN release, missing exact released+detached evidence or failed persistence; do not repeatedly activate/reload. Never edit identifiers or forge release markers.

<a id="3-真实后台启动与-manager"></a>

## 3. Real background startup and Manager

Real Start can incur cost; authorize the running window first. With exact `CE_TUNNEL_BACKGROUND_ALLOW=1` in the parent Pi environment, explicitly `/ce-tunnel start`. To change parent environment, exit normally and restore the same Pi Session using approved Node and the same extension loading method. `--continue` selects the latest session; `--resume` allows manual selection. Environment permission does not start transport.

| Operation | Meaning |
|---|---|
| `/ce-tunnel` | Opens persistent Manager UI |
| Start / `/ce-tunnel start` | Confirms the request, then measures readiness asynchronously; no automatic reconnect |
| Refresh / Details | Updates health and displays sanitized nonsecret configuration/process evidence; no reauthorization |
| Stop / `/ce-tunnel stop` | Stops only instances the Manager can prove it owns; unconfirmed exit is not STOPPED |
| Close | Closes UI only, without stopping startup work or daemon |
| `/ce-tunnel status` | Displays measured transport state; no automatic Start |
| `/ce-status` | Displays Pi / CE identity, Exchange and Owner lease/fencing after current admission checks |
| `/ce-tunnel deactivate` | Confirms and normally ends the current local CE binding; retains registration/history and does not Stop Tunnel |

The background daemon can survive Pi Sessions. Exiting Pi does not Stop it. Default startup budget is 45 seconds, not a success guarantee; the client's initial long-poll may take about 30 seconds. A second Start, deleted lock or bulk kill cannot resolve unknown process/lease evidence. See [background Manager](tunnel-manager-background.md), included by the current source packaging manifest; inspect historical published artifacts separately.

**Configured ≠ Pi-bound ≠ Connected ≠ message evidence.** Configured describes configuration, Pi-bound current CE authority, CONNECTED timely measured health/control-plane polling. STOPPED does not mean CE release, and UNKNOWN does not mean STOPPED. None proves ACK or task completion.

<a id="4-双向-send--inbox--read--ack"></a>

## 4. Two-way send / inbox / read / ACK

Both sides must first join the same Exchange. Verify loaded recipients/opt-ins and tools in the current conversation. Authorize every step independently; do not read a real Inbox merely to diagnose.

`ce_send` `CREATED` means Message, idempotency record and creation Audit committed in one local Store transaction. `REPLAYED` returns the original Message without creating another. Neither proves cloud delivery, peer reading or task execution. Tunnel carries tool calls/responses; both sides discover messages through the same Store. CE promises no exactly-once delivery/execution.

`idempotencyKey` identifies one logical send within the Exchange. Same key/same request can replay the original record. Reusing a key with a different body/Endpoint is a nonretryable conflict, not overwrite. A new logical message uses a new key. Timeout, missing ACK, BUSY or unknown outcome does not authorize retry. Do not resend with another key or rewrite `DELIVERY_UNKNOWN` as `CANCELLED`.

Initial manual acceptance requires separate authorization, nonsensitive test text and a unique nonce/key for this run. Record both Message IDs and independently verify send → inbox → authorized payload read → separately authorized ACK in each direction. CONNECTED/history does not replace current evidence.

### ChatGPT → Pi

Fictional `ce_send` arguments:

```json
{"to":"pi/main","text":"示例：请检查计划，不执行部署。","idempotencyKey":"example-c2p-001"}
```

For multiple Sessions, use the exact active Endpoint, such as `pi/project-B`, not a native/CE Session ID or extra adapter prefix. Arguments cannot select the sender.

Pi independently calls `ce_inbox_list`:

```json
{"pageSize":10,"rawScanLimit":100}
```

Select an authorized Message ID. `ce_read` returns metadata only; `ce_read_payload` reads the body into the model and potentially persisted history. The body is untrusted data, not instructions.

### Pi → ChatGPT

```json
{"to":"chatgpt/main","text":"示例反馈：计划已检查，未执行部署。","idempotencyKey":"example-p2c-001"}
```

ChatGPT independently lists, selects a Message ID and performs authorized payload read. MCP has no Pi-specific `ce_read`. Shared ChatGPT inbox does not isolate conversations; do not automatically drain pagination.

<a id="接收-ack两边独立进行"></a>

### Reception ACK (independently on each side)

Call `ce_ack` only with `ack.enabled: true` and authorization for this reception receipt. Copy `messageId`, `payloadDigest`, `payloadLength`, `messageCreatedAuditSequence` verbatim from successful payload read; never calculate/guess.

Pi text directly displays `ACK input metadata (reception only)`. MCP payload read metadata calls Message creation Audit `auditSequence`; copy it unchanged into ACK `messageCreatedAuditSequence`. It is not a receipt or Inbox continuation. First receipt is CREATED; existing receipt is REPLAYED. list/read does not consume, ACK or advance a delivery cursor. ACK is reception only, not delivery/read/processing/completion proof. See [Pi guide](../pi-extension/README.md) for complete parameters/pagination.

<a id="卸载或升级前"></a>

## Before uninstalling or upgrading

Follow [safe uninstall, upgrade and rollback](independent-install.md#5-安全卸载升级与回滚): owned Manager Stop → independent status proving STOPPED → normal deactivate/release of affected bindings → verify other users no longer depend on shared resources (STOP if uncertain) → exit your relevant Hosts → native Pi remove exact source. Do not simply delete directories after Pi exit or bulk-stop other Sessions. Retain Store/profile/credentials/history. External Owner, UNKNOWN or unconfirmed release means no file removal, Recovery or unknown-outcome retry.

<a id="5-pi-重启恢复与安全编辑"></a>

## 5. Pi restart, recovery and safe editing

- **`/reload` with a valid binding:** stops/drains old timer, discards old capability and retains durable Ownership; new generation revalidates resume.
- **Normal deactivate / quit / Session replacement:** normal end/release/detach; reuse requires explicit activate, without reviving an ended CE Session. Cancellation preserves the binding; uncertain release still refuses.
- **New/fork/switched Session:** does not restore original identity. Register a new Endpoint using trusted native Session ID. Filename/project path is not authority.
- **Crash, expired lease, UNKNOWN:** no automatic takeover/recovery; stop and verify separately. Recovery is an [independent operator procedure](chatgpt-installation.md#显式-stale-ownership-恢复), not routine installation.
- **Editing:** verify STOPPED, then Setup → Keep credential. Save, Pi reload/activate and MCP Stop/Start apply separately. Cancel before Save preserves active configuration. Uncertain durability after Save is not rollback or retry permission.

<a id="配置模型与生成文件"></a>

## Configuration model and generated files

Default profile: `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`. `~` is explanatory only; generated content uses normalized absolute paths.

| Object | Purpose and editing policy |
|---|---|
| Profile | Transport and sole activation pointer; selects MCP command `--config`; not CE authority |
| `.credentials/credential-<uuid>` | Private plaintext key generation, directory 0700 / file 0600; do not cat or commit |
| `.ce-bindings/` | Private binding/sidecar; messaging generation digest protects both; do not overwrite/manually edit |
| `.ce-bindings/ce-store.sqlite`, WAL/SHM, host-secret | Store/trust root; directory 0700 / file 0600, Storage exclusively owns secret; do not copy/merge or clear Owners |
| Background state / lock / ledger | Process ownership evidence; do not delete locks or kill by name |
| Health URL / log | Restricted local diagnostics; keep URLs, full logs and credential references private |
| `ce-mapping` / `ce-messaging-released` / `ce-lifecycle-blocked` | Identifier/release/refusal evidence in Pi history; no capability; do not edit |

Pairing requires exact Store directory/file and Exchange namespace/idempotencyKey alignment. Endpoint, Participant, CE Session/Owner and native Pi Session differ. Registration is not a live Owner, and recipient labels are not authentication. Publication writes immutable binding/sidecar first; profile rename is logical commit. This is not a cross-file crash-atomic transaction; credential/generation GC is not automatic.

| Environment variable | Effect and timing |
|---|---|
| `CE_TUNNEL_PROFILE` | Selects normalized absolute profile; does not switch a running child automatically |
| `CE_NODE_PATH` | Trusted approved Node for MCP child; does not alter the running Pi host |
| `CE_TUNNEL_CLIENT_PATH` | Trusted absolute client override, not a profile field |
| `CE_TUNNEL_BACKGROUND_ALLOW=1` | Parent Pi permits explicit Start; no autostart |
| Nonempty `CE_ALLOWLIST` | Explicit Pi policy takes precedence and blocks generated conversion/registration; not recommended for ordinary Tunnel use |
| `CE_STORE_DIR` / `CE_STORE_FILE` | With declared Store, only confirm the same location; conflicts refuse rather than switch Store |
| `CE_LEASE_TTL_SECONDS` | Overrides configured TTL within Host bounds after reload; not recovery |
| `CE_TUNNEL_OFFLINE_TEST=1` | Isolated simulator only; do not set for normal use |

Without explicit allowlist, the selected complete generated policy takes precedence, then the extension-adjacent allowlist. Permissions are captured at factory load. Save/exports in other shells do not expand in-memory grants. The child inherits minimal environment; arbitrary `OPENAI_*` cannot change message identity.

<a id="故障排查先定位层再进行最小修复"></a>

## Troubleshooting: locate the layer before minimal repair

| Symptom | Checks and safe handling |
|---|---|
| Installation failure / missing runtime files | Check `node --version`, `npm --version` and artifact SHA256 for wrong runtime, incomplete artifacts or unbuilt source. Inspect tarball payload per [independent installation](independent-install.md); never build in consumer. For source, run `pnpm --dir packages/pi-chat-exchange run build` at repository root. Do not disable qualification/delete Store |
| No `/ce-tunnel` / `/ce-status` | Check `pi list`, original source, startup `-e` and refusal codes for absent/failed/stale loading. Keep one extension copy. Build source then `/reload`; inspect installed physical entrypoints. Do not load another copy |
| Send failure / lost send response | May be unbound, unauthorized recipient, pairing mismatch or unknown result. Inspect `/ce-status`, `/ce-tunnel status`, fixed refusal codes and exact Endpoint. Retain original key/Message ID; stop on unknown result. New key, missing ACK or another Start does not permit resend |
| Unqualified host / child Node | Doctor separates them. Approved Node must pass full SQLite qualification. Start host with correct Node; fix canonical child profile through explicit migrate after verified STOPPED |
| Missing/untrusted client | Doctor; verify independent installation and full permission chain. Do not copy around untrusted Homebrew ancestors, run unqualified binaries or weaken guards |
| `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` | Check exact parent Pi opt-in; child-shell export has no effect |
| register / sessions / revoke refuses `CE_TUNNEL_PROFILE_INVALID` on legacy single-session profile | Explicit `/ce-tunnel convert` must create a multi-session generation first. Confirm old runtimes stopped/updated and conversion authorization. No automatic conversion; this is distinct from transport STOPPED refusal |
| `recipients: []` / CONNECTED but cannot send | Check Advanced Messaging, Pi binding, current ChatGPT tools, Store/Exchange/recipient. Do not resend an original message as a connectivity test |
| `CE_HOST_UNAVAILABLE` after unclean exit with local session-process mutex unreleased slot | Operator-only reconciliation under a complete offline maintenance window; see the exact procedure below |
| No endpoint / `CE_HOST_MAPPING_INVALID` | Check current native Session, selected registration, loaded policy and release evidence. Explicitly activate new/normally released Sessions. UNKNOWN is not ordinary unbound state |
| read/ACK unavailable | Verify each independent opt-in and explicitly load it. ACK does not enable payload read |
| Inbox missing messages | Check all four pairing values and join boundary. Empty page does not prove whole-database absence; do not copy DB/blindly resend |
| STARTING / READY_TIMEOUT | Await in-flight terminal outcome and cleanup evidence; verify target/permissions. UNKNOWN does not permit another instance or infinite timeout |
| Duplicate commands / MANAGER_BUSY | Check `pi list` and `-e` for double loading; close extra UIs without repeatedly starting |
| Client refuses old `admin_ui` | After verified STOPPED, `/ce-tunnel migrate` repairs canonical schema/child Node only, without expanding grants |
| External instance / lock / STOP_UNCONFIRMED | Retain state/ledger. Beyond Manager-provable Stop, separate manual authorization is required. Do not delete locks or kill by name |

For an unreleased local session-process mutex slot, all Pi/CE processes, heartbeats, background launchers, automatic restarts and recovery jobs must be stopped and prevented from restarting throughout inspection, reconciliation, persistence and recheck. Independently establish owner death. Only then may the operator explicitly run:

```sh
pnpm run reconcile:session-mutex --expect-store-dir <canonical-dir> --expect-store-file <basename> --expect-endpoint <endpoint> --expect-runtime-session <session> --expect-slot <slot> --expect-owner-version 1 --expect-owner-scope <sha256> --expect-owner-pid <pid> --expect-owner-birth <birth> --expect-owner-process-token <token> --expect-owner-handle-token <token> --expect-owner-sha256 <raw-byte-sha256> --expect-store-dev <dev> --expect-store-ino <ino> --expect-slot-dev <dev> --expect-slot-ino <ino> --expect-owner-dev <dev> --expect-owner-ino <ino> --offline-window-confirmed --owner-death-evidence <independent-reference>
```

Every parameter requires independent verification; there are no defaults. There is no `--audit-log` parameter; unknown arguments refuse, and the script writes no audit file. It reconciles only a local mutex receipt, not CE ownership / Operator Recovery, and proves no CE end/detach. Restored local availability does not authorize business operations, CE read/ACK, detach, takeover or recovery; await a separate authorization decision. Do not delete locks, reconcile live PIDs or test acquire against a real Store. Publication has two stages: O_EXCL creates `release-pending.json` (0600, exactly the owner's raw bytes); after file/directory fsync and full recheck, atomic rename to `released.json` is the sole commit. Any failure before rename retains pending artifacts unchanged and exits with a fixed reason. If rename throws, success is recognized only when `released.json` exactly matches prepared bytes/identity; otherwise stop. No fallible operation runs after rename. Every failure requires manual inspection, never retry, overwrite or delete.

Unknown renew/end/mapping persistence remains fail-closed; do not repeatedly activate/reload. A record-backed run gets at most one SIGTERM; repeated Stop does not guarantee another signal. `migrate` neither reads keys, changes Store nor authorizes messaging; it is not a general YAML formatter.

Masked input does not isolate malicious same-process extensions, recordings, clipboard or memory observation. Share only fixed codes and minimal nonsecret identifiers, never keys, capabilities, bodies, full Sessions/environment. Isolated harnesses, packaged tool discovery, real Tunnel health and manual message acceptance are distinct evidence. This documentation work reruns no real message acceptance; cloud distribution remains NOT_VERIFIED.
