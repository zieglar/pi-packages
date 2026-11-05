# CE to Ovis Authorized Task Intake Implementation Plan

> Execute the approved design in this session with TDD and a final read-only review. No production activation or desktop operations.

**Goal:** Reuse the existing bridge to accept a currently authorized CE task, preserve CE visibility and local desktop authority, prevent replay, and distinguish submission, Agent activity, self-reported completion and verified business completion.

**Architecture:** Add an opt-in real-task mode to `bridge.py`, preserving the original six-field test task and echo behavior. Add a small explicit-Message-ID intake module that receives the current Session's registered CE tool caller, applies fixed local routing and task authorization, and reuses existing `tasks.mjs` / `execution.mjs` to invoke the same bridge. Do not create a new CE Host, Session, background poller, credentials path or Hook.

**Tech Stack:** Python standard library, Node standard library, existing CE registered tools, unittest/node:test. Tests replace CE and desktop boundaries; real temporary files and journals run normally.

## Approved scope and visibility diagnosis

The user explicitly chose the real-task-mode design after being informed that the original bridge only echoes test text. Production activation, Ovis operations, shared Tunnel restart and changes to the working wake Hook are excluded. Installation copies used by the live wake Hook remain unchanged even if repository bridge.py gains a new mode.

`ce_read_payload(msg_01M6P68QE99S5PMHFXJHRTSANM)` returned `CE_HOST_UNAVAILABLE (MESSAGE_READ_REJECTED)`. `ce_inbox_list(afterAuditSequence=101, pageSize=10, rawScanLimit=30)` returned zero eligible messages through audit 102. These do not reveal the rejected message's actual recipient or existence.

Source evidence: storage/messaging.ts runMessageRead authorizes current owner and scope, requires membership, then opaquely rejects missing Message, wrong stable recipient, or a creation audit at/before the membership join boundary. Host readPayload separately refuses disabled payload policy/capability with CE_HOST_PAYLOAD_DISABLED. Thus this observed reason is a visibility/correlation refusal, not evidence that the payload opt-in must be widened. Do not fetch the rejected message through SQL, raw files, another Session or a direct Host.

Correct routing to verify with the sender: adapter pi, endpointId pi/session-79558ef5d11cdecbb248cbe4d32f68f2; current runtime 01a1aa1f-df2f-70c2-8bf9-97d7da6bc0d2, Exchange ho_01M5J6YA0EPHAF84QYMKKT7P0B. Sender-side ce_send metadata is needed to prove the actual route of audit 102. Do not claim its cause more precisely without that evidence. No ACK without an actual authorized payload read.

## Design constraints

- Preserve default legacy `testOnly:true`, `CE-OVIS-TEST-*`, exact allowedTaskId/text digest and target checks.
- Real tasks use `testOnly:false`, `CE-OVIS-TASK-*` with the same closed six-field task shape. Require explicit local `taskMode:"execute"`, exact task ID, exact target and SHA-256 of text; do not derive authorization, paths, executables or target selection from CE body.
- Real mode prompt presents the task to the selected Agent, not the old echo/no-tools instruction. The end marker denotes only an Agent completion report. Never label that a verified business outcome.
- Reuse snapshots, configured app/window/process identity, empty-draft/busy guards, existing journal/lock/checkpoints, one send click, deadlines, and no-replay states. Never change installed wake.py, its config, its private bridge/lifecycle copies or live policy.
- Intake receives a trusted callback for registered CE tools already bound to the invoking current Session, plus a local current-Session-ID getter. Check that Session is still the configured Session across asynchronous boundaries. Never instantiate or resume a second Session to gain access.
- Intake is explicit one-message processing, default disabled, fixed sender/recipient/Exchange and local activation/freshness boundary. Use authorized ce_read metadata before payload, then actual ce_read_payload. A read refusal stops with no ACK or desktop action. Unknown refusal reasons stay opaque.
- Validate returned identifiers, route, digest, UTF-8 length, audit sequence and time; bind payload read metadata to the authorized metadata read. Exclude paths, executables, CE grants and arbitrary authority fields from payload task schema. Reuse exact local task file/payload digest authorization.
- Prepare a private Message-ID attempt record durably before the bridge boundary. Matching repeats return saved state; conflicts, corrupt/unsafe state, uncertain attempts and historical bridge journals never resubmit. Preserve task-ID no-replay across different CE Message IDs through the existing bridge journal or local task-attempt binding.
- No implicit ACK/result CE send is necessary for this intake step. Reading is not execution permission or completion evidence; keep any future reception ACK explicit and separate.
- Keep statuses separate: desktop submission observed/unknown; Agent processing observed; Agent completion reported/unknown; business completion UNVERIFIED. Real task marker plus idle UI is not business verification. Preserve positive processing evidence if the final observation is idle.
- Production entry points remain unwired/disabled. The current-tool-caller adapter must be callable from a same-Session controller in a future authorized activation; document that the old ce-peer prepare/run is an isolated test supervisor and must not be used to take over the live Session or shared Tunnel.

## Task 1 — Baseline and RED

Baseline at f7871932850b4e61f9bde342515f9ef2ed4d1895: `test_bridge.py` 22 tests and `tasks.test.mjs` 2 tests pass. Existing unrelated untracked files remain untouched.

Files: extend `tools/ce-ovis-desktop/test_bridge.py`; create `tools/ce-ovis-desktop/intake.test.mjs` (a new Python test file is also acceptable if it keeps the bridge cases focused).

Write tests before implementation for:

1. Default refusal of real tasks; opt-in uses real instructions and exact text/target binding; legacy echo tests stay unchanged.
2. Submission is distinct from processing; preserve processing observation; report completion does not assert verified business success.
3. Current Session CE metadata/payload tool calls only; refusals, wrong route/Exchange, switched Session, malformed/mismatched metadata or payload, stale/pre-activation tasks stop before bridge.
4. Local task file/digest authorization; body cannot supply paths/commands or widen execution.
5. Private attempt persistence before effect, same-message replay, task-ID conflicts/different-message replay, uncertain bridge outcomes, historical bridge attempts, unsafe/corrupt state.
6. Real bridge behavior with fake desktop snapshots; intake uses real filesystem/journal and controlled CE/desktop seams. No Ovis, osascript, real CE send, production Host, supervisor or Cloud operations.

Run targeted tests; retain expected missing-feature/behavior RED evidence.

## Task 2 — Minimal GREEN implementation

Modify only what is needed in:

- `tools/ce-ovis-desktop/bridge.py`: gated task mode, task prompt/validation, truthful real-task status evidence. Reuse the existing run loop.
- `tools/ce-ovis-desktop/tasks.mjs`: bounded local task authorization extension if required for CE-OVIS-TASK IDs; preserve legacy defaults and existing tests.
- New `tools/ce-ovis-desktop/intake.mjs`: current-tool-caller intake, route/time/data validation, private replay journal and bridge dispatch using existing execution helper. Keep callbacks narrow and trusted, no new transport or CE authority.
- `execution.mjs` only if necessary for an explicitly justified seam; avoid refactoring it or the supervisor for unrelated cleanup.

Run affected tests to GREEN, then existing bridge/task/execution/peer unit regressions as appropriate. Do not run supervisors or real desktop/network cases.

## Task 3 — Documentation and permission regression

Update `tools/ce-ovis-desktop/README.md` with disabled/default behavior, exact task schema, local authorization, current-Session CE caller contract, replay/freshness limits, private payload files, and status semantics. Include a visibility diagnosis and sender-side routing remedy without claiming unauthorized access was repaired. Document that verified business completion requires task-specific external evidence.

Run relevant existing protected-read/recipient regression tests in isolated temporary Stores if their canonical commands can be scoped safely; no production SQLite/message inspection. Record any runtime blocker precisely.

## Task 4 — Review and delivery

Freeze the delta and request a read-only security/behavior review. Reviewer uses security-reviewer, magpie/group/expert, thinking high, with no production access, no real desktop commands and no further delegation. Parent fixes concrete findings and verifies affected tests.

Check source scope, syntax/diagnostics/whitespace, main baseline, installed wake/config/bridge/lifecycle hashes, unchanged live policy and shared Tunnel PID/runId. Retain permission/read-refusal limitations as unresolved real-message acceptance, independently of passing implementation tests. No production enable, Push, Merge or Release in this implementation task.

## Execution evidence — 2026-11-05

At initial implementation delivery, changes were on `feat/ce-ovis-task-intake`, based on `f7871932850b4e61f9bde342515f9ef2ed4d1895`; HEAD and main were unchanged. That phase performed no commit, push, production installation or activation. Subsequent authorized acceptance attempts are recorded below.

- Initial RED: real-mode tests failed on the echo prompt / test-only schema; intake test could not import the not-yet-created module.
- GREEN: `python3 -B -m unittest discover -s tools/ce-ovis-desktop -p test_bridge.py` — 22 passed; corresponding `test_task_mode.py` — 4 passed.
- GREEN: Node 24.21.0 `--test` on `intake.test.mjs`, `tasks.test.mjs`, `execution.test.mjs`, `peer.test.mjs` — 52 passed. Includes real subprocess execution of the same bridge with a fake desktop, persistent replay refusal, and no CE ACK/send.
- Protected-read regressions: package-local Vitest on `test/storage/message-payload-read.test.ts`, `test/storage/message-send-read.test.ts`, `test/host/multi-session-characterization.test.ts`, `test/endpoints/pi/session-host-payload.test.ts`, with `CE_DEFAULT_CLIENT_GUARD=1` — 4 files / 67 tests passed using temporary Stores.
- First read-only security review found one medium issue: new intake directory entry lacked parent-directory fsync before dispatch. Added unconditional parent sync; failure propagates before effect. Four tests (sync ordering and sync failure, new/existing directory) all failed before the fix and passed after. Actual power-loss recovery was not tested.
- Follow-up read-only security review: PASS; parent-directory sync remediation accepted with no new blocker. Reviewer independently ran the four parent-sync tests: 4 passed, exit 0. Both reviews used isolated contexts via the configured expert route; model family was opaque, so no cross-family independence claim is made.
- New Python test fixture's type error was corrected; active LSP confirmed that file clean. JS error probe returned zero diagnostics but its silent-on-clean server could not confirm clean; `node --check` passed for changed JS files. Python syntax and whitespace checks passed.
- Read-only production comparison: installed wake/config/bridge/lifecycle, selected Profile and messaging binding match their baseline SHA-256 values. Latest live policy remains `000020.json`, SHA-256 `84bc1dc9da51efddf13f5988c79480d8c666fef32234f3d0063ba14cba7e9e70`, with one Pi Hook and no MCP Hooks. Shared Tunnel remains PID 96776, runId `bg-dd6734a9-1d94-4ec3-b70d-73e570adfbae`.

Real authorized-message acceptance, Ovis behavior and business-task completion remain unverified. The earlier opaque read refusal was not bypassed or claimed fixed. Intake remains unwired and disabled in production.

## Authorized acceptance attempt — CE audit 103

The user subsequently authorized a local implementation commit, a fresh authorized CE read, one controlled Ovis task submission after authorization/target confirmation, Agent-start evidence and production-state checks. No unattended activation, replay of an uncertain task, shared Tunnel restart, push, merge or release is authorized.

- Provided Message ID: `msg_01M6PBFNFRC233WXFZKMPZXM7B`, sender-reported audit 103 / CREATED.
- Actual current-Session `ce_read` returned `CE_HOST_UNAVAILABLE (MESSAGE_READ_REJECTED)`; no metadata or body was exposed.
- Actual `ce_inbox_list(afterAuditSequence=102,pageSize=10,rawScanLimit=30)` returned zero eligible IDs, continuation 103, `scanBudgetExhausted:false`. This does not identify the immutable recipient or prove why that message was excluded.
- No payload read bypass, reception ACK or desktop dispatch was attempted. A fresh authorized body and confirmed Ovis target remain prerequisites for the controlled desktop acceptance.
- Before the authorized commit, Python bridge/mode tests were rerun: 26 passed. Node intake/tasks/execution/peer tests were rerun: 52 passed, including replay persistence and directory-sync ordering/failure coverage.
- Read-only production comparison at `2026-11-05T17:22:13Z`: installed wake/config/bridge/lifecycle, Profile, messaging binding and policy 000020 hashes still match baseline. One Pi Hook, zero MCP Hooks. Shared Tunnel remains live at PID 96776 / runId `bg-dd6734a9-1d94-4ec3-b70d-73e570adfbae`.
- Current published Pi registration remains active at endpoint `pi/session-79558ef5d11cdecbb248cbe4d32f68f2` for runtime Session `01a1aa1f-df2f-70c2-8bf9-97d7da6bc0d2`. This does not reveal audit 103's actual recipient.

The sender must compare its actual `ce_send` recipient/Exchange metadata with the current published Pi registration. Existing opaque refusals do not authorize changing CE permissions, impersonating another recipient or replaying historical messages.

## Authorized acceptance attempt — CE audit 105

- Current Session successfully called `ce_read` and then `ce_read_payload` for `msg_01M6PBZB3RCVY5A3XNGJ9MRBKV` (audit 105). Actual sender was `chatgpt/main`; actual recipient was the published Pi endpoint above. No reception ACK or result send occurred.
- Saved authorized payload was verified against actual read metadata: 692 bytes, SHA-256 `614dd68281c29d1db0286eabf2bbab994d8a278a5ee7b7ac7df4ccf67274d966`. It asks only for `CE-OVIS-SMOKE-01 OK`. Protected reads are scoped to the current registration; selected binding and live-policy hashes remained unchanged. The rendered tool text does not expose a separate exchangeId field.
- Payload is plain-text instructions rather than the closed JSON task schema. A user-authorized, manually reviewed local conversion and existing bridge were planned for this controlled test; the automated intake API was not exercised or enabled.
- Desktop host startup failed under the long private TMPDIR; a separate owned short TMPDIR started it successfully. Permissions probes were inconsistent (denied versus native guide granted), while complete Ovis AX snapshots and a semantic local workspace-list expansion succeeded. No physical task input was attempted.
- Visible Agents were the running `pi-packages-dev` coordinator and `aliyun-ecs`. The user chose to prepare an isolated test Agent; subsequent snapshots showed the coordinator's terminal and then its running chat. A dedicated isolated test target remains unconfirmed.
- Desktop task submission: NOT_ATTEMPTED; task text input count 0; send click count 0; Agent response to this smoke task unverified; task completion UNVERIFIED. Do not submit into the coordinating Session or the unrelated Agent to complete this test.
- Profile, selected binding, live policy 000020, installed wake/bridge/lifecycle hashes and shared Tunnel PID/runId matched baseline at the final comparison. The installed Hook config was not reread after ctx_execute_file rejected its outside-workspace access; no alternate read of that denied file was attempted. No production configuration was written.

Acceptance remains BLOCKED on identification of the isolated Ovis test Agent. The authorized payload and structured partial evidence are preserved in the private per-message acceptance directory outside Git. No resend of audits 103 or 104 is needed.

### Controlled submission attempts against the Ovis desktop

- Target selection used the workspace list and `cmd+shift+j` (verified to toggle Terminal/Chat). The parent incorrectly treated `pi-magpie-test` 对话 as Agent chat; its workspace label actually said Shell. A bare newline executed one prompt-tag line in zsh, which reported `command not found`. No Agent response was observed and no send button was clicked; other side effects were not independently verified.
- First attempt `CE-OVIS-TASK-acceptance-105` stopped at `CHUNK_READBACK_MISMATCH` with `submission=NOT_ATTEMPTED`: only a prefix was observed after a newline-containing input call, so strict readback stopped before a send click. The underlying native-driver cause was not established.
- Draft-mutating probes produced complete `ABC` / `测试中文` but only a newline for `\nXYZ` / `\nABC`. These were physical input probes, not read-only observations; Shell Enter behavior is an alternative explanation, so they do not establish a native driver defect.
- The initial input fix in commit `9a5dce0f` passed its then-existing tests but was rejected in security review: the click branch was misplaced, stable-prefix automatic retyping could duplicate delayed input, and deadline checks were incomplete. That implementation is superseded by the remediation below.
- Both attempt journals remain as `STOPPED_NO_REPLAY` with `submission=NOT_ATTEMPTED`. No Agent task was submitted, no Agent response was observed and business completion stays `UNVERIFIED`. The only idle pi Agent pane in Ovis is `aliyun-ecs`; the coordinator pane is this running session and must never be bridged into itself.

### Safety remediation before the newly authorized Agent test

The user explicitly selected the idle `aliyun-ecs` pi Agent after being informed of the Shell-pane mistake. No further desktop input is allowed until the remediation review passes.

- Restored `DesktopCli.action('click')` dispatch and added a real-method test proving exactly one delegated click.
- Removed automatic retyping. Delayed prefixes are only observed within a bounded wait; an incomplete/different draft or expired wait stops without another input attempt.
- Check task wall-clock and monotonic execution deadlines for every command and before/after settling observations. A late exact readback after the local wait deadline is refused.
- Real tasks require an exact local `pi: <target> ` Agent-button prefix and live unique selection before any task input. Shell-only matching conversation/field labels are insufficient.
- Never type literal newlines: focus the latest input ref and send Shift+Return to the configured Ovis window; require exact cumulative readback after each piece.
- RED tests exposed the old misplaced click, unsafe retyping, deadline gaps and bare Return path. Current focused regressions pass: Python 29 legacy/driver + 6 real-mode tests; Node 52 tests. Follow-up bounded security review PASS: all three prior findings corrected, new Agent/Shell selection and Shift+Return behavior accepted for controlled validation. Physical input can still arrive after timeout; stopping never implies rollback.
