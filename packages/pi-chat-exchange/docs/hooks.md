# Local message Hooks

CE 0.3 adds opt-in local Hooks for newly committed messages. Hooks can notify a local program without making that program part of message delivery, reception ACK, Pi runtime state, or Wayforge task completion. No window automation, remote command selection, persistent task queue, or exactly-once execution guarantee is provided.

## Event and routing

A `ce.message.committed.v1` event is created only after a Message and its Payload BLOB have committed successfully with disposition `CREATED`. `REPLAYED`, rollback, and indeterminate commit outcomes create no event. Event construction and scheduling happen outside the SQLite write transaction.

Rules match the committed recipient's complete Endpoint identity (`adapter` plus `endpointId`), not a display-name substring. This independently supports ChatGPT → Pi and Pi → ChatGPT rules. Disabled or nonmatching rules do not start a process.

## Configuration

Add an optional `hooks` array to the operator-controlled MCP binding, explicit `CE_ALLOWLIST` / legacy Pi allowlist, or each selected multi-session manifest registration. Absence means no Hooks and remains backward compatible.

MCP and Pi configurations are independent. ChatGPT → Pi rules belong in MCP binding `hooks`; in multi-session mode their recipients must be active registered Pi Endpoints. Pi → ChatGPT rules belong in Pi allowlist `hooks`, or in the relevant `registrations[]` item's `hooks` in the existing `ce-multi-session-v1` manifest. Each registration uses the same rule grammar below, with `recipient` exactly equal to `manifest.chatgptEndpoint`. There is no global manifest `hooks` field. Pi projects only that registration's rules; Hooks create no new permissions.

In legacy multi-session and live v1 mode, effective rules are the identical, enabled static rules present in both the loaded snapshot and current selected generation. Registration identity, Endpoint, epoch and active status must remain valid in both; MCP rules also require the corresponding registered recipient to remain admitted. Removing, disabling or changing a rule can narrow execution immediately. Adding or changing current rules cannot widen the loaded snapshot: additions require reloading the owning process/configuration through its normal lifecycle. Live v2 adds the sender consent and generation checks described below.

The JSON below is an authoring fragment, not a complete configuration. Multi-session MCP binding and manifest are separate, digest-paired files in an immutable generation. Prepare authoring inputs offline and publish through the operator-controlled generation path; never edit content-addressed files in place. `/ce-tunnel convert` and `/ce-tunnel register` do not add Hooks. The native manager described below edits explicitly upgraded live v2 policies.

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

## Native management for live v2

Use `/ce-hooks` or `/ce-tunnel hooks` in an interactive Pi TUI. Choose Pi → ChatGPT to edit the current native Session's outbound array, or ChatGPT → Pi to edit the MCP sender binding. The manager lists rules and supports add, edit, enable, disable and remove. Add/edit accepts one complete JSON rule using the schema above; the review screen shows the whole candidate, executable, literal arguments, immutable pair identity and confirmed target incarnations. Nothing is saved until the operator explicitly approves that candidate. Headless invocation remains inspection only.

Existing live v1 profiles require an explicit offline v1 → v2 upgrade. Close old Pi bindings through their normal lifecycle and stop the shared transport separately before upgrading. The manager requires the real STOPPED Profile lock and never stops a process, releases another Session or takes over ownership itself. The upgrade appends one marker to the same history and preserves its original prefix, registrations, tombstones, epochs, read/ACK permission generations and Pi Hook arrays. An old reader fails closed after the marker; selecting an old binding cannot undo the upgrade. Inbound sender consent starts empty.

In v2, any change to the current Pi's Hook array advances that registration's Hook generation. All old runner starts for that Session are denied until official reload, including rules whose bytes stayed the same. Ordinary send, inbox, read, ACK and renewal continue under their existing identity and permission checks before reload begins. Unrelated Sessions keep their own Hook generations. Reload transfers the existing mapping and mutex through the normal lifecycle; a failed reload does not revive the old runner or acquire another Owner.

For incoming Hooks, approval commits the complete MCP sender binding generation and exact per-rule target Endpoint/native Session/epoch tuples. It never uses the receiving Pi's outbound Hooks as permission. A new process cannot substitute a reauthorized target's newer epoch for the confirmed one. Disabling then restoring an identical binding advances consent generation and does not revive an old process. The loaded immutable pair must still be selected by the Profile, and each queued child rechecks current consent immediately before admission.

Sender configuration and upgrades publish chain facts before the separate checked Profile rename. A crash or uncertain filesystem result may leave a committed operation with activation pending. Preserve the reported operation ID and candidate path. Choose the manager's pending-deployment reconciliation entry and enter `{"bindingPath":"/exact/reported/candidate.yaml","operationId":"exact-reported-operation"}`. Review and explicitly confirm the recovered candidate. The manager verifies the published intent, locator, original Profile scope and current consent/targets, then completes only the checked Profile selection under the STOPPED lock. It publishes no new grant or upgrade marker and refuses changed or superseded scope. This entry remains available when a committed upgrade makes the old selected v1 reader refuse. Do not repeat the grant, rewrite history or edit the Profile manually. Saving reports configured, adopted, eligible and executed separately. Explicit reload/load and transport start remain separate operator actions.

The Safe test entry requires its own confirmation and executes a fixed benign local fixture with synthetic metadata-only stdin. It never runs a configured command or personal script and does not verify that script's behavior. Actual configured Hook execution is recorded only in the local execution log below.

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

In an interactive TUI the command opens the native manager above; without a native UI it displays the rules loaded by this process, including Hook ID, event, exact recipient, command, fixed args, timeout, enabled state and source. `configured` counts loaded rules; `active` counts the subset currently admitted for execution. Admission checks do not load new rules into a captured runner or refresh its generations. Environment values are omitted. MCP writes a corresponding sanitized active/configured summary to stderr at startup.
