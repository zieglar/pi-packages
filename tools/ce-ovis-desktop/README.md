# CE → Ovis test bridge

A bounded macOS CLI integration for Pi Host1.3.0 and the published Pi Chat Exchange0.3.0. It does not modify CE. `bridge.py` operates only the selected Ovis test conversation; `ce-peer.mjs` receives and returns messages through a real Pi Session's registered CE tools. `supervise.py` owns one deadline-limited existing-Tunnel window.

An additional **disabled-by-default** `intake.mjs` API supports explicit real tasks through the invoking Pi Session's registered CE tools. It reuses the same `bridge.py` and `execution.mjs`. It is not connected to a production Hook, command or background poller. The isolated test supervisor described below is a separate workflow.

Prerequisites: Ovis0.4.19, agent-desktop1.0.2/JSON2.5, Python3.11+, Node24.21.0, Pi1.3.0 and CE0.3.0 installed into a common node_modules directory. Accessibility permission is required. Physical input needs explicit operator authorization (`headedAuthorized:true`). The integration never silently enables it. Read `agent-desktop skills get desktop`, `skills get platform`, and the official [JSON contract](https://github.com/vercel-labs/agent-desktop/blob/main/docs/json-output.md).

Use the dedicated common-prefix installation described in [the wake runtime guide](../ce-chatgpt-wake/README.md#runtime-installation-and-coexistence): published CE 0.3.0 and Pi 1.3.0, not this checkout's historical core candidate. `modules` is that prefix's `node_modules`. The tools are repository utilities, not files installed by the CE npm package. The recorded Cloud E2E used official Tunnel Client 0.0.19 on macOS arm64; qualify a different Client/version independently. Absolute internal Pi SDK and CE module paths are pinned to the listed versions.


## Portable configuration boundary

All configured filesystem paths must be absolute, including `modules`, `runDirectory`, `existingProfile`, `isolatedHome`, `node`, `python`, `bridge`, task/config files, `agentDesktop`, `desktopTmpDir` and `stateDir`. JSON does not expand `~`, `$HOME` or shell expressions. The CLI config-file argument may be relative to the invoking shell; its contents must not depend on cwd. Use a fresh private run directory on each machine. Executables are operator-selected absolute native binaries (symlinks to that binary are acceptable), not shell commands, wrappers or PATH names. `agentDesktop` must identify the same native binary as its detached socket host so ownership cleanup can verify it. Supervisors preflight Node, Client, configured Python and desktop executable existence/permissions. Missing desktop dependencies report `DESKTOP_EXECUTABLE_REQUIRED` before namespace creation.

Run preparation with the exact Node executable configured as `node`; preparation refuses `PREPARE_NODE_MISMATCH` if they resolve to different binaries. The generated MCP command uses that runtime. The Node/MCP paths must also satisfy CE 0.3.0’s existing command-path grammar (absolute ASCII paths, spaces supported; no shell expansions). Install the matching Native 0.1.0 artifact for the target Mac architecture and use the published CE Native preparation/status commands before the window. Do not copy another machine’s credential files or Store. `existingProfile` must be a locally valid selected multi-session CE profile; preparation reads identity and credential *references*, never credential contents.

Client inventory checks recognize standard `tunnel-client run`, the configured `client` and its resolved symlink target. If the normal receiver uses another renamed copy, list every such absolute executable path in optional `existingClientPaths`, for example `["/absolute/normal-receiver"]`. Matching run processes cause `EXISTING_CLIENT_RUNNING`; the check never signals inventory processes. Unknown renamed copies cannot be identified automatically from an arbitrary process list. Before each window, independently confirm the normal receiver is STOPPED through its normal lifecycle and supply any alternate executable paths. Do not interpret an empty automatic inventory match as proof that every possible receiver is stopped.

The supervisor sets child `HOME=isolatedHome`, `XDG_CONFIG_HOME=isolatedHome/.config`, `CE_TUNNEL_PROFILE=runDirectory/tunnel.yaml` and `CE_TUNNEL_CLIENT_PATH=client`. It removes inherited `CE_*` overrides, including old allowlist/Store/test settings. Other environment variables and PATH are inherited, but do not select the explicit binaries. The desktop child additionally sets `TMPDIR=desktopTmpDir`; `CE_BRIDGE_PARENT_PID` and `CE_BRIDGE_STOP_FILE` are internal stop signals supplied by the peer. They are not operator prerequisites. Launch the peer through `supervise.py`; a direct diagnostic invocation must explicitly select the isolated profile and a clean CE environment.

Both drivers currently require the recorded **Chinese application UI**. Ovis selectors include `消息`, `发送消息`, `停止 Agent` and `聊天`; see the wake guide for ChatGPT labels. `Ovis` / `ChatGPT` app identities, JSON 2.5, macOS system utilities, test-ID prefixes and the isolated Exchange namespace are supported product/platform constraints. English UI is not supported by this version. Before allowing CE traffic, inspect read-only snapshots on the target machine, confirm those labels and exact conversation identity, and configure fresh PID/process-instance/window IDs. Accessibility and any macOS Automation/physical-input prompts must be granted by the operator to the actual installed executable/host; no script grants them.

Endpoint strings are exact identities: `pi/main` and `pi-main` are distinct. `endpointId` configures this fresh Pi registration; the ChatGPT recipient comes from the selected profile and is recorded in `publication.json`. No guessed endpoint, Gateway address or port is used. Store/Session paths are generated under the configured run directory; CE creates Message IDs, and task/result idempotency keys derive from the explicitly authorized test IDs. Keep journals and attempt markers; never reuse an old run, Message ID or uncertain operation to retry.

## Desktop configuration

Keep configuration, task and runtime state outside Git in an owned0700directory. Example:

```json
{
  "agentDesktop": "/absolute/path/to/agent-desktop",
  "desktopTmpDir": "/private/operator-state/ax-tmp",
  "desktopSession": "ce-ovis-test",
  "windowId": "w-123",
  "pid": 123,
  "processInstance": "value from list-windows",
  "conversation": "ovis-test-workspace 的对话",
  "allowedTaskId": "CE-OVIS-TEST-example-01",
  "agentButtonPrefix": "pi: ovis-test-workspace pi-2 ·",
  "allowedTextSha256": "sha256 of UTF-8 task.text",
  "stateDir": "/private/operator-state/tasks",
  "headedAuthorized": true,
  "maxWaitSeconds": 120,
  "pollSeconds": 1
}
```

Obtain process/window identity with `agent-desktop list-windows --app Ovis`. Select a separate empty Ovis test Agent; never bridge the coordinating Pi session into itself. The script refuses another conversation, nonempty draft, active turn or incomplete snapshot. Reconfigure only after observing a relaunched app/window. Never retain refs across UI mutations.

The target pane must be an **Agent chat**. A shell workspace can expose the same `消息` field and `对话` log; a bare Enter can execute its draft. Real tasks therefore require a local `agentButtonPrefix` beginning with `pi: <target> `, a unique matching live Agent button, and a matching conversation after selection. Missing/ambiguous Agent identity is refused before any task input. Legacy echo mode retains optional Agent selection.

The driver types short text pieces without literal newlines. Each newline focuses the current input and sends `Shift+Return` to the configured Ovis window to avoid bare-Enter submission. It observes the exact cumulative draft after each piece, waiting up to `inputSettleSeconds` (maximum/default 3 seconds) for delayed input. A stable prefix does not prove loss: there is no automatic retyping. A different draft or expired wait stops with `CHUNK_READBACK_MISMATCH`, leaving the draft and no automatic replay. Task and execution deadlines apply to observations, input and click calls.
At task start, optional `agentButtonPrefix` may select one uniquely matching test Agent from a fresh Ovis snapshot and reopen its Chat panel. A new snapshot must then match the exact configured conversation before any text input. Ambiguous targets are refused. This selection is not repeated after text entry or submission; later target drift stops execution. Results expose only fixed uppercase failure codes, never raw desktop diagnostics.

Task schema is closed:

```json
{"schemaVersion":1,"taskId":"CE-OVIS-TEST-example-01","target":"ovis-test-workspace","testOnly":true,"text":"中文 English 🚀\n第二行 ✅","deadline":"2030-01-01T00:00:00Z"}
```

Set an actual near-term deadline; desktop execution is capped at300seconds. Task ID and exact text digest must match the operator config. Run:

```sh
python3 tools/ce-ovis-desktop/bridge.py --config /private/operator-state/desktop.json --task /private/operator-state/task.json
python3 -m unittest discover -s tools/ce-ovis-desktop -v
node --test tools/ce-ovis-desktop/*.test.mjs
```

The driver uses fresh snapshots around actions. Ovis's semantic `set-value` did not change its React input in actual testing. Explicitly authorized headed input uses short chunks and checks the cumulative draft after every chunk; single long Unicode input lost content in actual testing. Full draft equality is mandatory before the one send click. The response must have the task-specific end-marker and idle/send UI. Text stability alone is UNKNOWN. Read-only observations cannot prove model correctness or remote business completion.

The0600task journal and flock serialize this local bridge. A task is journaled before any input and before send. Repeating the same task returns its saved outcome without another desktop mutation, even when outcome is UNKNOWN. Same ID/different body is refused. Do not delete journals to retry. This is a conservative local no-replay rule, not distributed exactly-once or protection against a human independently submitting the same content.

## Explicit current-Session task intake (not activated)

`createIntake({config,getSessionId,callTool})` returns an async function that accepts one explicit Message ID. `getSessionId()` must synchronously return the invoking Pi Session ID. `callTool(name,args)` must execute that Session's **registered** `ce_read` / `ce_read_payload` tools and return their unchanged Pi results (`details`, `content`, `isError`). Use the current tool context, with its existing CE mapping and grants. A callback that loads another Session, creates a Host or reads a Store directly violates this contract. This API creates no new CE permissions. It performs no ACK or result send.

Local policy must explicitly set `enabled:true` and `taskMode:"execute"`. Omission leaves intake disabled before any CE read. Required policy fields are:

- `runtimeSessionId`, `exchangeId`, `from`, `to`: exact current Session and CE identities, supplied locally.
- `activatedAt`: timezone-qualified activation time; `afterAuditSequence`: the audit boundary observed at activation, so messages from that boundary or earlier are refused even within the same timestamp.
- `maxAgeSeconds`: a positive value up to 300. Metadata must be at/after activation, no later than the current clock and within this freshness limit.
- `runDirectory`: an existing owned 0700 directory. Preserve it across controller restarts; changing/deleting journals to retry defeats the local no-replay rule.
- `python`, `bridge`: trusted absolute executable/script paths; `tasks`: 1–8 local entries `{taskId,taskFile,desktopConfig,taskPayloadSha256}` using absolute paths. Keep task and desktop JSON files owned 0600, outside Git. The digest binds the exact incoming UTF-8 JSON bytes, including whitespace.

Real tasks have the same closed six-field schema:

```json
{"schemaVersion":1,"taskId":"CE-OVIS-TASK-example-01","target":"approved-workspace","testOnly":false,"text":"执行本地已审核的具体任务","deadline":"2030-01-01T00:00:00Z"}
```

Set a near-term deadline when authorizing the task. The local desktop config must also set `taskMode:"execute"`, the exact `allowedTaskId`, `allowedTextSha256`, conversation and existing desktop identity/physical-input permissions described above. Incoming task JSON cannot supply command paths, desktop config paths, new tools, routing or CE grants. The selected Agent retains its own permission and approval requirements. Legacy `testOnly:true` / `CE-OVIS-TEST-*` retains the echo behavior without an execution-mode opt-in.

The intake checks protected metadata before reading payload. It compares both reads' Message ID, Exchange, sender, recipient, digest, byte length, creation time and audit sequence, then verifies the actual UTF-8 payload bytes and local allowlist. A read refusal, absent/malformed metadata, changed Session, stale message or unauthorized body stops before bridge dispatch. It rechecks the invoking Session around asynchronous calls; the existing desktop runner monitors Session changes, stop requests and the task deadline.

Before dispatch, exclusive 0600 records durably bind Task ID to Message ID and payload digest under `runDirectory/intake/`. Same-message repeats return saved evidence after current CE/local authorization checks. Different messages using the same Task ID, conflicts, unsafe/corrupt state, a partial attempt after a crash and existing bridge history cannot dispatch again. An uncertain bridge call is saved as `STOPPED_NO_REPLAY`. These local records prevent automatic resubmission; they do not assert distributed exactly-once execution. Keep both intake records and bridge journals, including unknown outcomes.

Real-task evidence remains separate:

| Field | Meaning |
|---|---|
| `desktopSubmission` | `NOT_ATTEMPTED`, `UNKNOWN` or `OBSERVED` from prompt readback in the selected conversation |
| `agentProcessingObserved` | A matching submitted prompt and active Agent UI were actually observed; positive evidence survives a later idle view |
| `completionReport` | `REPORTED` only for an idle reply ending in this task's marker; otherwise `UNKNOWN` |
| `taskCompletion` | Always `UNVERIFIED`; task-specific external evidence is required to verify the business result |

For real tasks, bridge `ovisState:REPORTED` replaces the legacy echo test's `COMPLETED`. A desktop return or end marker is never business success. The intake's `BRIDGE_RETURNED` status means the bridge returned valid observation evidence. `desktopRunner` and `now` are injectable trusted test seams; tests run the real execution helper and bridge journal with a fake desktop, without invoking Ovis.

An observed `CE_HOST_UNAVAILABLE (MESSAGE_READ_REJECTED)` is an opaque visibility/correlation refusal. Missing messages, a different immutable recipient or creation at/before the join boundary can all cause it; an empty inbox does not distinguish them. Payload opt-in failures have a separate `CE_HOST_PAYLOAD_DISABLED` path. Confirm the sender's actual `ce_send` metadata against the current published Pi recipient and Exchange, then send a fresh correctly routed authorized task. Do not bypass the refusal through SQL, another Session or a direct Host, and do not ACK a body that was not authorized and read. Real-message acceptance remains unverified until such a read succeeds.

Do not use `ce-peer.mjs prepare/run` or `supervise.py` to attach this API to a live Session: those utilities create an isolated test Session and require the normal Tunnel receiver stopped. Production wiring and activation require a separate explicit authorization. This implementation does not alter the working wake Hook, installed copies, live policy or shared Tunnel.


## CE adapter

Operator config additionally contains `modules`, `runDirectory`, `existingProfile`, `endpointId`, `testId`, `deadline`, `taskPayloadSha256`, `python`, `bridge`, `desktopConfig`, `taskFile`, `node`, `client`, `isolatedHome`. Paths are trusted local operator configuration, never supplied by CE payload. `taskPayloadSha256` binds the exact UTF-8 JSON sent by ChatGPT; send the provided text verbatim.

For continuous testing, keep one Session/window and add `tasks`, an ordered array of 1–8 operator entries: `{taskId,taskFile,desktopConfig,taskPayloadSha256}`. Each desktop config authorizes only that task ID and text. The allowlist is loaded at startup; CE cannot add tasks or paths. Evidence and one-attempt result markers are separated under `runDirectory/tasks/<taskId>/`. Tasks execute serially in that order. Send the next task only after reading and ACKing the previous result. Unknown/failed desktop outcomes stop the sequence. Existing result markers are never replayed.

The peer checks an actual ChatGPT reception receipt in this run's isolated Store before ACKing or executing the next task. The receipt must match the previous result and have a strictly smaller audit sequence than the next message's creation event; otherwise `PRIOR_RESULT_ACK_REQUIRED` stops the run. Sequence ordering remains correct even when timestamps share a millisecond. This read-only check neither grants authority nor writes the Store. Early next-task messages are not queued for automatic replay; inspect evidence and prepare a new authorized window if needed.

Run `node tools/ce-ovis-desktop/verify.mjs /private/operator-state/config.json` after all result ACKs. It checks every task's actual message/receipt/digest/endpoints and that each previous ChatGPT ACK predates the next inbound task, under the same published runtimeSessionId. This is bounded serial testing, not arbitrary autonomous chat.

```sh
node tools/ce-ovis-desktop/ce-peer.mjs prepare /private/operator-state/config.json
python3 tools/ce-ovis-desktop/supervise.py /private/operator-state/config.json
```

Prepare reads the existing selected CE profile and references its credential file. It writes an isolated profile, immutable binding/registration, real Pi Session and new local Store; no Cloud resource or ChatGPT connection is created. The original profile/Store are not changed. Existing Client processes cause refusal. Supply a verified production Native0.1.0 cache in the isolated HOME; there is no driver fallback. Configs contain private paths and endpoint identities: do not publish them.

Only after the supervisor records READY and health confirms a successful control-plane poll, give ChatGPT the target endpoint, exact task JSON/idempotency key and deadline. The peer uses real `ce_inbox_list`, `ce_read_payload`, `ce_ack`, then runs the desktop driver and `ce_send`. Reception ACK says only that Pi received the task. `scriptState`, `ovisState`, `submission`, outbound CE message and ChatGPT receipt remain separate. Unknown outbound send is never retried automatically.
A confirmed Pi messaging shutdown ends that activation. Do not restart the same prepared Session: create a new private runDirectory and prepare a fresh native Pi Session/registration. This preserves CE's explicit activation boundary; never delete `ce-messaging-released` history to force a resume.

ChatGPT must read the result through its existing connection, verify taskId/response and call `ce_ack` with metadata from its actual payload read. Preserve message/receipt audit records. No CE E2E PASS until real ChatGPT receipt and confirmation are recorded. Stop early by creating `runDirectory/stop-request`; otherwise the supervisor stops at deadline. It checks each message/spawn/send boundary and cancels active desktop waits. Private logs may contain provider diagnostics; never upload them or desktop snapshots. Use an exclusive owned0700 `desktopTmpDir` with no pre-existing host for each window. Cleanup stops each owned process group even after its leader exits, then verifies and stops only hosts holding sockets in that private directory with the expected executable/start identity. It reports `CLEANUP_UNCONFIRMED` instead of `CLOSED` if cleanup cannot be established.
A durable `command-in-flight` marker covers CLI dispatch until a complete successful response. If the peer/CLI dies during host startup or an action, the marker remains. Cleanup observes and stops any matching late socket host but reports `CLEANUP_UNCONFIRMED`; absence of a socket cannot prove that a detached startup process is gone. Do not delete the marker or reuse that namespace to retry an uncertain operation.

## Evidence boundaries

Official research pinned source9eb9b296192fcb70bda25e918cd6dd66abfa3d0d. CLI chosen over FFI to avoid ABI/thread/memory ownership integration. Real desktop Dogfood verified Chinese/English/Emoji/newline exact input and response; earlier headless refusal, panel mismatch, Unicode truncation and response extraction failures are retained privately. Regression tests mock only the uncontrollable desktop boundary; journals and task state run real. Real Cloud E2E is separately recorded in the Handoff, never inferred from local tests.
