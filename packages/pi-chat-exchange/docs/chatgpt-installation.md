# ChatGPT Desktop local plugin installation

Current OpenAI documentation supports Desktop-only plugins that launch a local
MCP server over stdio. This package uses that supported format: a portable
`plugin.json`, root `mcp.json`, and `${PLUGIN_ROOT}` for the bundled server. The
generated `mcp.json` pins this machine's Node 24 runtime by absolute path, so the
desktop host never resolves `node` from its restricted `PATH` (diagnosed in
HANDOFF-946281, fixed in HANDOFF-968413).

Official references:

- <https://developers.openai.com/plugins/deploy/desktop-only>
- <https://developers.openai.com/plugins/build/plugins>

This path requires neither a public URL nor Secure MCP Tunnel. Public directory
submission of a local-MCP plugin is a separate flow currently limited to
allowlisted organizations; local marketplace installation does not publish the
plugin.

## 1. Build the installable package

Requirements: Node.js 24, pnpm 12, and macOS or Linux. The generated `mcp.json`
launches `/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin/node` by
absolute path — a ChatGPT Desktop-specific local deployment setting that is not
portable across machines.

```bash
cd packages/pi-chat-exchange
pnpm run package:desktop-plugin
```

Generated, ignored artifacts:

- `.plugin-build/pi-chat-exchange-0.1.0.zip` — single-root distributable ZIP.
- `.plugin-build/marketplace/` — ready-to-register local marketplace.
- `.plugin-build/pi-chat-exchange/` — unpacked inspection copy.

The package includes the compiled server and production dependencies. It does
not include a live endpoint identity, store path, token, capability, or secret.

## 2. Create the operator binding

Copy the redacted template outside the plugin installation/cache:

```bash
mkdir -p "$HOME/.config/pi-chat-exchange"
cp plugin/pi-chat-exchange/config/binding.example.json \
  "$HOME/.config/pi-chat-exchange/mcp-binding.json"
```

Edit the copied file:

- `store.directory` must be a normalized absolute POSIX path and not `/`.
- `endpoint` is the single ChatGPT Desktop-owned Endpoint identity.
- `recipients` is the explicit cross-adapter allowlist, normally the Pi
  Endpoint that will receive messages.
- Leave `payloadRead.enabled` as `false` unless payload reads are explicitly
  authorized.

The bundled launcher always passes this fixed absolute location to the existing
`mcp-stdio` entrypoint. MCP tool arguments and environment variables cannot
select the bound identity or configuration file.

The launcher also accepts a strict normalized absolute `--config` path for
local package diagnostics. The shipped `mcp.json` supplies no override, so the
Desktop path remains the system account location above.

## 3. Install from the local marketplace

Register the generated marketplace using an absolute path:

```bash
codex plugin marketplace add \
  /absolute/path/to/packages/pi-chat-exchange/.plugin-build/marketplace
```

Restart ChatGPT Desktop. Open **Plugins**, choose **Pi Chat Exchange Local**,
and install **Pi Chat Exchange**. Start a new local Work/Codex chat after any
plugin update; existing chats do not reload changed tools.

The desktop host copies local plugins into its cache. Re-run the package command
and refresh/reinstall the marketplace entry after changing the plugin.

## 4. Targeted acceptance

1. Mention **Pi Chat Exchange** in a new local chat.
2. Ask it to call `ping`; expect `status: "reachable"`.
3. Confirm tool discovery lists exactly `ping`, `ce_send`, `ce_inbox_list`, and
   `ce_read_payload`.
4. Use `ce_send` for an allowlisted Pi recipient and verify Pi receives it.
5. Have Pi reply, then verify `ce_inbox_list` discovers the reply.
6. If payload reads were explicitly enabled, verify `ce_read_payload` returns
   only the selected message body.

Automated package tests cover steps 2–3 against the bundled artifact. Actual
ChatGPT Desktop installation and the bidirectional UI workflow remain
**NOT_RUN** until performed in the desktop client.

## Failure behavior

- Missing/invalid binding: startup fails closed with `CE_MCP_CONFIG_INVALID`.
- Existing stale ownership after a crash: startup refuses takeover.
- `payloadRead.enabled: false`: payload reads are refused.
- Missing pinned Node runtime: `mcp.json` launches `/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin/node`
  by absolute path. If that runtime moves (for example a mise upgrade), update the
  `mcp.json` source and repackage; the desktop host no longer needs `node` on `PATH`.
- Windows: unsupported by the current absolute POSIX config-path contract.
