# CE → Ovis test bridge

A bounded macOS CLI integration for Pi Host1.3.0 and the published Pi Chat Exchange0.3.0. It does not modify CE. `bridge.py` operates only the selected Ovis test conversation; `ce-peer.mjs` receives and returns messages through a real Pi Session's registered CE tools. `supervise.py` owns one deadline-limited existing-Tunnel window.

Prerequisites: Ovis0.4.19, agent-desktop1.0.2/JSON2.5, Python3.11+, Node24.21.0, Pi1.3.0 and CE0.3.0 installed into a common node_modules directory. Accessibility permission is required. Physical input needs explicit operator authorization (`headedAuthorized:true`). The integration never silently enables it. Read `agent-desktop skills get desktop`, `skills get platform`, and the official [JSON contract](https://github.com/vercel-labs/agent-desktop/blob/main/docs/json-output.md).

Use the dedicated common-prefix installation described in [the wake runtime guide](../ce-chatgpt-wake/README.md#runtime-installation-and-coexistence): published CE 0.3.0 and Pi 1.3.0, not this checkout's historical core candidate. `modules` is that prefix's `node_modules`. The tools are repository utilities, not files installed by the CE npm package. The recorded Cloud E2E used official Tunnel Client 0.0.19 on macOS arm64; qualify a different Client/version independently. Absolute internal Pi SDK and CE module paths are pinned to the listed versions.

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
