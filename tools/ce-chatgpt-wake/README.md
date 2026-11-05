# CE ChatGPT wake

`wake.py` provides two explicit modes: a metadata-only CE Hook system notification (`--hook`), and the legacy test-only ChatGPT conversation driver (`--record` / `--task`). The modes use separate configuration and cannot be combined.

## Hook system notification (disabled example)

The Hook mode accepts one bounded UTF-8 JSON event on stdin, requests a macOS system notification, and exits. It does not use the ChatGPT input or accessibility driver. No CE body is accepted or read, no ACK or reply is sent, and metadata grants no CE permission. The banner contains fixed text plus Message and Exchange identifiers; treat these identifiers as information exposed on the local notification surface.

This implementation is locally tested with the native notification boundary replaced. Production Hooks remain disabled; actual macOS banner visibility, notification permissions and user attention have not been tested.

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
