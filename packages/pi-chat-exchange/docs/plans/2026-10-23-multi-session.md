[English](./2026-10-23-multi-session.md) | [简体中文](./2026-10-23-multi-session.zh-CN.md)

> Historical plan (2026-10-23). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# Multi-session shared Tunnel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** HANDOFF-CE-MULTI-SESSION-01: two real Pi runtime Sessions in different projects use independent Endpoints concurrently through one Tunnel and the shared chatgpt/main inbox.

**Architecture:** Preserve CE Host/Storage/Ownership/capability/fencing and the fixed-sender MCP surface. Separate operator Session registrations from Transport credentials. Publish immutable, verified configuration generations using a single atomic activation pointer and explicit controlled runtime reload. Local process exclusivity is an additional admission restriction, never CE authority or lease takeover.

**Tech Stack:** Existing TypeScript, Node 24.21.0, node:sqlite, Pi 1.3.0, MCP SDK, Vitest and existing TUI/process test harnesses. No dependency or Runtime Guard changes.

## Authority and compatibility constraints

- Trusted Pi runtime getSessionId() selects an operator-authorized registration; neither cwd nor display names confer authority.
- One distinct stable Pi Endpoint per real Session; one shared chatgpt/main peer. No Pi-Pi implicit recipients, wildcard, newest-session fallback, fake Session IDs, shared Owner or automatic expired-Owner takeover.
- Existing single-session setup remains supported. Conversion must be explicit; preserve old endpoint/mapping/Store/Exchange and existing registration, with a clearly reviewed opt-in to adding distinct recipients. Never silently rewrite legacy config.
- Config publication must preserve Store/Exchange/Tunnel identity and other Session entries, exclude credential paths/inodes before reads, and retain uncertain commits for reconciliation. No Store reset/migration and no credential read or rewrite for registration.
- Runtime policy is immutable for grants: a newly added Session/recipient requires explicit reload. Current published config may only narrow/block an already loaded policy, particularly on revocation or identity mismatch. Unknown config/process identity fails closed.
- A duplicate process may not resume the same durable CE Session simultaneously. Existing Storage Owner is Session-scoped and does not distinguish process handles, so an additional verified process mutex is needed; it does not issue capabilities or change Ownership. PID alone or age-only stale reclamation is insufficient. Distinguish safe same-process reload from duplicate handles, PID reuse and unknown state.
- Transport Manager manages transport only. Stop/Start is explicit, never a registration side effect. Real Tunnel/client/message actions require separate authorization.

## Resolved implementation decisions (preimplementation review closure)

1. **Publication requires an explicitly STOPPED Tunnel.** Reuse the existing withProfileConfigurationLock and its stopped-record/external-process checks. Register/revoke commands refuse a running/UNKNOWN Tunnel and instruct an explicit Stop; they never stop/start it. This deliberately does not promise live registration while transport runs, and does not weaken the transport lock. A/B Pi bindings may continue while the transport is stopped. After publication a separate explicit Start loads the new MCP policy.
2. **Single atomic policy pointer remains the Profile command.** Introduce a strictly validated multi-session generation with a closed registration manifest/sidecar, immutable paired bytes and digest verification. A narrowly validated optional launch policy reference may identify the operator-controlled Profile solely for deny-only admission; do not repurpose managed provenance as a grant. Legacy config remains legacy unless an explicit conversion confirmation selects the new mode.
3. **Effective policy is loaded grants intersected with the latest selected grants.** Validate the current generation before begin/resume, every tool/inbox advisory/target-list call and heartbeat. Compare Store/Exchange/Tunnel identity plus the current registration's Endpoint, exact runtime Session ID and registration epoch. Adding B must not invalidate unchanged A. Revoke tombstones retain stable Endpoint identity, while any later reauthorization uses a fresh epoch; old A handles cannot revive. The MCP admission wrapper restricts loaded recipients to current active registrations and never acquires newly published recipients without reload. All reads fail closed on revocation/unknown policy, not only writes.
4. **Revocation linearizes at the atomic pointer snapshot read, conditional on successful verification of that exact immutable generation.** An operation whose pointer snapshot precedes publication may finish even if generation verification finishes afterward; calls taking a snapshot after publication must observe it. No claim of Storage-transaction-atomic revocation, cancellation of overlapping/already admitted operations or retroactive removal of ChatGPT's legitimately received history. Test the exact interleaving: old pointer snapshot -> revoke publishes -> verification of old immutable generation succeeds -> overlapping operation may finish; subsequent snapshot refuses. A second pointer read does not provide stronger serialization. Stronger revocation semantics would require a separate frozen-contract decision and are not implemented.
5. **Process mutex design.** Scope a private lock to canonical Store location plus Pi Endpoint/real runtime Session identity. Use exclusive creation, restrictive ownership/mode and no-follow reads; holder includes process-instance birth identity, a random process token and distinct runtime-handle token. Reject duplicate live handles even in the same PID. Explicit same-process reload transfer is allowed only after old admission is closed and operations/heartbeat drained, not because PIDs match. Never reclaim on age or lease expiry; unknown or partially written locks refuse. Only proven dead/replaced process identity may retire the mutex record; Storage resume/begin still independently refuses expired/foreign/missing authority. Recheck exact lock ownership at every admission and renewal. Retain the marker on uncertain CE cleanup or mutex release.
6. **Per-Pi host projection.** A new-mode Pi Host receives only its current trusted Session Endpoint, not all registrations, plus the exact chatgpt/main recipient. Strictly validate complete manifest/pair equality, unique runtime IDs, unique Endpoints, epochs, opt-ins and identity. Old single-session setup must refuse overwriting converted multi-session configuration.
7. **Target discovery is display-only.** Prefer /ce-tunnel sessions listing of exact authorized active Endpoint IDs, copied to ce_send.to, instead of adding a sender-selecting tool or silently widening MCP schemas. A displayed target is not proof that a running MCP child has loaded it. Show the required controlled restart explicitly.

### Requirement / owner / concrete verification

| Requirement | Implementation owner | Verification |
| --- | --- | --- |
| Legacy identity/authority and current resume gap | characterization task | test/host/multi-session-characterization.test.ts plus existing extension-lifecycle/activation suites |
| A/B/C stable unique registrations, revocation, epochs, partial publication | registration implementation | new test/tunnel multi-session publication/validation tests, temporary files only |
| Fixed sender, loaded/current intersection, cross-read/ACK denial | runtime integration | actual Host/Store and MCP tests; old loaded A/B and shared inbox retained across revoke/regrant |
| Same Session process/handle exclusivity and safe reload | process guard integration | synthetic identity tests and actual two-process workers using process.execPath; PID reuse/unknown/lock loss/uncertainty negatives |
| Session lifecycle and A-independent-of-B | runtime integration | actual extension event handlers plus temporary Store, multi-process integration |
| Frozen contracts/privacy/validation/standards | parent + four fixed-target lanes | exact base/target diff and reproducible commands; no changing review target |

### Commands and stop conditions

Use the approved Node24.21.0 binary on PATH (no global Node change). From packages/pi-chat-exchange: `pnpm run build`; targeted `pnpm exec vitest run <specific test paths>`; then `pnpm run check`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`, and `pnpm run test:plugin-package` if composition/packaging is affected. Record exact paths, counts, exit status and any baseline failures.

Stop the relevant operation on baseline drift, conflicting/unclassified edits, failed or unavailable process-identity proof, stale expected revision, incomplete/unverified generation, publication uncertainty, unknown Store/Owner/lease/fencing or cleanup uncertainty. Do not treat unknown as rollback, busy as authority, or a plan/test result as real Tunnel acceptance. Production implementation stops for any required change to frozen protocol/Storage/Ownership semantics.

## Task 1: Characterize existing boundaries before production edits

Files: test/tunnel/extension-messaging.test.ts; test/endpoints/pi/extension-lifecycle.test.ts; test/host/endpoint-host.test.ts and new focused test files as needed.

1. Add characterization tests for single-session immutable config, trusted runtime lookup, fixed MCP sender, explicit recipients, independent Owner refusal and legacy reload behavior.
2. Run using approved Node and existing package scripts, build before tests that import dist. Record executed commands/results without real daemon access.
3. Add failing feature tests for distinct Session Endpoints and preserving A when registering B. Verify failures represent missing behavior.

## Task 2: Registration model and verified publication

Files: src/tunnel/messaging-config.ts; src/tunnel/setup.ts or a focused new registration module; src/host/mcp-binding-config.ts only if a strictly validated optional policy reference is necessary; corresponding test/tunnel tests.

1. Design the smallest explicit multi-registration generation atop existing configuration-pair publication; use unique Endpoint IDs and exact Session keys, preserve Store/Exchange and chatgpt/main.
2. Add tests for A/B/C registration, replay/resume, revocation A leaving B, stale expected revision, duplicate Endpoint, unknown fields, wrong Store and partial publication/fsync uncertainty.
3. Implement exclusive publication with reviewed CAS/lock boundary; immutable candidates first, atomic active pointer last. Refuse unknown outcomes without blind retries.
4. Keep legacy reads/writes unchanged until explicit conversion. Do not allow the old single-session wizard to overwrite multi-session registrations.

## Task 3: Runtime, precise routing and user operations

Files: pi-extension/index.ts; src/bin/mcp-stdio.ts; src/host/bound-endpoint.ts or focused runtime admission wrapper; focused new process guard module; test/endpoints/pi, test/control/mcp and test/tunnel tests.

1. Expose minimal /ce-tunnel operations: authorized Session list, current Session register with permission/Store/Exchange preview and confirmation, revoke exact registration, explicit runtime load/activation. No model-controlled authority operation.
2. Every Pi runtime gets only its own Endpoint and explicitly authorized chatgpt/main recipient. MCP uses its configured exact Pi recipients; provide equivalent authorized target discovery without accepting a sender parameter.
3. Add deny-only current-policy checks on all relevant runtime paths, including payload reads, ACK and renewal, so revoked/unloaded/mismatched policy cannot retain effective access.
4. Add verified per-Session/process exclusivity before resume/begin, retaining fail-closed latches through reload/uncertain cleanup. Existing capability and ownership operations remain unchanged.
5. Ensure callbacks, pending confirmations, Session changes and reload do not use stale runtime context or a stale registration revision.

## Task 4: Integration verification

Files: new integration tests and fixtures under test/; minimal command help/usage documentation only.

- Exercise actual Store/Host/MCP/extension paths with two isolated OS processes against a temporary synthetic Store: concurrent A/B, directed ChatGPT sends, A/B replies, cross-recipient read/ACK refusals, release/reload/resume isolation, add C, revoke A, duplicate same-Session processes.
- Cover legacy config, partial generations, failed reload, stale policy, unknown Owner, expired lease, stale fencing, Store identity mismatch and reception-only ACK semantics.
- Run targeted tests first; then contract/type/build checks and full relevant package tests. Keep real Tunnel and ChatGPT acceptance explicitly NOT RUN.
- Never create actual user registrations, read actual credential/store payload, or invoke real messaging tools as a substitute for fixtures.

## Task 5: Fixed-target review and delivery

- Freeze the exact tree/commit and record base 69e3e920332316b0ccccdbf3df1235eaf19d94e2, changed paths and validation evidence.
- Four fresh isolated read-only lanes: A diff/privacy/docs; B authority/frozen architecture; C validation/coverage; D standards/maintainability. Same target for all. Any changed target requires fresh relevant review.
- Block on leakage, unintended authorization, Owner races, unknown persistence handled as rollback, or insufficient evidence. Stop and request design review if frozen Storage/protocol/Ownership semantics must change.
- Commit only after all local acceptance checks and required review closure. No push/PR/merge/release. Report local evidence separately from the separately authorized real A/B/Tunnel/ChatGPT run; do not CLOSED the handoff.
