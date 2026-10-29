[English](README.md) | [简体中文](README.zh-CN.md)

<a id="pi-chat-exchange--chatgpt-desktop-本地插件"></a>

# Pi Chat Exchange: ChatGPT Desktop local plugin

This Desktop-only stdio plugin starts the bundled CE MCP server. It provides `ping`, `ce_send`, `ce_inbox_list` and `ce_read_payload`; `ce_ack` is available only when the external binding's separate ACK opt-in is true. Availability of the payload tool does not authorize reading. The plugin is separate from the Tunnel client.

<a id="安装前配置"></a>

## Configure before installation

The plugin contains no live Endpoint, Store, credential or capability. Copy `config/binding.example.json` to the system account's:

```text
~/.config/pi-chat-exchange/mcp-binding.json
```

Replace template identities and paths with operator-approved values and restrict file permissions. Store directory must be a normalized absolute POSIX path other than `/`. Pi needs a complementary allowlist with exactly matching Store directory/file and Exchange namespace/idempotencyKey. The two Endpoints retain independent Ownership.

`payloadRead.enabled` and `ack.enabled` both default to off. Authorize each separately before enabling it. ACK records reception only; it does not prove delivery, read, processing or task completion.

The launcher obtains the fixed binding path from the system home. Model arguments and environment variables cannot select an identity. Local package diagnostics may explicitly pass `server/launch.mjs --config /normalized/absolute/path.json`; shipped `mcp.json` does not use this override.

<a id="runtime-与已知部署限制"></a>

## Runtime and known deployment limits

- Requires ChatGPT Desktop with local plugin support, on macOS or Linux.
- Current CE 0.2.1 requires **Node >=22.19.0** and uses pinned Rust Native SQLite by default. Prepare Native with the Pi-side [Native management guide](../../docs/native-management.md), then restart Pi before using the same account’s Desktop MCP server. Store support remains macOS arm64 / Linux x64 GNU. `mcp.json` must select a trusted local Node executable, not Desktop’s restricted PATH. Artifact tests do not qualify actual Desktop UI installation or cloud transport.
- Distributed `mcp.json` enables no server by default. It contains no developer-machine path and does not fall back to an unverified `node`. Extract the ZIP to a new private directory owned by the operator, then explicitly configure it below.
- After repackaging/refreshing the plugin, discover tools in a new conversation. Do not let Tunnel and the local plugin compete for the same Endpoint.

```sh
# 先把 artifact 解压至仓库外新建的私有目录，再替换下列路径
chmod 700 "/absolute/private/plugin"
"/trusted/absolute/node" "/absolute/private/plugin/server/configure.mjs" --node "/trusted/absolute/node"
```

Replace the examples with local paths; spaces are supported. The configurator checks paths, permissions and full Node/SQLite qualification before modifying only that local copy's `mcp.json`. It does not install, register or start services, or read the binding or Store. It refuses to overwrite a configured copy silently; use a fresh unconfigured copy to reconfigure. The generated manifest contains local absolute paths and must not be redistributed. The ZIP and repository template remain unconfigured. Run this command on an extracted artifact, not an unbuilt source template.

The plugin root must be owned by the current operator with mode exactly `0700`, preventing other accounts from traversing or replacing its code. For marketplace installation, copy the entire marketplace to a new private directory, set its nested `plugins/pi-chat-exchange` to `0700`, configure that nested copy and register the same private marketplace root. Configuring a standalone copy does not configure the original marketplace.

On macOS, root and ancestor ACLs must be absent or deny-only. Allow ACLs, failed inspection and unknown output refuse even with POSIX mode `0700`. The configurator does not clear ACLs or change system installation permissions. Choose a private copy that meets the requirements.

The Pi host must also start under approved Node. Configuring a separate MCP child does not change the running Pi's Node. mise is optional. Secure Tunnel users do not need this local stdio plugin or Marketplace installation.

Pi's `/ce-tunnel doctor` separately checks the current host, selected child Node and Tunnel client trust. It does not inspect Desktop's installed manifest or prove that Desktop loaded tools. For Desktop, verify successful local configuration and actual tool discovery in a new conversation. See the [multi-session guide](../../docs/multi-session-usage.md) for each Pi Session's Endpoint, current identity and the distinction between normal deactivate and revoke.

The source repository's [ChatGPT installation guide](../../docs/chatgpt-installation.md) covers packaging, marketplace setup, a complete fictional binding and recovery limits. Relative repository docs may be absent when this README ships in an artifact; consult the source repository.
