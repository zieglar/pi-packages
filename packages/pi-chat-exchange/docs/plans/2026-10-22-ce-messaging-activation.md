[English](./2026-10-22-ce-messaging-activation.md) | [简体中文](./2026-10-22-ce-messaging-activation.zh-CN.md)

> Historical plan (2026-10-22). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# CE Messaging Explicit Activation Implementation Plan

> Execution: same-session bounded tasks; use characterization/TDD and inspect every result. No commit until all fixed-target review BLOCKERs close.

**Goal:** Finish HANDOFF-CE-TUNNEL-MESSAGING-INTEGRATION-01 without weakening reload, ownership, Store, receipt or history boundaries.

**Architecture:** User approved an explicit current-session activation step on 2026-10-22. Ordinary reload remains resume-only. Explicit activation uses the trusted runtime session id and configured pair, preserves historical mappings, and provisions only through existing `beginSession(endpoint, {requireUnowned:true})`. Existing live authority must be verified/released before a change; unknown release or ownership stops activation. New configuration publication uses immutable binding/allowlist generations selected by the existing profile command pointer, not an additional message route.

**Tech stack:** TypeScript, existing CE Host/Store, Pi 1.3.0 runtime API, existing TUI Kit, Node v24.21.0, Vitest. No SDK/core changes or new generic configuration framework.

## Invariants / approved activation protocol
1. Runtime identity comes only from `ctx.sessionManager.getSessionId()` and is confirmed by operator. Revalidate it and exact config revision before authority changes.
2. Show both endpoints, complete Store filename, Exchange namespace+idempotency key, read/ACK and old/new session binding. Configured, Pi-bound, Connected and actual Gate evidence are separate states.
3. Explicit activation is distinct from ordinary reload. Missing/old-Exchange mapping cannot trigger automatic `beginSession` fallback.
4. If an active generation is known, stop its heartbeat/tools before release, join renewal, and require a known successful release+detach. UNKNOWN/failure/persisted lifecycle block stops; no clearing failure latch or blind retry.
5. Target uses existing `beginSession(..., {requireUnowned:true})` only after policy/runtime/config checks. Never takeover an existing owner, even an expired row.
6. Append only fresh mapping identifiers after successful binding; keep old history. Persistence failure drops capabilities and follows existing failure latch, not automatic reprovision.
7. Matching already-active generation is an idempotent no-op, not a second bind. Another runtime session/config revision is refused.
8. Explicit Tunnel Stop/Start remains separate; successful Pi activation never claims live transport or real C2/C3.
9. Supported Node runtime stays exact; no global Node changes or weakened Store runtime policy.

## Task 1 — Close Store override / terminal / Review honesty defects
Files: pi-extension/index.ts (openHostStore only initially), src/tunnel/manager-panel.ts, src/tunnel/setup-ui.ts; tests test/endpoints/pi/extension-ack.test.ts, test/tunnel/manager-panel.test.ts, test/tunnel/setup-ui-messaging.test.ts.
- RED: mismatched/malformed env Store override with explicit Store -> zero open/initialize/begin; exact equality allowed; absent legacy Store retains existing behavior.
- RED: newline/CR/control chars in displayed messaging endpoints cannot escape panel rows; compare existing sanitization behavior.
- RED: changing existing configured pair's identity/recipient without reauthorization must not display unchanged or submit unnoticed.
- GREEN: explicit Store equality fence, existing sanitizer, visible reauthorization requirement with rejected/disabled conflicting save. No new field syntax restrictions.
- Run narrow tests under approved Node after build when dist imports are involved. Preserve RED evidence. Do not commit.

## Task 2 — Immutable paired configuration publication
Files: src/tunnel/messaging-config.ts, src/tunnel/setup.ts, src/tunnel/managed-binding.ts if needed; tests test/tunnel/messaging-config*.test.ts, setup-messaging.test.ts, messaging-binding.test.ts.
- RED: inject foreign replacement at final publication operation; no overwrite or unlink of target allowed. Creation collision refuses or reuses exact owned immutable bytes.
- Replace mutable fixed sidecar replacement/compensation with immutable pair generations. Sidecar path derives unambiguously from the profile-selected binding generation; both configs share exact Store+Exchange. Session/policy changes produce a different generation.
- Publish completed configs using no-overwrite operations. Retain completed unreferenced generations on refusal; no destructive compensation. Profile's existing guarded atomic rename is the activation commit point. Old profile/pair stays effective on precommit failure.
- Preserve credential exclusion, mode/owner/bounded reads, explicit replacement consent for changed session pair, unrelated allowlist/config preservation, approved runtime, existing profile metadata.
- Loader follows selected binding generation, verifies provenance and complete pair, never falls back to unrelated authority for a malformed selected generation.
- Test exact old profile/config bytes after failure; fsync failures; foreign collisions; retries; both credential alias metadata and opened-fd exclusions; no partial selected pair. No Store/history writes from configuration work.

## Task 3 — Actual activation lifecycle regressions
Files: new test/endpoints/pi/extension-messaging-activation.test.ts; extend actual factory/wizard setup integration tests as necessary.
- RED: actual Setup save -> new factory -> session_start(reload) remains refused if no valid mapping -> explicit activation creates/persists authorized mapping using real isolated CE Host/Store.
- Cover historical old-Exchange mapping preservation and explicit activation, active/expired foreign owner refusal, wrong runtime session, changed config, already-bound no-op, failed/UNKNOWN old release, append failure latch, no automatic reload fallback. No production credentials/configs or messages.
- Tests must prove durable ownership/mapping/receipt semantics using existing host/storage when needed, not only tool registration or mocked return values.

## Task 4 — Add explicit activation entry and policy snapshot lifecycle
Files: pi-extension/index.ts, src/tunnel/setup-ui.ts (existing Advanced surface), src/tunnel/manager-ui.ts/panel projection only as needed.
- Keep source writes sequential with Task 1. Add an explicit Advanced action for the already-configured current session (and optionally matching command entry to invoke same confirmation, not a separate authority path).
- Capture/recheck trusted config and runtime session around operator confirmation. Use existing Host APIs only. Existing `session_start` resume checks remain intact.
- Known old generation release is explicit and checked; target `requireUnowned` refuses ownership collision. Keep failure latch and historical mapping semantics.
- Use current configured policy for registered tools after reload; do not register capabilities in session entries, transcript, or notifications.
- Run Task 3 tests RED->GREEN; ensure ordinary extension-lifecycle suites remain unchanged and green.

## Task 5 — Complete visibility / documentation and all validation
Files: domain/UI messaging projection and docs/tunnel-setup.md, relevant tests.
- Display actual Store directory/file and distinct namespace/idempotency key in Details; show preview/selected values and pending activation/reauthorization honestly in Advanced/Review.
- Update post-save instructions to explicit activation rather than claiming reload automatically binds. Explain safe refusals, supported runtime, separate Tunnel restart and real Gates.
- Build then run targeted tunnel/endpoint lifecycle suites; typecheck; contract; full tests; standalone extension compiler; plugin packaging. Investigate existing 60s packaging timeout; do not simply enlarge limits or conceal failures with retry loops.

## Task 6 — Fixed-target review, local commit, external real Gates
- Freeze complete diff + per-file hashes at base 94de4cbbb861c2d8ba3799f3ed14408ab6245843, index empty. Fresh four lanes with pre/post integrity checks; NO source/test/doc writes while lanes active. Originating lanes reverify all blockers.
- Only after all blockers close and fresh validation passes, make exactly one local commit. Never stage AGENTS.md or .herdr-web-ui/, never push/merge/release.
- Real configuration preflight must distinguish actual deployed pair/runtime/current-session authorization from code tests. Current real config has not migrated; Pi runtime previously observed Node25.2.1 and requires supported launch before host activation.
- Real C2/C3 must return to current ChatGPT tools. Pi must not simulate sender/reader/ACK or access unrelated messages. No ACCEPT/REAL_GATE_PASS before actual bidirectional evidence.
