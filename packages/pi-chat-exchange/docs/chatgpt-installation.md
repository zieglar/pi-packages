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

- `.plugin-build/pi-chat-exchange-0.1.1.zip` — single-root distributable ZIP.
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


## Explicit stale-ownership recovery

Normal MCP/Pi startup never takes over an existing ownership row. After a
confirmed process loss, inspect the Store from a fresh read-only connection and
record the exact expired owner evidence. Then an operator may run the repository-
local CLI; it is not packaged as an MCP tool and is not model-callable:

Build first: the CLI loads the compiled `dist/`, so run `pnpm run build` after any
source change. Invoke `node` directly so stdout is exactly the receipt (a
`pnpm run` lifecycle banner would corrupt a redirected JSON file):

```bash
node scripts/recover-stale-ownership.mjs \
  --config /absolute/path/to/mcp-binding.json \
  --confirm-endpoint mcp/chatgpt-desktop \
  --expect-owner-session ses_... \
  --expect-fencing-token 1 \
  --expect-lease-started-at 2026-10-14T07:47:30.709Z \
  --expect-expires-at 2026-10-14T07:49:30.709Z \
  > /operator-controlled/path/recovery-receipt.json
```

All six flags are mandatory and must match the durable row exactly.
`--confirm-endpoint` must equal `<adapter>/<endpointId>` from the binding. For a
migrated legacy row with no persisted lease start, pass the literal
`--expect-lease-started-at null`.

The caller refuses a live lease, absent/mismatched evidence, or a concurrent
winner. It binds a fresh recovery Session, performs the existing atomic takeover,
releases ownership, and detaches that recovery Session. Fencing remains monotonic.
The JSON receipt contains no capability or host secret.

Exit code 0 means recovered; exit code 1 prints exactly one fixed code on stderr:

| Code | Meaning |
|---|---|
| `CE_RECOVERY_LAUNCH_INVALID` | malformed flags, bad config path, confirmation mismatch, or an unopenable store |
| `CE_RECOVERY_INVALID_REQUEST` | a flag value was rejected by the recovery request validator (bad session id, instant, or TTL) |
| `CE_RECOVERY_CONFIG_INVALID` | the binding file failed validation |
| `CE_RECOVERY_TARGET_MISMATCH` | the configured endpoint has no durable Participant |
| `CE_RECOVERY_OWNER_ABSENT` | no ownership row (possibly already recovered) |
| `CE_RECOVERY_OWNER_MISMATCH` | the durable row differs from the confirmed evidence |
| `CE_RECOVERY_OWNER_ACTIVE` | the lease is still live; recovery refused |
| `CE_RECOVERY_CLOCK_REGRESSION` | the clock precedes the persisted term |
| `CE_RECOVERY_RACE_LOST` | another recovery won; nothing was changed by this run |
| `CE_RECOVERY_BUSY` | store contended; the attempt rolled back |
| `CE_RECOVERY_FAILED` | failed closed before any recovery write |
| `CE_RECOVERY_OUTCOME_UNKNOWN` | unknown outcome; inspect durable state, never retry blindly |

## Failure behavior

- Missing/invalid binding: startup fails closed with `CE_MCP_CONFIG_INVALID`.
- Existing stale ownership after a crash: startup refuses takeover.
- `payloadRead.enabled: false`: payload reads are refused.
- Missing pinned Node runtime: `mcp.json` launches `/Users/zieglar/.local/share/mise/installs/node/24.21.0/bin/node`
  by absolute path. If that runtime moves (for example a mise upgrade), update the
  `mcp.json` source and repackage; the desktop host no longer needs `node` on `PATH`.
- Windows: unsupported by the current absolute POSIX config-path contract.
