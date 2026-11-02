# CE ChatGPT wake implementation plan

Handoff: HANDOFF-CE-CHATGPT-WAKE-01. Base: 3a0c379038bd3f33cccd7d32c912cd047f25d4ec.

Goal: Pi creates a real CE test message, then a fixed metadata-only desktop notice causes the explicitly selected ChatGPT conversation to read CE tools and reply. Two rounds use one bounded activation. No CE core, production configuration, new Tunnel or connection changes; local commit only.

Design: prefer CLI over FFI. Python wake.py reuses the existing bounded DesktopCli command transport, private journal/fsync/flock and lifecycle helpers. It requires exact app/window/process-generation/title, one named webarea, an operator conversation marker and one exact input/send control. Unknown or submitted message IDs never replay. CE CREATED, notice submission and task reply/ACK are separate records. Static notice contains only fixed instructions and safe test/message/endpoint identifiers; business text remains in CE.

Node peer.mjs reuses real Pi Session/registered CE tools. Existing ce-peer.mjs prepare creates isolated local profile/Store/Session using existing Cloud identity. New bounded supervisor owns peer/Client groups and isolated desktop hosts. Peer sends only preauthorized test tasks, calls wake only after CREATED, waits for actual CE reply with correlation ID and expected answer, reads and ACKs it, then advances round. No send or notice retry after uncertainty.

1. Add failing Python tests: wrongwindow/conversation/draft/busy, CREATED prerequisite, metadata-only notice, successful readback, ambiguous send, unknown submission, same-message repeat and content conflict. Implement and run tests.
2. Add independent CE peer and bounded runner using existing cleanup helpers; unit-test reply correlation and send-before-wake requirement. Node syntax checks, inherited bridge regressions.
3. Verify current ChatGPT target with new snapshots. Use real CE test messages before any notification typing. Keep raw snapshots/logs in private0700 evidence directory; no unrelated app operations.
4. Real two-round test: Pi send→notice→ChatGPT actual CE read/reply→Pi actual read/ACK; independently verify Store messages/receipts and desktop submitted notice count. If runtime cooperation is needed, report READY and deadline; never substitute manual reminders as acceptance.
5. Review fixed delta, remediate concrete findings, verify affected paths, local commit and private evidence archive. ACCEPT only with actual automatic-response evidence and cleanup; otherwise report exact blocker.
