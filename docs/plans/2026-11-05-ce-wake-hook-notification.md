# CE Wake Hook Notification Implementation Plan

> Follow the approved design below in this session, using test-driven development and a final read-only review.

**Goal:** Adapt `wake.py` to receive CE Hook metadata and request a system notification without editing or submitting ChatGPT content, replaying historical notices, enabling production Hooks, or affecting the shared Tunnel.

**Architecture:** Add an explicit `--hook` CLI mode beside the existing file-driven test flow. The Hook path validates bounded JSON and fixed local sender/recipient/Exchange configuration, rejects stale events, journals one notification attempt per Message ID, and passes a fixed metadata-only notice to a bounded native system notification backend. Reuse the existing private journal/file-lock approach and `write_state`; do not call the legacy desktop driver in Hook mode.

**Tech Stack:** Python standard library, unittest, fixed macOS `/usr/bin/osascript` notification request with message supplied as argv data; no shell, agent-desktop invocation, or additional package dependencies.

## Approved design and boundaries

The user selected **system notification banner** over writing an unsent ChatGPT draft. Implementation and isolated tests are authorized. Production Hook publication, real notifications/desktop operations and Tunnel stop/start remain excluded. The CE message `msg_01M6NKPRJEM88WCEPMQ0NS1HSH` was refused with MESSAGE_READ_REJECTED; work uses the user's direct task and explicit notification choice, with no ACK claimed.

Alternatives considered: writing an unsent draft still mutates the ChatGPT conversation; a file-only sink does not fulfill a desktop notification interface. A system banner avoids touching ChatGPT input and has a small, mockable native boundary.

- Only Pi → ChatGPT events are eligible. Local config fixes exact sender, recipient and Exchange; metadata does not confer CE authority.
- Accept exactly the documented eleven Hook event fields and nested Endpoint fields; bounded 16 KiB UTF-8 JSON, duplicate/unknown-field rejection and valid canonical identifier/metadata types. No payload text, commands or capability fields.
- Require fresh event time (120 seconds, with at most 5 seconds future skew). This is conservative notification filtering, not delivery accounting.
- Use a private configured state directory and fixed Message ID journal names. Serialize with a local nonblocking lock. Any existing historical/uncertain attempt prevents another notification; changed metadata for the same ID refuses rather than resubmitting. Never scan or replay previous messages, and never delete old journals to retry.
- Persist attempt before calling the notifier. An unknown outcome remains non-retriable. A successful notifier call means requested, not visible, delivered, ACKed, or completed.
- The native command/script is fixed. Supply the notice as argv data and suppress child output; bound it to five seconds. Tests replace only this external notification boundary and must never invoke it for real.
- Keep the legacy record/task path separate and compatible. Do not modify `bridge.py`, CE core, bindings, or live policy.

## Task 1 — Behavior tests (RED)

Create `tools/ce-chatgpt-wake/test_hook.py`.

Cover: accepted matching current event; reverse/wrong sender, target and Exchange refusal; missing/extra/duplicate fields; invalid IDs/digest/length/time, oversized/invalid UTF-8 input; strict local config; stale/future events; repeated and conflicting Message IDs; historical legacy journal; uncertain notifier failure and persistence-before-effect; private file/lock checks; Hook CLI cannot construct or call the legacy desktop driver; fixed native command treats notice as data. Test the real validator, journal, state machine and CLI with temporary private files. Mock only the OS notification/subprocess boundary.

Run `python3 -B -m unittest discover -s tools/ce-chatgpt-wake -p test_hook.py -v` and record the expected missing-feature failures before implementing.

## Task 2 — Minimal implementation (GREEN)

Modify `tools/ce-chatgpt-wake/wake.py`: add the Hook boundary, notification attempt flow, fixed native backend and mutually exclusive CLI selection. Preserve old `notice`, `run`, and `ChatGptCli` behavior for explicit legacy test invocations. Keep all Hook validation before any desktop/notifier construction or attempt journal creation. Reuse validated values inward without repeated shape validation.

Run the new tests, then the existing `test_wake.py` 13-test baseline. Resolve observable failures without expanding the feature.

## Task 3 — Documentation and focused regression

Modify `tools/ce-chatgpt-wake/README.md` to document notification-only Hook mode, closed config, static local rule with `enabled:false`, freshness/deduplication limits, journal preservation, OS visibility limits, and the absence of CE payload/ACK authority. Make clear that actual system notifications were not exercised and production is unchanged.

Inspect and run relevant existing isolated Python and Node wake tests only. Do not run supervisors, live desktop tests, or actual Hook commands. Check syntax, whitespace and source scope.

## Task 4 — Review and delivery

Freeze the local delta on `feat/ce-wake-hook-notification`; request a read-only security/behavior review with no production access or real notifier execution. Fix concrete findings and rerun affected tests. Verify original `bridge.py`, Profile, settings, Hook policy and shared runId/PID remain unchanged. Deliver paths, exact validation counts, review limits and the disabled example. No merge, push, installation or production Hook enablement.
