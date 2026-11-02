# CE Ovis Desktop implementation plan

Goal: a reusable bounded CLI integration between actual Pi CE0.3.0 tools and the explicitly selected Ovis test conversation. No CE core edits, Cloud resources or publication.

Architecture: Python standard-library bridge validates a closed test task and operator config, invokes agent-desktop1.0.2 JSON2.5, and persists a private per-task journal before input/submission. Node adapter binds a real Pi1.3.0 Session with Registry CE0.3.0 and uses wrapped registered ce_inbox_list/read_payload/ack/send tools. CE receipt, script execution and Ovis completion are separate fields. Completed reply must have a task-specific end marker plus explicit idle UI. Stable text alone is UNKNOWN.

Target baseline: Ovis0.4.19 sh.ovis.mac, window w-41015, conversation `ovis-test-workspace 的对话`, named test workspace CE-OVIS-TEST-01. Accessibility granted; headed physical text input explicitly authorized after AXValue proved ineffective. Scope excludes the working Pi conversation.

1. Add failing Python unittest cases for closed test authorization, target guard, processing/completed/failed/unknown classification, unicode/newline readback, crash-before/after-submit dedup, sameID/different-content conflict and no unsafe retry. Inject only desktop subprocess boundary; journal and state machine run real.
2. Implement tools/ce-ovis-desktop/bridge.py + example config, no dependencies. Deadlines and subprocess timeouts; snapshots kept in memory, safe summaries only, private0600 journal in0700directory. Each new observation supplies fresh refs. Persist uncertain stage before mutating action. Never resubmit sameID even after process failure.
3. Actual Ovis dogfood marked CE-OVIS-TEST, Chinese/English/Emoji/newline. Independent snapshots verify draft exact, conversation submission and response end marker+idle. Preserve first failures outside Git.
4. Implement CE adapter with real PiSession, reusable session/config paths and bounded window; inbox payload schema validated; ACK only reception; response contains taskID and distinct states. Await real ChatGPT incoming task/result acknowledgment; do not simulate Cloud.
5. Review changed scripts, run targeted tests and real dogfood; local commit only. E2E requires READY + precise task schema/ID/deadline after Pi side ready. If ChatGPT absent, leave pending at explicit cooperation boundary.

Research: official agent-desktop source 9eb9b296192fcb70bda25e918cd6dd66abfa3d0d README, CLI/macOS Skills and JSON output contract. CLI favored over FFI: no ABI/thread/memory ownership integration for a bounded small workflow. ok=true and delivered_verified prove only documented local postcondition, not business completion. Unknown delivery never retried. Private command host needs stable owned0700TMPDIR and exits after15idle minutes; bounded supervisor must account for owned host cleanup.
