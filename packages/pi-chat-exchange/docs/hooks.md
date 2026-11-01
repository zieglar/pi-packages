# Local message Hooks

CE 0.3 adds opt-in local Hooks for newly committed messages. Hooks can notify a local program without making that program part of message delivery, reception ACK, Pi runtime state, or Wayforge task completion. No window automation, remote command selection, persistent task queue, or exactly-once execution guarantee is provided.

## Event and routing

A `ce.message.committed.v1` event is created only after a Message and its Payload BLOB have committed successfully with disposition `CREATED`. `REPLAYED`, rollback, and indeterminate commit outcomes create no event. Event construction and scheduling happen outside the SQLite write transaction.

Rules match the committed recipient's complete Endpoint identity (`adapter` plus `endpointId`), not a display-name substring. This independently supports ChatGPT → Pi and Pi → ChatGPT rules. Disabled or nonmatching rules do not start a process.

## Configuration

Add an optional `hooks` array to the operator-controlled MCP binding, explicit `CE_ALLOWLIST` / legacy Pi allowlist, or each selected multi-session manifest registration. Absence means no Hooks and remains backward compatible.

MCP and Pi configurations are independent. ChatGPT → Pi rules belong in MCP binding `hooks`; in multi-session mode their recipients must be active registered Pi Endpoints. Pi → ChatGPT rules belong in Pi allowlist `hooks`, or in the relevant `registrations[]` item's `hooks` in the existing `ce-multi-session-v1` manifest. Each registration uses the same rule grammar below, with `recipient` exactly equal to `manifest.chatgptEndpoint`. There is no global manifest `hooks` field. Pi projects only that registration's rules; Hooks create no new permissions.

In multi-session mode, effective rules are the identical, enabled static rules present in both the loaded snapshot and current selected generation. Registration identity, Endpoint, epoch and active status must remain valid in both; MCP rules also require the corresponding registered recipient to remain admitted. Removing, disabling or changing a rule can narrow execution immediately. Adding or changing current rules cannot widen the loaded snapshot: additions require reloading the owning process/configuration through its normal lifecycle.

The JSON below is an authoring fragment, not a complete configuration. Multi-session MCP binding and manifest are separate, digest-paired files in an immutable generation. Prepare authoring inputs offline and publish through the existing operator-authorized controlled generation path; never edit production content-addressed files in place. No automatic migration or Hook configuration CLI is provided. `/ce-tunnel convert` and `/ce-tunnel register` do not accept flags to add Hooks.

```json
{
  "hooks": [
    {
      "id": "pi-notify",
      "event": "ce.message.committed.v1",
      "recipient": { "adapter": "pi", "endpointId": "pi/main" },
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/local-hook.mjs", "--fixed-argument"],
      "timeoutMs": 30000,
      "enabled": true
    }
  ]
}
```

- `id` is stable and unique within the loaded configuration.
- `event` must be exactly `ce.message.committed.v1`.
- `recipient` requires both `adapter` and `endpointId`.
- `command` is a normalized absolute path. `args` contains only fixed local strings. CE uses direct process execution with `shell:false`; Payload or remote text is never interpolated into either.
- `timeoutMs` defaults to 30,000 and accepts 1,000–60,000. `enabled` defaults to `true` when the rule is present.
- Do not put credentials in arguments or environment variables. Hook authorization is separate from `payloadRead.enabled` and `ack.enabled`.

Invalid MCP Hook configuration is refused before Store startup. Pi reports invalid Hook configuration with zero active Hooks while leaving messaging available.

## stdin envelope

The child receives one UTF-8 JSON document on stdin, followed by EOF. It contains references and metadata only: `schemaVersion`, `event`, `eventId`, `eventKey`, `messageId`, `exchangeId`, `sender`, `recipient`, `createdAt`, `payloadDigest`, and `payloadLength`.

There is no `payload`, `payloadText`, command field, capability, Session ID, fencing token, host secret, or environment credential. No correlation ID is invented because the current Message protocol does not provide one. Digest and length describe the original UTF-8 Payload BLOB, not the JSON envelope.

A script that needs message text must use an independently authorized Endpoint through the formal CE payload-read interface. Hook configuration does not inherit or create read authority.

## Execution and failure behavior

Each runner has at most one active child and 32 pending items. Overflow is recorded as `SKIPPED_QUEUE_FULL`. Child stdout and stderr are ignored so they cannot corrupt MCP stdio or leak into CE logs. Only a minimal environment is supplied.

The runner's optional admission gate checks current policy before each actual child starts, including queued work. A denied check records `SKIPPED_POLICY_DENIED` without spawning a child; it does not cancel an already running child.

The runner records `SUCCEEDED`, `FAILED`, `SPAWN_FAILED`, `TIMEOUT`, `SKIPPED_QUEUE_FULL`, `SKIPPED_SHUTDOWN`, and `SKIPPED_POLICY_DENIED` as applicable. A failed, missing, or timed-out program is never retried automatically and does not change the committed send result, Delivery, ACK, Pi state, or Wayforge completion. Shutdown skips unstarted work; startup never scans old Audit rows or replays scripts. Timeout or a missing final record does not prove the script had no side effects.

Shutdown waits for the active direct child within its configured timeout while CE releases its ownership independently. Timeout sends SIGKILL to that child; it is not a sandbox or a guarantee that descendants or external side effects stopped.

Execution records are local append-only JSONL at `<store.directory>/ce-hooks/executions.jsonl`. They contain Hook ID, event key, Message ID, start/end timestamps, status, duration, exit code/signal, and timeout where applicable. They never contain Payload text or child stdout/stderr. Recording failure is isolated from CE message state.

## Audit

Pi startup reports the active and configured Hook counts when Hook configuration is present. In Pi TUI, run:

```text
/ce-hooks
```

The command displays the loaded rules: Hook ID, event, exact recipient, command, fixed args, timeout, enabled/disabled state, and configuration source. `configured` counts loaded rules; in multi-session mode `active` counts the effective current subset, and the source is `selected multi-session profile registration`. It checks current policy for admission without loading new rules into the snapshot, and does not display environment-variable values. MCP writes a corresponding sanitized active/configured summary to stderr at startup.
