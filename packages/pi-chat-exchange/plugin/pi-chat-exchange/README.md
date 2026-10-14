# Pi Chat Exchange — ChatGPT Desktop local plugin

This Desktop-only plugin starts the bundled `pi-chat-exchange` MCP server over
stdio. It exposes `ping`, `ce_send`, `ce_inbox_list`, and `ce_read_payload`.

## Configure before installation

The plugin deliberately contains no live endpoint identity, store location, or
secret. Copy `config/binding.example.json` to:

```text
~/.config/pi-chat-exchange/mcp-binding.json
```

Replace every example identity and path with the operator-approved values. The
store directory must be an existing-style normalized absolute POSIX path and
must not be `/`. Keep `payloadRead.enabled` false unless payload reads are
explicitly intended.

The launcher resolves this fixed configuration location from the operating
system home directory; it does not accept configuration from MCP tool arguments
or environment variables.

For local packaging diagnostics only, an operator may invoke `server/launch.mjs
--config /normalized/absolute/path.json`. The shipped `mcp.json` does not use
this override.

## Runtime requirements

- ChatGPT Desktop with local plugin support.
- macOS or Linux.
- The Node.js 24 runtime pinned by absolute path in this plugin's `mcp.json`;
  the desktop host never resolves `node` from its restricted `PATH`.
- A configured Pi endpoint using the same Chat Exchange store and reciprocal
  recipient allowlist.

See the repository's `docs/chatgpt-installation.md` for installation and
end-to-end verification.
