# CE ChatGPT wake

`wake.py --hook` accepts a CE metadata event. Its six-field configuration requests a system notification; an explicit private `autoWakeConfig` opts the same existing Hook into guarded desktop wake with an interactive fallback. `--record` / `--task` remains a separate direct conversation-driver mode.

## Hook system notification (disabled example)

The Hook mode accepts one bounded UTF-8 JSON event on stdin, requests a macOS system notification, and exits. It does not use the ChatGPT input or accessibility driver. No CE body is accepted or read, no ACK or reply is sent, and metadata grants no CE permission. The banner contains fixed text plus Message and Exchange identifiers; treat these identifiers as information exposed on the local notification surface.

The six-field path is tested with the native notification boundary replaced. The disabled rule below is an example; its enabled state says nothing about a particular installed profile. A successful native request does not prove banner visibility or user attention.

Use a separate trusted local JSON config with exactly these six fields (replace the fixture identifiers and paths):

```json
{
  "hookSenderAdapter": "pi",
  "hookSenderEndpointId": "pi/session-selected",
  "hookRecipientAdapter": "chatgpt",
  "hookRecipientEndpointId": "chatgpt/selected",
  "hookExchangeId": "ho_01M6D7BPKRDG38PE854761T7MN",
  "stateDir": "/absolute/private/wake-journal"
}
```

`stateDir` must be an absolute normalized path to an operator-controlled private directory owned by the current user (0700). Keep its parent directories under operator control. Select the existing wake journal directory if earlier legacy attempts must be recognized: history in other directories is not discovered. Preserve all journal, lock and temporary recovery files across restarts; deleting them or choosing a new directory removes deduplication history. Config and script paths are static local authority and must not be derived from event metadata.

A static CE rule example follows. It is **disabled**, is documentation only, and has not been published to any Session or Profile:

```json
{
  "id": "chatgpt-system-notice",
  "event": "ce.message.committed.v1",
  "recipient": {"adapter": "chatgpt", "endpointId": "chatgpt/selected"},
  "command": "/absolute/runtime/bin/python3",
  "args": ["-B", "/absolute/checkout/tools/ce-chatgpt-wake/wake.py",
           "--config", "/absolute/private/hook.json", "--hook"],
  "timeoutMs": 10000,
  "enabled": false
}
```

The stdin limit is 16384 bytes. The event must have exactly the eleven documented CE fields: `schemaVersion`, `event`, `eventId`, `eventKey`, `messageId`, `exchangeId`, `sender`, `recipient`, `createdAt`, `payloadDigest`, `payloadLength`. Duplicate fields and extra data are rejected. This receiver supports endpoints with exactly `adapter` and `endpointId`; endpoint extensions such as `instanceId` are conservatively refused. Schema version 1, the exact event name, CE ULID patterns, matching Exchange/audit event key, lowercase SHA-256 and a nonnegative safe-integer payload length are required. Only the exact configured Pi sender → ChatGPT recipient and Exchange pass. `createdAt` must be a valid UTC ISO timestamp (`Z` or `+00:00`), at most 120 seconds old and at most 5 seconds ahead. Freshness filters delayed events; it does not authenticate them or establish delivery.

The nonblocking lock serializes attempts in the selected directory. `hook-<MessageID>.json` records an attempt durably before the native call. Matching repeats return the saved result without another call. Conflicting metadata, any legacy `<MessageID>.json` attempt, unsafe/corrupt state or leftover temporary recovery file refuses a new notification. Interrupted attempts and timeouts remain `UNKNOWN` and are never retried automatically. The fixed `/usr/bin/osascript` command uses a constant script, passes text as argv data, suppresses subprocess output and has a five-second timeout.

A result of `notificationRequest: REQUESTED` / journal stage `NOTIFICATION_REQUESTED` means only that the native request returned successfully. It does not prove a banner was visible, the user saw it, ChatGPT read anything, or a task completed. `UNKNOWN` exits with failure and retains the attempt. Existing Hooks consent and CE body/ACK authorization still apply separately.

Isolated tests (the native notification command is mocked):

```sh
python3 -B -m unittest discover -s tools/ce-chatgpt-wake -p test_hook.py -v
python3 -B -m unittest discover -s tools/ce-chatgpt-wake -p test_wake.py -v
```

## Guarded Hook configuration and explicit-only source default

This source revision defaults to `conversationGuard.mode: explicit-only`. Production state is recorded in the dated implementation/cutover reports; configuration examples do not establish activation. Deploy only within an explicit cutover authorization.

The private `auto-wake.json` retains its existing required fields. `conversationGuard` accepts either `mode` alone, or `mode`, `targetSelection: desktop-at-intake`, and `captureAfterAuditSequence` together:

```json
{
  "stateDir": "/absolute/private/owner/state",
  "profilePath": "/absolute/selected/tunnel.yaml",
  "packageRoot": "/absolute/installed/node_modules/@zieglar/pi-chat-exchange",
  "nativeSessionFile": "/absolute/current/native-session.jsonl",
  "python": "/absolute/bin/python3",
  "node": "/absolute/bin/node",
  "agentDesktop": "/absolute/bin/agent-desktop",
  "terminalNotifier": "/absolute/bin/terminal-notifier",
  "ownerDirectory": "/absolute/private/owner",
  "conversationMarker": "EXACT-AUTHORIZED-CONVERSATION-MARKER",
  "maxWaitSeconds": 60,
  "notificationTimeoutSeconds": 120,
  "afterAuditSequence": 123,
  "conversationGuard": {"mode": "explicit-only"}
}
```

Use private 0600 files and 0700 owner/state directories. `ownerDirectory` contains `config.json`, `auto-wake.json`, `tools/ce-chatgpt-wake/{wake.py,auto_wake.py,notification.py,conversation_guard.py,resolve-runtime.mjs}` and the existing `tools/ce-ovis-desktop/{bridge.py,lifecycle.py}`. The receipt-target installation also adds `receipt_target.py`. Preserve the existing audit boundary and attempt journals. No configuration contains default task titles or endpoint/session/window identities.

Endpoints, Exchange, CE Session, process/window IDs and titles are never defaults in this configuration. Each admission and mutating desktop command resolves the selected CE policy, current native lifecycle mapping, active registration, sole enabled matching Hook and existing live process marker. The native UUID and the mapped CE `ses_…` are different identities. The read-only store check matches committed metadata/audit, OPEN Exchange membership, attached unexpired leases and the sender's exact mapped CE Session/Participant. Confirmed release, process changes or ownership transfer refuse input.

Missing mode defaults to `explicit-only` and the worker records `SUPPRESSED / EXPLICIT_ONLY` before any desktop attempt or notification fallback. With the explicitly selected desktop-at-intake policy, `title-match` can use an immutable captured target and a prepared reply association; absent or invalid association remains `SUPPRESSED / SOURCE_BINDING_UNAVAILABLE`. The captured desktop is the user-selected target, not proof of the initiating conversation. The current production state and activation evidence must be verified separately.

`conversation_guard.check_title` checks the unique live conversation webarea title; duplicate/missing title, multiple windows, wrong window or incomplete snapshot refuse a match. A matching title alone grants no automation authority. The title-mode flow also checks the receipt association, live authority and the existing window, marker, idle and draft constraints. A title can be duplicated or renamed, and immediate checks cannot eliminate switching during an action.

Existing lower-level desktop and notification routines are retained for their prior state-machine tests. Their window/PID/process-generation, marker, idle/empty draft, preaction authority/snapshot checks, global desktop lock, possible-input stop and exact-button one-use checks are unchanged. The new worker gate runs before both automatic and button fallback paths. A button cannot override a title mismatch, unavailable source binding or explicit-only mode. New integration tests use the real gate; dormant desktop-path regression tests explicitly substitute a test-only gate result and do not establish a real source binding.

`conversation_guard.explicit_fetch(selection, state_dir, execute_tool)` is a synchronous library boundary for a future trusted manual-selection adapter. It is not a registered tool, UI, CLI or CE authority grant. The host must verify an actual user gesture, supply its current authorized synchronous tool executor and preserve existing approvals. A selection requires exactly `kind: HUMAN_SELECTED_REPLY`, `selectionId`, reply `messageId`, immutable `originalRequestMessageId`, `exchangeId` and `taskId`. These human-selected correlation fields are recorded as `HUMAN_SELECTION_NOT_SOURCE_ATTESTATION`; they are not proof of send-time origin.

The helper durably records `READ_MAY_HAVE_OCCURRED`, calls only `ce_read_payload` for the selected reply ID and returns its result to the authorized caller. It does not scan Inbox, ACK, act on the desktop or store payloads. Refusal is distinct from `READ_RETURNED`; that state means only the executor returned and does not prove task completion. Duplicate selection returns recorded state without another read; changed correlation, corrupt state or uncertain outcome fail closed. This adapter is not a registered UI; see `EXPLICIT_RETRIEVAL.md` for the existing per-message manual path. A receipt-selected desktop target is not a trustworthy actual-origin binding.

The earlier claim/dispatch journals still prevent duplicate worker effects. The worker keeps CE send `CREATED`, suppression, explicit-read and task-completion evidence separate. Retain all state; do not delete it to retry. Optional neutral notifications were not added, so explicit-only never enters the old notification-to-desktop route.

The earlier auto-wake acceptance is recorded in its dated report. The explicit-only cutover below preserves the existing audit boundary and journals, requires no CE test messages or GUI submissions, and defaults to a closed-entry rollback. It does not alter Tunnel or Hook policy.

## Operator retrieval and authorized explicit-only cutover

[Explicit retrieval](EXPLICIT_RETRIEVAL.md) gives copyable requests usable now in the existing recipient's authorized Pi/ChatGPT session. The user selects one exact Message ID; discovery is a separate bounded metadata-only request and stops before payload reading. No extra tool registration, authority, controller, auto-ACK or desktop input is added. Unknown relations stay UNVERIFIED. Existing tool output may enter host transcript; no additional payload files/logs are created.

`activate_explicit_only.py` performs one authorized local cutover using a private frozen source directory, an exact baseline manifest and a new private backup directory. The manifest has exactly `files` (the eight existing runtime/config paths listed by `BASELINE_FILES`) and `source` (`auto_wake.py` and `conversation_guard.py`) SHA-256 maps. Source/installed files must be private regular files. Existing owner, actual leases, terminal claims and free admission/desktop locks are checked before changes.

The installer briefly closes the existing Hook entry with an empty configuration, drains old entry processes while holding the existing locks, installs the guard module before the driver, explicitly sets the mode, saves rollback evidence and restores the original entry pointer last. During maintenance, local Hook execution can refuse; CE messages and normal send results remain durable. It preserves watermark and journals. Any failure after closure keeps the entry closed; it never automatically restores old auto-input code.
Owner identity and both attached CE leases are rechecked again immediately before reopening. A changed owner or expired lease leaves the maintenance gate closed; a prepared evidence file never overrides this final check.

```sh
python3 -B /private/reviewed/tools/ce-chatgpt-wake/activate_explicit_only.py \
  --root /absolute/private/hook --source /private/reviewed/tools/ce-chatgpt-wake \
  --baseline /private/baseline.json --backup /absolute/private/new-backup
```

Safe rollback uses the same reviewed script with `--root /absolute/private/hook --close-entry /absolute/private/new-backup/activation.json`. After verifying the selected private owner directory and recognized entry shape, it closes ingress first, then reports installed drift, unsettled claims and active/unknown process diagnostics. Held locks, drift or unsettled claims cannot prevent closure. It does not cancel already-admitted work; reconcile any reported activity separately. No messages/journals are deleted and old automatic input is never restored. Confirm actual installed hashes/config after cutover; `activation.json` is prepared before reopening and alone is not proof of successful activation.

Focused checks: `python3 -B -m unittest test_conversation_guard test_auto_wake test_integration test_hook test_wake test_notification test_explicit_cutover -q` from this directory. Cutover tests substitute only OS/runtime probes, perform real private file/lock operations, and exercise installed modules in temporary fixtures with desktop and notification boundaries forbidden.

## Legacy conversation test integration

The remaining instructions describe the separate legacy mode. Pi creates a CE message, then sends one fixed desktop notice to one explicitly selected ChatGPT conversation. ChatGPT must read the actual CE Payload and reply through CE. Pi reads, verifies and ACKs the reply before the next round. CE ACKs remain reception evidence, never proof of task completion.

The legacy mode requires the installed Pi1.3.0/CE0.3.0 modules, Node24.21.0, Python3.11+, agent-desktop1.0.2/JSON2.5, existing Tunnel/ChatGPT connection and production Native cache. It reuses `../ce-ovis-desktop` transport, journals and bounded cleanup; no CE core/configuration change. Semantic Accessibility set-value/click only; no headed fallback, clipboard or permission bypass.

## Runtime installation and coexistence

Use a dedicated common prefix for the exact runtime versions; do not build or import CE from this checkout (its core package remains the historical 0.2.2 candidate):

```sh
npm install --prefix /absolute/private/runtime @zieglar/pi-chat-exchange@0.3.0 @earendil-works/pi-coding-agent@1.3.0
```

Set `modules` to `/absolute/private/runtime/node_modules`. Install the official Tunnel Client separately and qualify its exact version; the accepted Cloud runs used Client 0.0.19 on macOS arm64. Pin agent-desktop 1.0.2 / JSON 2.5 and provide a trusted Native 0.1.0 cache in the isolated HOME. These scripts use internal Pi SDK and CE module paths pinned to those versions; newer releases require a fresh compatibility review.

## Portability and explicit identity

Use absolute paths for every filesystem field, including desktop state and namespace paths. JSON does not expand `~`, `$HOME` or shell expressions. The config-file CLI argument resolves from the invoking cwd; configured paths do not. Executables must be absolute native binaries, not PATH names, shell commands or wrappers. `agentDesktop` must be the detached socket host binary (or a symlink to it) for verified cleanup. Refer to the [shared portability boundary](../ce-ovis-desktop/README.md#portable-configuration-boundary) for path grammar, Native installation, process checks and environment precedence.

Preparation must run using the exact binary configured as `node`. Both supervisors discard inherited `CE_*` settings before setting their isolated profile/client, HOME and XDG config directory; the desktop child receives its exclusive TMPDIR and internal parent/stop signals. No operator-supplied CE environment variable is needed for the documented supervisor flow. The installed runtime, local selected profile and its credential references must be prepared on the target machine; never copy an old Store, Session or credential.

This driver supports the recorded **Chinese ChatGPT UI**: input `询问 ChatGPT`, send `发送`, and busy controls `停止` / `停止生成` (the recorded `Stop generating` busy indicator is also recognized). English input/send labels are unsupported. Inspect fresh read-only window/snapshot output before any CE send, confirm one exact conversation marker outside the input and an empty idle draft, then record that machine’s PID/process instance/window title and ID. `ChatGPT` and JSON 2.5 are fixed supported application contracts. Accessibility and any macOS Automation prompts must be explicitly granted to the installed executable/host; no permission bypass is available.

Desktop config also requires **`targetEndpoint`** (the exact ChatGPT endpoint from the selected CE profile) and **`replyEndpoint`** (equal to the peer config’s `endpointId`). For example, `chatgpt/selected` and `pi/wake-selected`. There is no default or alias fallback. The peer compares both to `publication.json` before loading CE tools or sending, and `wake.py` checks every record against that explicit operator authorization before input. `pi/main` is not `pi-main`. Use fresh round IDs/nonces per authorized window; never substitute a saved Message ID or delete attempt journals.

If the normal receiver uses a different renamed Client binary, add its absolute path to `existingClientPaths` in the peer/supervisor config. Automatic checks cover standard names, the selected Client, listed alternate paths and their symlink targets; they cannot infer unknown renamed copies. Independently verify normal receiver STOPPED before the window. No inventory process is terminated by this check.

The supervisor refuses any existing `tunnel-client run` process. It temporarily uses the existing Cloud identity through an isolated profile/Store; it cannot run alongside the normal receiver on that identity. Before a separately authorized E2E window, normally stop the owned transport and verify STOPPED. Keep it stopped until the test supervisor confirms cleanup, then restore the normal receiver through its normal activation/start workflow. No new Tunnel or MCP connection is needed. Loading or reloading the coordinating Pi extension does not itself authorize a desktop window or run these scripts.

Keep operator configuration and evidence in private0700 directories. `wake.py --config DESKTOP.json --record CREATED.json` accepts only `{testId,messageId,to,replyTo,disposition}` with `disposition:CREATED`. No Payload is accepted. The fixed notice includes only identifiers and instructions to read CE tools. A private per-Message-ID journal is persisted before input and submit. Existing journals return without desktop action, including UNKNOWN outcomes; do not delete them to retry.

Desktop config fields: `agentDesktop`, exclusive `desktopTmpDir`, `desktopSession`, `windowId`, `pid`, `processInstance`, `windowTitle`, `conversationMarker`, `stateDir`, `maxWaitSeconds`, `pollSeconds`. Use fresh `list-windows --app ChatGPT` and scoped snapshots to determine identity. The driver requires one matching webarea, the conversation marker and exact input/send names. Empty placeholder text is normalized; any draft or busy ChatGPT blocks a new notice. After submit the send button may become Stop; submitted text plus cleared input is the notice evidence. Never infer processing success from the desktop result.

For end-to-end testing, `peer.mjs CONFIG.json` uses real Pi Session extension tools. Config adds `modules`, `runDirectory`, `isolatedHome`, `existingProfile`, `node`, `python`, `client`, `endpointId`, `testId`, `deadline`, `bridge` (wake.py), `desktopConfig` and exactly two `rounds:[{testId,nonce}]`. Existing `ce-ovis-desktop/ce-peer.mjs prepare CONFIG.json` prepares a fresh isolated Store/registration/native Session using the existing Cloud identity. Preparation consumes only the common preparation fields; no Ovis task placeholders are required. No new Tunnel or connection is created.

Example peer configuration (replace every placeholder; create the private desktop JSON separately):

```json
{
  "modules": "/absolute/private/runtime/node_modules",
  "runDirectory": "/absolute/private/window-01",
  "isolatedHome": "/absolute/private/window-home",
  "existingProfile": "/absolute/local/ce/tunnel.yaml",
  "node": "/absolute/runtime/bin/node",
  "python": "/absolute/runtime/bin/python3",
  "client": "/absolute/runtime/bin/tunnel-client",
  "bridge": "/absolute/checkout/tools/ce-chatgpt-wake/wake.py",
  "desktopConfig": "/absolute/private/desktop.json",
  "endpointId": "pi/wake-selected",
  "testId": "CE-WAKE-TEST-window-01",
  "deadline": "REPLACE_WITH_NEAR_TERM_UTC_ISO_TIMESTAMP",
  "rounds": [
    {"testId": "CE-WAKE-TEST-window-01-1", "nonce": "REPLACE_WITH_FRESH_RANDOM_VALUE_1"},
    {"testId": "CE-WAKE-TEST-window-01-2", "nonce": "REPLACE_WITH_FRESH_RANDOM_VALUE_2"}
  ]
}
```

Set desktop `targetEndpoint` to the exact selected profile recipient, for example `chatgpt/selected`; set `replyEndpoint` to `pi/wake-selected` for this example. Neither value is inferred from a window title. All other desktop fields are required as listed above. Choose a unique `desktopSession`, conversation marker and private state/temporary directory; obtain fresh identity from that machine, not this example. Run prepare with `/absolute/runtime/bin/node`, then the supervisor with the configured Python. Keep the prepared Node version/path unchanged for that window.

Run `python3 tools/ce-chatgpt-wake/supervise.py CONFIG.json`. It waits for actual Pi tool admission and control-plane poll health, then records READY. Create `runDirectory/start-request` only when the locked ChatGPT conversation is idle. Peer records send-attempt before calling real ce_send. Only CREATED permits wake. A failed/unknown notice stops the sequence; no send/wake retry. A successful notice is followed by polling the real CE Inbox, exact nonce/testId/inReplyTo reply validation and reception ACK. A completed file requires both rounds. User must not manually send an extra reminder during acceptance.

Stop via `runDirectory/stop-request` or deadline (at most15minutes). Supervisor owns and cleans only its process groups and exclusive desktop namespace. Uncertain host startup yields CLEANUP_UNCONFIRMED. Never resume an ended native Session: prepare a fresh run directory. Raw snapshots/logs/Store/credential references stay outside Git; public summaries retain only necessary outcomes and correlation.

Tests:

```sh
python3 -m unittest discover -s tools/ce-chatgpt-wake -v
node --test tools/ce-chatgpt-wake/*.test.mjs
```

A UI notice observed, ChatGPT processing indicator, CE send/ACK and validated reply are separate states. No ACCEPT without actual automatic ChatGPT tool-read/reply in two rounds. No unattended business automation or exactly-once guarantee.

The accepted real two-round run preceded the final exact-marker and supervisor evidence checks. Those changes were verified with saved snapshots and controlled local process fixtures, not another Cloud run. This integration review adds stop/ACK and supervisor interruption regressions; it does not extend the recorded Cloud or desktop-version coverage. Local process tests isolate the unrelated global Client inventory while exercising owned process cleanup; they do not probe or stop the user's live Client.
