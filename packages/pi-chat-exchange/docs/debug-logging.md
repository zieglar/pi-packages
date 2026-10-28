# Development diagnostics (DIAG-01)

Diagnostics are always on: no environment switch, logger dependency, or protocol
extension. They observe the existing entrypoints; they do not grant tool access,
change ACK/Authority rules, recover ownership, or turn a reply into MCP evidence.

## Output and privacy

Every JSONL record has `ts` (ISO 8601), `pid`, `component`, and `event`. The logger
uses private per-PID files under `server/.debug-logs/` in a packaged debug plugin
(or `.debug-logs/` next to `dist/` in a source checkout), with a best-effort stderr
mirror. **Never stdout.** File/serialization/stderr failures are ignored, not
converted into business failures. Existing stderr status codes remain unchanged.

Only explicitly projected metadata is logged: known JSON-RPC methods, numeric
request IDs (string IDs become type/length), known tool names, argument field
names/types/string lengths, stage/count/outcome/timing, and sanitized stack
basenames/line/column. No full arguments, payloads, result bodies, config, env,
credentials, or error messages. Fatal errors retain Node's default failure/exit
behavior; its native stderr stack is not replaced by the sanitized JSONL record.
Treat native stderr separately when sharing evidence.

## Independent artifact

Keep frozen `pi-chat-exchange-gate-b1` 0.1.5 unchanged. Build a separate
`pi-chat-exchange-gate-b1-debug` (`0.1.0-debug.3`) after `pnpm run build`,
with both commands run from `packages/pi-chat-exchange/`:

```sh
node scripts/package-debug-plugin.mjs \
  --root /absolute/isolated-debug-root \
  --dependencies /absolute/existing-materialized/node_modules
```

The isolated root must already contain `mcp-config/binding.json` whose Store is
under that root. Symlinked config/Store ancestors and linked input trees are
refused. The root must not be the home directory or under `~/.codex`. The builder
never installs dependencies and refuses an existing `marketplace/` output.

The output is `marketplace/plugins/pi-chat-exchange-gate-b1-debug/`; register only
its new marketplace/cache in the isolated Desktop CODEX_HOME. The contained
`./bin/launch` uses fixed `/opt/homebrew/bin/mise`, no downloads, and preloads a
strict Node `v24.21.0` guard in both launcher and actual server. A mismatch exits
78, without replacing the check with a preflight subprocess. This verifies the
running Node version, not binary provenance.

The production Store's capability policy (see `runtime-qualification.md`) does not
expand this isolated debug derivative's pin. Its fatal-monitor and debug-launcher
success tests run only on 24.21.0; 24.22.1 still must be refused with exit 78.
Production Host/MCP and local-plugin qualification are separate from those tests.

## Events and interpretation

- Shell/launcher: `LAUNCH_STARTED`, `NODE_RESOLVED`, `NODE_VERSION`,
  `SERVER_EXEC_STARTED`, `LAUNCH_FAILED`, `SERVER_EXITED`, `LAUNCH_EXITED`.
- Guard: `VERSION_GUARD_STARTED`, `VERSION_GUARD_PASSED`, `VERSION_GUARD_FAILED`.
- Server/transport: `SERVER_ENTRY`, `SERVER_CREATED`, `TRANSPORT_CREATED`,
  `TRANSPORT_CONNECTED`, `SERVER_READY`, `SERVER_STOPPED`.
- Protocol: `MCP_REQUEST_RECEIVED`, `MCP_RESPONSE_SENT`, `MCP_ERROR`,
  `MCP_INITIALIZE`, `MCP_INITIALIZED`, `MCP_TOOLS_LIST`, `MCP_TOOLS_CALL`.
- Tool: `TOOL_REGISTERED`, `TOOL_CALL_STARTED`, `TOOL_DISPATCH`,
  `TOOL_CALL_COMPLETED`, `TOOL_CALL_FAILED`. An `isError` tool result remains an
  unchanged returned result, not a thrown exception.
- Store/Authority composition: `STORE_OPEN_STARTED`, `STORE_OPEN_COMPLETED`,
  `AUTHORITY_CHECK_STARTED`, `AUTHORITY_CHECK_RESULT` (heartbeat callback),
  `OWNERSHIP_ACQUIRED`, `OWNERSHIP_RELEASED`. Fencing is not exposed by the current
  bound-port API: no internal Authority instrumentation is added to obtain it.
- Process: `PROCESS_SIGNAL`, `UNCAUGHT_EXCEPTION`, `UNHANDLED_REJECTION`,
  `PROCESS_EXIT`. SIGKILL cannot be observed. Guard and entrypoint exit/exception
  records can intentionally coexist for one PID; distinguish `component`.

`SERVER_READY` means transport connected, not client initialized.
`MCP_INITIALIZE` records request receipt, not handshake completion.
`MCP_INITIALIZED` records the client notification; verify initialize response and
`tools/list` separately. `NODE_RESOLVED` indicates the executing Node stage, not
an independent resolution/provenance guarantee. No log file is not proof that
Desktop rejected registration or that a chat used a specific backend.

## Limits and safe validation

This is development-only synchronous I/O without rotation/retention management;
monitor disk use and keep log directories private. Existing attacker-controlled
ancestors and same-user races are outside a private artifact's threat model.
Do not deploy this diagnostic artifact to production. No production Store access.

Direct protocol tests use fresh isolated fixtures (initialize, tools/list, valid
and invalid ping only). No real ACK is needed. Desktop installation/discovery is
not permission to send chat messages or invoke tools; if a message is needed to
continue runtime verification, stop and request authorization.
