[English](chatgpt-installation.md) | [简体中文](chatgpt-installation.zh-CN.md)

<a id="chatgpt-安装tunnel-与-desktop-本地插件"></a>

# ChatGPT installation: Tunnel and Desktop local plugin

These are separate deployment paths. Do not let both occupy the same CE Endpoint:

| Path | Connection | Configuration entry |
|---|---|---|
| Secure MCP Tunnel | ChatGPT custom MCP plugin selects the Tunnel; the client starts local MCP | [Full Tunnel quick start](tunnel-setup.md); no local marketplace needed |
| Desktop local plugin (below) | ChatGPT Desktop starts bundled MCP over stdio | External `mcp-binding.json`; operator configures complementary Pi allowlist |

Do not copy a Desktop binding into a Tunnel generation for the same client, or confuse Desktop's default path with Tunnel's `--config` path. The modes share CE Host/Storage contracts, but not process ownership.

<a id="tunnelchatgpt-自定义-mcp"></a>

## Tunnel: ChatGPT custom MCP

Follow the [Tunnel guide](tunnel-setup.md) for `/ce-tunnel doctor`, Setup / Advanced Messaging, explicit reload/activate and separate Start. In [ChatGPT Plugins](https://chatgpt.com/plugins), select **+ → Add custom MCP server → Connection: Tunnel**, choose the same Tunnel, configure target authentication, review risks, create and install the plugin, then select it with `@` in the current conversation. Refresh changed tools in plugin details. CONNECTED alone does not establish current conversation permissions. Eligibility and current entrypoints follow the [official custom MCP guide](https://developers.openai.com/api/docs/guides/custom-mcp-server). The rest of this page applies only to Desktop local stdio.

<a id="desktop-适用条件与打包"></a>

## Desktop requirements and packaging

Requires ChatGPT Desktop with local plugin support, macOS or Linux, development candidate **Node.js >=24.20.0 <=24.22.1** (SQLite >=3.51.3, platform/compile safety and shared behavioral probes; no exact SQLite/source ID pin), and repository pnpm 12.9.1. Node 24.19.0 and 25.9.0 are refused after reproduced native crashes; 26.12.1 is isolated preview only. Testing used macOS arm64 and adds no Linux/Desktop UI acceptance. Published npm 0.2.0 is unchanged. The Desktop plugin uses `plugin.json`, root `mcp.json`, `${PLUGIN_ROOT}` and local stdio.

Official format references (current client entrypoints and organization eligibility follow their documentation):

- <https://developers.openai.com/plugins/deploy/desktop-only>
- <https://developers.openai.com/plugins/build/plugins>

From the repository root in a shell using approved Node, install dependencies and package. mise is optional:

```sh
node --version
pnpm install --frozen-lockfile
cd packages/pi-chat-exchange
pnpm run package:desktop-plugin
```

Generated ignored artifacts:

- `.plugin-build/pi-chat-exchange-0.2.0.zip`: single-root ZIP.
- `.plugin-build/marketplace/`: registerable local marketplace.
- `.plugin-build/pi-chat-exchange/`: extracted inspection copy.

The package contains the compiled server and production dependencies, with no live Endpoint, Store, token, capability or key. Public directory publication is separate; local marketplace installation is not public publication.

**Local runtime configuration:** Distributed ZIP/marketplace `mcp.json` starts with an empty server collection. It contains no machine paths and executes no unverified `node`. Copy the whole marketplace to a new private directory outside the repository below. If it already exists, stop without overwriting configuration. Replace Node paths with a trusted approved local executable:

```sh
umask 077
mkdir -p "$HOME/.local/share"
MARKETPLACE="$HOME/.local/share/ce-marketplace-local"
mkdir -m 700 "$MARKETPLACE" && \
  cp -R .plugin-build/marketplace/. "$MARKETPLACE/" && \
  chmod 700 "$MARKETPLACE/plugins/pi-chat-exchange" && \
  "/trusted/absolute/node" "$MARKETPLACE/plugins/pi-chat-exchange/server/configure.mjs" --node "/trusted/absolute/node"
```

The plugin root must be owned by the current operator with mode exactly `0700`. Root/ancestor and Node path/ACL chains must pass trust checks. The configurator does not repair permissions or clear ACLs. After full Node/SQLite qualification, it generates only that copy's absolute stdio command. It does not install, register, start, read the binding or read Store. Spaces in paths are supported. The generated manifest is local configuration and must not be redistributed. Repository, ZIP and original marketplace remain unconfigured. Configure and register the same copy. Secure Tunnel users do not need this procedure.

<a id="创建外置-binding"></a>

## Create the external binding

Keep the binding outside plugin installation/cache. Its default location uses the system account home:

```bash
umask 077
mkdir -p "$HOME/.config/pi-chat-exchange"
# 目标已存在则停止，先核实原配置，不覆盖
test ! -e "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  test ! -L "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  cp plugin/pi-chat-exchange/config/binding.example.json \
    "$HOME/.config/pi-chat-exchange/mcp-binding.json" && \
  chmod 600 "$HOME/.config/pi-chat-exchange/mcp-binding.json"
```

This complete, parseable fictional example complements the [Pi guide](../pi-extension/README.md). Replace paths and Session placeholders under local authorization. It is not active configuration. Keep payload/ACK false unless each is authorized.

```json
{
  "version": 1,
  "store": { "directory": "/srv/example-ce-store", "file": "ce-store.sqlite" },
  "exchange": { "namespace": "example-local", "idempotencyKey": "example-chatgpt-pi" },
  "endpoint": { "adapter": "chatgpt", "endpointId": "chatgpt/main" },
  "recipients": [{ "adapter": "pi", "endpointId": "pi/main" }],
  "lease": { "ttlSeconds": 120, "renewIntervalSeconds": 30 },
  "payloadRead": { "enabled": false },
  "ack": { "enabled": false },
  "debugExecutionGuard": { "enabled": false }
}
```

Store directory must be a normalized absolute POSIX path other than `/`. See [Storage security](storage-security.md) for local filesystem/permission requirements (included by the current source packaging manifest; inspect historical published artifacts separately). The lease renewal interval must not exceed half the TTL. Both sides must exactly match Store directory/file and Exchange namespace/idempotencyKey. Endpoint and Ownership remain independent. Legacy template labels are not required names.

The launcher reads fixed `~/.config/pi-chat-exchange/mcp-binding.json`; model arguments/environment cannot select identity. Only local package diagnostics support strict normalized absolute `--config`; shipped `mcp.json` does not pass the override. Missing/invalid configuration refuses `CE_MCP_CONFIG_INVALID`, with no arbitrary-identity fallback.

<a id="注册与使用"></a>

## Register and use

Following the [official local marketplace procedure](https://developers.openai.com/plugins/build/plugins), register the same configured private directory with a Codex CLI supporting these commands (`MARKETPLACE` continues from the same shell above):

```sh
codex plugin marketplace add "$MARKETPLACE"
codex plugin marketplace list
```

Restart ChatGPT Desktop with local plugin support. In Plugins Directory, select **Pi Chat Exchange Local**, install **Pi Chat Exchange**, and verify tools in a new conversation. The client may load a plugin-cache installation copy; directory permissions and local Node must qualify in the actual installation environment. Packaging tests do not replace UI acceptance.

For updates, repackage, copy to a new private directory, restrict the nested plugin root to `0700`, configure, then register. Refresh/reinstall and create a new conversation; old conversations are not guaranteed to reload. If eligibility or menus differ, check official instructions without bypassing organization restrictions. Tunnel success does not establish Desktop installation success.

<a id="针对性验收与结果边界"></a>

## Targeted acceptance and result boundaries

Under separate authorization, after both sides join the same Exchange:

1. Enable Pi Chat Exchange in a new conversation; `ping` should return `status: "reachable"`.
2. Discover base tools: `ping`, `ce_send`, `ce_inbox_list`, `ce_read_payload`. MCP advertises payload read even when disabled, but actual reading refuses. Pi instead registers its tool only with opt-in.
3. With exact true `ack.enabled`, `ce_ack` is additionally available. Otherwise it is neither advertised nor callable. ACK does not enable payload read.
4. Follow the [message procedure](tunnel-setup.md#4-双向-send--inbox--read--ack): two-way send → independent list → authorized read → separately authorized ACK, recording each step's evidence.

Packaged artifact tests verify stdio/tool discovery, not successful Desktop UI installation. See the [README](../README.md) for recorded actual ChatGPT↔Pi messaging and Tunnel lifecycle acceptance. Tunnel acceptance does not mean each Desktop installation path was rerun. ACK always means reception only, never task completion. Cloud distribution remains NOT_VERIFIED; this guide adds no cloud validation.

<a id="显式-stale-ownership-恢复"></a>

## Explicit stale-ownership recovery

Normal MCP/Pi startup does not take over existing Owners. Lease expiry after a crash does not trigger takeover. The operator first verifies the process is lost, then inspects exact durable owner evidence through a read-only connection. Recovery needs separate authorization; it is neither a general startup prerequisite nor a model-callable tool.

The CLI is in the package directory; build first. This is a template, not an executable procedure until the operator replaces every `<...>` with verified evidence:

```bash
node scripts/recover-stale-ownership.mjs \
  --config /absolute/path/to/operator-binding.json \
  --confirm-endpoint '<adapter>/<endpointId>' \
  --expect-owner-session '<exact-owner-session>' \
  --expect-fencing-token '<exact-fencing-token>' \
  --expect-lease-started-at '<exact-lease-start-or-null>' \
  --expect-expires-at '<exact-expiry>' \
  > /operator-controlled/path/recovery-receipt.json
```

Invoke approved Node directly so `pnpm run` banners cannot contaminate the redirected receipt. All six flags must match the durable row. `--confirm-endpoint` is `<adapter>/<endpointId>`, unlike `ce_send.to`'s label. Use literal `null` only for migrated historical rows without lease start. This CLI selects its recovery target through an MCP binding; a Pi allowlist is not a substitute. Pi Endpoint incident recovery requires separate target and authorization checks.

The CLI refuses live leases, missing/mismatched evidence and concurrent losers. On success, it binds a recovery Session, performs the existing atomic takeover, then releases/detaches; fencing increases monotonically. The receipt contains no capability/host secret, but its internal identifiers must still remain private.

| Fixed code | Meaning and operational boundary |
|---|---|
| `CE_RECOVERY_LAUNCH_INVALID` / `INVALID_REQUEST` / `CONFIG_INVALID` (last two also use the `CE_RECOVERY_` prefix) | Invalid flags, configuration, target path or fields; verify input without guessing |
| `CE_RECOVERY_TARGET_MISMATCH` / `OWNER_ABSENT` / `OWNER_MISMATCH` (same prefix) | Missing target Participant/Owner or mismatched evidence; verify again without weakening confirmation |
| `CE_RECOVERY_OWNER_ACTIVE` / `CLOCK_REGRESSION` (same prefix) | Lease still active or clock earlier than persisted term; recovery refuses |
| `CE_RECOVERY_RACE_LOST` / `BUSY` (same prefix) | Concurrent winner or transaction conflict; this attempt acquired no authority on that basis |
| `CE_RECOVERY_FAILED` | Fail-closed before write |
| `CE_RECOVERY_OUTCOME_UNKNOWN` | Unknown durable outcome; stop and verify, never retry blindly |

Exit 0 means recovery succeeded. Exit 1 emits only a fixed refusal code to stderr. Neither indicates message/workflow completion. Tunnel process ownership recovery has a separate boundary; this CLI cannot clean up Manager locks.

<a id="支持限制"></a>

## Support limits

Windows does not meet the current absolute POSIX path contract. Missing approved Node, invalid permissions or mismatched Store identity/version fail closed without initializing a substitute Store. Diagnostics must not expose keys, capabilities, bodies, full logs or real Session information. See [troubleshooting](tunnel-setup.md#故障排查先定位层再进行最小修复) for other issues.
